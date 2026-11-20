//! The generated endpoints, driven through the router the way a client drives them, and the generated document, against the one
//! `@typespec/openapi3` writes from the same contract.
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use pets_example::api::petstore::{
    self, CreatePet, DeletePet, GetPet, ListPets, Operation, PetEvents, create_pet,
};
use pets_example::store::Shop;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use tower::ServiceExt;

fn app() -> Router {
    petstore::mount(Router::new(), &Shop::default())
}

async fn send(
    app: &Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, axum::http::HeaderMap, String) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
        .expect("a request");
    let response = app.clone().oneshot(request).await.expect("a response");
    let (parts, body) = response.into_parts();
    (
        parts.status,
        parts.headers,
        String::from_utf8(to_bytes(body, usize::MAX).await.expect("a body").to_vec())
            .expect("text"),
    )
}

fn json_of(text: &str) -> Value {
    serde_json::from_str(text).expect("JSON")
}

async fn adopt(app: &Router, name: &str, species: &str, tags: &[&str]) -> Value {
    let (status, _, body) = send(
        app,
        Method::POST,
        "/pets",
        Some(json!({"name": name, "species": species, "tags": tags})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    json_of(&body)
}

#[tokio::test]
async fn created_pet_is_read_back_and_removed() {
    let app = app();
    let (status, headers, body) = send(
        &app,
        Method::POST,
        "/pets",
        Some(json!({"name": "Rex", "species": "dog"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(headers["location"], "/pets/p1");
    assert_eq!(
        json_of(&body),
        json!({"id": "p1", "name": "Rex", "species": "dog", "tags": []})
    );

    let (status, _, body) = send(&app, Method::GET, "/pets/p1", None).await;
    assert_eq!(
        (status, json_of(&body)["name"].clone()),
        (StatusCode::OK, json!("Rex"))
    );

    let (status, _, body) = send(&app, Method::DELETE, "/pets/p1", None).await;
    assert_eq!((status, body.as_str()), (StatusCode::NO_CONTENT, ""));
    let (status, _, body) = send(&app, Method::GET, "/pets/p1", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        json_of(&body),
        json!({"code": "not_found", "message": "no pet \"p1\""})
    );
}

#[tokio::test]
async fn query_parameters_filter_the_list() {
    let app = app();
    adopt(&app, "Rex", "dog", &["good", "big"]).await;
    adopt(&app, "Tom", "cat", &["good"]).await;
    adopt(&app, "Fido", "dog", &["small"]).await;

    let names = |body: &str| {
        json_of(body)["pets"]
            .as_array()
            .expect("pets")
            .iter()
            .map(|pet| pet["name"].as_str().expect("name").to_owned())
            .collect::<Vec<_>>()
    };
    let (_, _, body) = send(&app, Method::GET, "/pets?species=dog", None).await;
    assert_eq!(names(&body), ["Rex", "Fido"]);
    // A repeated parameter collects every occurrence.
    let (_, _, body) = send(&app, Method::GET, "/pets?tag=good&tag=big", None).await;
    assert_eq!(names(&body), ["Rex"]);
    let (_, _, body) = send(&app, Method::GET, "/pets?limit=1", None).await;
    assert_eq!(names(&body), ["Rex"]);
    // Values are percent-decoded; a parameter the contract does not list is only counted.
    let (status, _, body) = send(&app, Method::GET, "/pets?tag=%67ood&unlisted=1", None).await;
    assert_eq!(
        (status, names(&body)),
        (StatusCode::OK, vec!["Rex".to_owned(), "Tom".to_owned()])
    );
}

#[tokio::test]
async fn path_parameter_is_percent_decoded() {
    let (status, _, body) = send(&app(), Method::GET, "/pets/a%20b", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json_of(&body)["message"], "no pet \"a b\"");
}

#[tokio::test]
async fn body_that_does_not_decode_is_refused_with_the_status_the_contract_lists() {
    let app = app();
    for body in [
        json!({"name": "Rex"}),
        json!({"name": "Rex", "species": "fish"}),
        json!([]),
    ] {
        let (status, _, _) = send(&app, Method::POST, "/pets", Some(body)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }
    let request = Request::post("/pets")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{\"nope\":"))
        .expect("a request");
    assert_eq!(
        app.oneshot(request).await.expect("a response").status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[tokio::test]
async fn query_over_the_bounds_is_refused_before_it_is_parsed() {
    let app = app();
    let long = format!("/pets?species={}", "x".repeat(5000));
    assert_eq!(
        send(&app, Method::GET, &long, None).await.0,
        StatusCode::BAD_REQUEST
    );
    let many = format!("/pets?{}", vec!["a=1"; 65].join("&"));
    assert_eq!(
        send(&app, Method::GET, &many, None).await.0,
        StatusCode::BAD_REQUEST
    );
    let within = format!("/pets?{}", vec!["a=1"; 64].join("&"));
    assert_eq!(
        send(&app, Method::GET, &within, None).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn events_are_server_sent() {
    let app = app();
    adopt(&app, "Rex", "dog", &[]).await;
    let (status, headers, body) = send(&app, Method::GET, "/pets/p1/events", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "text/event-stream");
    assert!(
        body.contains("event: changed\ndata: {\"id\":\"p1\""),
        "{body}"
    );
    assert!(
        body.contains("event: gone\ndata: end of the example feed"),
        "{body}"
    );
}

/// A node that serves everything but removal.
struct Keeper(Shop);

impl ListPets for Keeper {
    fn list_pets_handler(&self) -> Option<petstore::list_pets::Call> {
        self.0.list_pets_handler()
    }
}
impl CreatePet for Keeper {
    fn create_pet_handler(&self) -> Option<create_pet::Call> {
        self.0.create_pet_handler()
    }
}
impl GetPet for Keeper {
    fn get_pet_handler(&self) -> Option<petstore::get_pet::Call> {
        self.0.get_pet_handler()
    }
}
impl DeletePet for Keeper {
    fn delete_pet_handler(&self) -> Option<petstore::delete_pet::Call> {
        None
    }
}
impl PetEvents for Keeper {
    fn pet_events_handler(&self) -> Option<petstore::pet_events::Call> {
        self.0.pet_events_handler()
    }
}

#[tokio::test]
async fn operation_a_node_cannot_serve_is_not_mounted() {
    let app = petstore::mount(Router::new(), &Keeper(Shop::default()));
    assert_eq!(
        send(&app, Method::DELETE, "/pets/p1", None).await.0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        send(&app, Method::GET, "/pets/p1", None).await.0,
        StatusCode::NOT_FOUND
    );
}

#[test]
fn operation_carries_what_the_contract_states_of_it() {
    let delete = Operation::DELETE_PET;
    let route = delete.as_ref();
    assert_eq!((&route.method, route.path), (&Method::DELETE, "/pets/{id}"));
    assert_eq!(route.extensions.len(), 1);
    assert_eq!(
        (route.extensions[0].name, route.extensions[0].json),
        ("x-scope", "\"admin\"")
    );
    assert!(Operation::GET_PET.as_ref().extensions.is_empty());
    assert_eq!(Operation::ALL.len(), 5);
}

#[test]
fn model_that_extends_another_has_its_fields() {
    let dog: pets_example::types::Dog = serde_json::from_value(
        json!({"id": "p1", "name": "Rex", "species": "dog", "tags": [], "loud": true}),
    )
    .expect("a dog");
    assert_eq!((dog.name.as_str(), dog.loud), ("Rex", true));
}

#[test]
fn contract_facts_are_constants() {
    use pets_example::types::{NewPet, Pet, PetId};
    assert_eq!((PetId::MIN_LENGTH, PetId::MAX_LENGTH), (1, 64));
    assert_eq!(NewPet::NAME_MIN_LENGTH, 1);
    assert_eq!(
        (
            petstore::list_pets::LIMIT_MINIMUM,
            petstore::list_pets::LIMIT_MAXIMUM
        ),
        (1, 100)
    );
    assert_eq!(petstore::list_pets::SUMMARY, "List pets.");
    assert_eq!(
        petstore::list_pets::SPECIES_DESCRIPTION,
        "Only this species."
    );
    assert_eq!(Pet::AGE_DESCRIPTION, "Absent while nobody knows.");
    // An example is JSON text of the type it is an example of.
    let pet: Pet = serde_json::from_str(Pet::EXAMPLE).expect("the example is a pet");
    assert_eq!(pet.name, "Rex");
}

#[tokio::test]
async fn limit_outside_the_contracts_bounds_is_refused() {
    let app = app();
    for limit in ["0", "101", "x"] {
        assert_eq!(
            send(&app, Method::GET, &format!("/pets?limit={limit}"), None)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        send(&app, Method::GET, "/pets?limit=100", None).await.0,
        StatusCode::OK
    );
}

fn facts(document: &Value) -> BTreeSet<String> {
    let mut facts = BTreeSet::new();
    for (path, item) in document["paths"].as_object().expect("paths") {
        for (method, operation) in item.as_object().expect("a path item") {
            let at = format!("{} {path}", method.to_uppercase());
            facts.insert(format!("{at} id {}", operation["operationId"]));
            facts.insert(format!("{at} summary {}", operation["summary"]));
            for parameter in operation["parameters"].as_array().into_iter().flatten() {
                facts.insert(format!(
                    "{at} {} {} required={}",
                    parameter["in"],
                    parameter["name"],
                    parameter["required"].as_bool().unwrap_or(false)
                ));
            }
            for (status, response) in operation["responses"].as_object().expect("responses") {
                let media: BTreeSet<&String> = response["content"]
                    .as_object()
                    .into_iter()
                    .flat_map(|content| content.keys())
                    .collect();
                facts.insert(format!("{at} {status} {media:?}"));
            }
            for (name, value) in operation.as_object().expect("an operation") {
                if name.starts_with("x-") {
                    facts.insert(format!("{at} {name} {value}"));
                }
            }
        }
    }
    facts.extend(
        document["components"]["schemas"]
            .as_object()
            .expect("schemas")
            .keys()
            .map(|name| format!("schema {name}")),
    );
    facts
}

#[test]
fn document_states_what_the_openapi_emitter_states() {
    let theirs: Value = serde_json::from_str(include_str!("../generated/openapi/openapi.json"))
        .expect("their document");
    let ours = petstore::document();
    assert_eq!(ours["openapi"], theirs["openapi"]);
    assert_eq!(ours["info"], theirs["info"]);
    let (ours, theirs) = (facts(&ours), facts(&theirs));
    assert_eq!(
        ours.difference(&theirs).collect::<Vec<_>>(),
        Vec::<&String>::new(),
        "only in the generated document"
    );
    assert_eq!(
        theirs.difference(&ours).collect::<Vec<_>>(),
        Vec::<&String>::new(),
        "only in the openapi3 document"
    );
}
