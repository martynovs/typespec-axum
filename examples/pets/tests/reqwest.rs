//! The generated client over `reqwest`, against the generated server on a real socket: the same bytes a deployment would carry,
//! the event stream included.
use axum::Router;
use pets_example::api::petstore as server;
use pets_example::client::Reqwest;
use pets_example::client::petstore::{Client, PetEvent, create_pet, get_pet, pet_events};
use pets_example::store::Shop;
use serde_json::json;
use tokio_stream::StreamExt;

async fn serve() -> Client<Reqwest> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port");
    let address = listener.local_addr().expect("an address");
    let app = server::mount(Router::new(), &Shop::default());
    tokio::spawn(async move { axum::serve(listener, app).await });
    Client::new(Reqwest::default(), format!("http://{address}"))
}

#[tokio::test]
async fn pet_is_created_and_followed_over_http() {
    let client = serve().await;
    let new_pet =
        serde_json::from_value(json!({"name": "Rex", "species": "dog"})).expect("a new pet");
    let created = client
        .create_pet(create_pet::Request { body: new_pet })
        .await
        .expect("created");
    assert_eq!(created.body.name, "Rex");
    let id = created.body.id.to_string();
    let pet = client
        .get_pet(get_pet::Request {
            id: id.clone(),
            x_request_id: None,
        })
        .await
        .expect("the pet");
    assert_eq!(pet, created.body);
    let mut events = client
        .pet_events(pet_events::Request { id })
        .await
        .expect("a stream");
    assert!(matches!(
        events.next().await,
        Some(Ok(PetEvent::Changed(_)))
    ));
    assert!(matches!(events.next().await, Some(Ok(PetEvent::Gone(_)))));
    assert!(events.next().await.is_none());
    match client
        .get_pet(get_pet::Request {
            id: "nobody".to_owned(),
            x_request_id: None,
        })
        .await
    {
        Err(pets_example::client::Error::Refused(get_pet::Refusal::Status404(_))) => {}
        other => panic!("{other:?}"),
    }
}
