//! The generated client, driven against the generated server in process: every request is built by the client, served by the router,
//! and read back by the client.
use axum::Router;
use axum::body::Body;
use bytes::Bytes;
use pets_example::api::petstore as server;
use pets_example::client::petstore::{
    Client, PetEvent, create_pet, delete_pet, get_pet, list_pets, pet_events, touch_pet, whoami,
};
use pets_example::client::{ByteStream, Error, StreamError, Transport, TransportError};
use pets_example::store::Shop;
use pets_example::types::{NewPet, Note};
use serde_json::json;
use std::future::Future;
use tokio_stream::StreamExt;
use tower::ServiceExt;

/// A transport that calls a router in process.
struct InProcess(Router);

impl Transport for InProcess {
    fn send(
        &self,
        request: http::Request<Bytes>,
    ) -> impl Future<Output = Result<http::Response<ByteStream>, TransportError>> + Send {
        let app = self.0.clone();
        async move {
            let (parts, body) = request.into_parts();
            let response = app
                .oneshot(http::Request::from_parts(parts, Body::from(body)))
                .await
                .map_err(TransportError::new)?;
            let (parts, body) = response.into_parts();
            let stream: ByteStream = Box::pin(
                body.into_data_stream()
                    .map(|chunk| chunk.map_err(TransportError::new)),
            );
            Ok(http::Response::from_parts(parts, stream))
        }
    }
}

fn client() -> Client<InProcess> {
    Client::new(
        InProcess(server::mount(Router::new(), &Shop::default())),
        "http://pets.example",
    )
}

fn new_pet(name: &str, species: &str, tags: &[&str]) -> NewPet {
    serde_json::from_value(json!({"name": name, "species": species, "tags": tags}))
        .expect("a new pet")
}

async fn adopt(
    client: &Client<InProcess>,
    name: &str,
    species: &str,
    tags: &[&str],
) -> create_pet::Answer {
    client
        .create_pet(create_pet::Request {
            body: new_pet(name, species, tags),
        })
        .await
        .expect("an answer")
}

#[tokio::test]
async fn pet_is_created_read_and_removed() {
    let client = client();
    // The answer carries its body and its headers.
    let created = adopt(&client, "Rex", "dog", &["good"]).await;
    assert_eq!(created.body.name, "Rex");
    assert!(
        created.location.ends_with(&created.body.id.to_string()),
        "{}",
        created.location
    );
    let id = created.body.id.to_string();
    // A path parameter and a header.
    let pet = client
        .get_pet(get_pet::Request {
            id: id.clone(),
            x_request_id: Some("r-1".to_owned()),
        })
        .await
        .expect("the pet");
    assert_eq!(pet, created.body);
    // A 204 with no body.
    client
        .delete_pet(delete_pet::Request { id: id.clone() })
        .await
        .expect("removed");
    // A status the contract lists as a refusal, with its typed body.
    match client
        .get_pet(get_pet::Request {
            id,
            x_request_id: None,
        })
        .await
    {
        Err(Error::Refused(get_pet::Refusal::Status404(failure))) => {
            assert_eq!(failure.code, "not_found")
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn query_parameters_are_sent_the_way_the_server_reads_them() {
    let client = client();
    adopt(&client, "Rex", "dog", &["good", "loud"]).await;
    adopt(&client, "Tom", "cat", &["good"]).await;
    let ask = |species: Option<&str>, tag: &[&str], limit: Option<&str>| {
        let client = &client;
        let request = list_pets::Request {
            species: species.map(str::to_owned),
            tag: tag.iter().map(|t| (*t).to_owned()).collect(),
            ids: vec![],
            limit: limit.map(str::to_owned),
        };
        async move { client.list_pets(request).await.expect("a page").pets.len() }
    };
    assert_eq!(ask(None, &[], None).await, 2);
    assert_eq!(ask(Some("dog"), &[], None).await, 1);
    // An exploded array is one pair per value.
    assert_eq!(ask(None, &["good", "loud"], None).await, 1);
    assert_eq!(ask(None, &[], Some("1")).await, 1);
    // An array that is not exploded is one pair, comma-separated.
    let rex = adopt(&client, "Rex", "dog", &[]).await.body.id.to_string();
    let ids = client
        .list_pets(list_pets::Request {
            species: None,
            tag: vec![],
            ids: vec!["nobody".to_owned(), rex],
            limit: None,
        })
        .await
        .expect("a page");
    assert_eq!(ids.pets.len(), 1);
}

#[tokio::test]
async fn cookies_and_an_optional_body() {
    let client = client();
    let me = client
        .whoami(whoami::Request {
            session: Some("abc".to_owned()),
            theme: Some("dark".to_owned()),
        })
        .await
        .expect("me");
    assert_eq!(
        (me.session.as_deref(), me.theme.as_deref()),
        (Some("abc"), Some("dark"))
    );
    // Cookie values are bytes: text that is not ASCII crosses.
    let accented = client
        .whoami(whoami::Request {
            session: Some("zoë".to_owned()),
            theme: None,
        })
        .await
        .expect("me");
    assert_eq!(accented.session.as_deref(), Some("zoë"));
    let nobody = client
        .whoami(whoami::Request {
            session: None,
            theme: None,
        })
        .await
        .expect("me");
    assert_eq!((nobody.session, nobody.theme), (None, None));
    let id = adopt(&client, "Rex", "dog", &[]).await.body.id.to_string();
    // A body that may be left out.
    client
        .touch_pet(touch_pet::Request {
            id: id.clone(),
            body: None,
        })
        .await
        .expect("touched");
    client
        .touch_pet(touch_pet::Request {
            id,
            body: Some(Note {
                text: "hello".to_owned(),
            }),
        })
        .await
        .expect("touched with a note");
}

#[tokio::test]
async fn events_are_a_stream_of_the_servers_events() {
    let client = client();
    let id = adopt(&client, "Rex", "dog", &[]).await.body.id.to_string();
    let mut events = client
        .pet_events(pet_events::Request { id })
        .await
        .expect("a stream");
    let first = events
        .next()
        .await
        .expect("an event")
        .expect("a good event");
    assert!(
        matches!(first, PetEvent::Changed(ref pet) if pet.name == "Rex"),
        "{first:?}"
    );
    let second = events
        .next()
        .await
        .expect("an event")
        .expect("a good event");
    assert!(
        matches!(second, PetEvent::Gone(ref text) if text.contains("end")),
        "{second:?}"
    );
    assert!(events.next().await.is_none());
    // Before a stream begins, a refusal is the error of the call.
    match client
        .pet_events(pet_events::Request {
            id: "nobody".to_owned(),
        })
        .await
    {
        Err(Error::Refused(pet_events::Refusal::Status404(_))) => {}
        Ok(_) => panic!("a stream for a pet that is not there"),
        Err(other) => panic!("{other:?}"),
    }
}

fn canned(status: u16, body: &'static str) -> http::Response<ByteStream> {
    let stream: ByteStream = Box::pin(tokio_stream::iter([Ok(Bytes::from(body))]));
    let mut response = http::Response::new(stream);
    *response.status_mut() = http::StatusCode::from_u16(status).expect("a status");
    response
}

#[tokio::test]
async fn responses_the_contract_does_not_describe_are_told_apart() {
    // A status it does not list.
    match get_pet::response(canned(418, "teapot")).await {
        Err(Error::Unlisted { status, body }) => {
            assert_eq!((status.as_u16(), &body[..]), (418, &b"teapot"[..]))
        }
        other => panic!("{other:?}"),
    }
    // A listed status with a body that is not what the contract says.
    match get_pet::response(canned(200, "{\"id\":")).await {
        Err(Error::Decode { status, .. }) => assert_eq!(status.as_u16(), 200),
        other => panic!("{other:?}"),
    }
    // A required header the response does not have.
    assert!(matches!(
        create_pet::response(canned(201, "{}")).await,
        Err(Error::Decode { .. })
    ));
}

#[tokio::test]
async fn events_the_contract_does_not_list_or_cannot_read_are_errors() {
    let body = "event: nothing\ndata: {}\n\nevent: changed\ndata: not json\n\n";
    let mut events = pet_events::response(canned(200, body))
        .await
        .expect("a stream");
    assert!(
        matches!(events.next().await, Some(Err(StreamError::UnknownEvent(name))) if name == "nothing")
    );
    assert!(
        matches!(events.next().await, Some(Err(StreamError::Decode { event, .. })) if event == "changed")
    );
}

#[test]
fn a_path_value_a_url_reads_as_navigation_is_refused() {
    for id in [".", ".."] {
        let request = get_pet::request(
            "http://pets.example",
            &get_pet::Request {
                id: id.to_owned(),
                x_request_id: None,
            },
        );
        assert!(matches!(request, Err(Error::Request(_))), "{id}");
    }
}

#[test]
fn request_is_built_without_sending() {
    let request = get_pet::request(
        "http://pets.example/",
        &get_pet::Request {
            id: "a b/c".to_owned(),
            x_request_id: Some("r".to_owned()),
        },
    )
    .expect("a request");
    assert_eq!(
        request.uri().to_string(),
        "http://pets.example/pets/a%20b%2Fc"
    );
    assert_eq!(request.method(), http::Method::GET);
    assert_eq!(request.headers()["x-request-id"], "r");
    let listed = list_pets::request(
        "http://pets.example",
        &list_pets::Request {
            species: None,
            tag: vec!["a&b".to_owned(), "c".to_owned()],
            ids: vec!["p1".to_owned(), "p2".to_owned()],
            limit: Some("3".to_owned()),
        },
    )
    .expect("a request");
    // An array that is not exploded is one pair whose values are comma-separated: the comma is the separator, not part of a value.
    assert_eq!(
        listed.uri().query(),
        Some("tag=a%26b&tag=c&ids=p1,p2&limit=3")
    );
}

fn chunked(chunks: &[&'static [u8]]) -> http::Response<ByteStream> {
    let stream: ByteStream = Box::pin(tokio_stream::iter(
        chunks
            .iter()
            .map(|chunk| Ok(Bytes::from_static(chunk)))
            .collect::<Vec<_>>(),
    ));
    let mut response = http::Response::new(stream);
    *response.status_mut() = http::StatusCode::OK;
    response
}

async fn gone_texts(response: http::Response<ByteStream>) -> Vec<String> {
    let mut events = pet_events::response(response).await.expect("a stream");
    let mut texts = Vec::new();
    while let Some(event) = events.next().await {
        if let Ok(PetEvent::Gone(text)) = event {
            texts.push(text);
        }
    }
    texts
}

#[tokio::test]
async fn event_streams_end_their_lines_as_the_standard_says() {
    // \n, \r\n and \r end a line; a \r\n split between two chunks is one line end, not two.
    for body in [
        &b"event: gone\ndata: a\n\nevent: gone\ndata: b\n\n"[..],
        &b"event: gone\r\ndata: a\r\n\r\nevent: gone\r\ndata: b\r\n\r\n"[..],
        &b"event: gone\rdata: a\r\revent: gone\rdata: b\r\r"[..],
    ] {
        assert_eq!(
            gone_texts(chunked(&[body])).await,
            ["a", "b"],
            "{}",
            String::from_utf8_lossy(body)
        );
    }
    let split = chunked(&[
        b"event: gone\r",
        b"\ndata: a\r",
        b"\n\r",
        b"\nevent: gone\ndata: b\n\n",
    ]);
    assert_eq!(gone_texts(split).await, ["a", "b"]);
    // A byte order mark first, a comment, an event with no data, and one that never finishes.
    let odd = chunked(&[
        b"\xEF\xBB\xBFevent: gone\ndata: a\n\n",
        b": keep-alive\n\nevent: gone\n\nevent: gone\ndata: b\n\nevent: gone\ndata: c",
    ]);
    assert_eq!(gone_texts(odd).await, ["a", "b"]);
}

#[tokio::test]
async fn one_chunk_of_many_events_is_read_in_linear_time() {
    let one: &'static [u8] = Box::leak(
        "event: gone\ndata: x\n\n"
            .repeat(200_000)
            .into_bytes()
            .into_boxed_slice(),
    );
    let started = std::time::Instant::now();
    assert_eq!(gone_texts(chunked(&[one])).await.len(), 200_000);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn a_body_without_end_is_an_error_and_not_memory() {
    let big: &'static [u8] = Box::leak(vec![b'x'; 1 << 20].into_boxed_slice());
    let endless: ByteStream = Box::pin(tokio_stream::iter(
        std::iter::repeat(big)
            .take(64)
            .map(|chunk| Ok(Bytes::from_static(chunk))),
    ));
    let mut response = http::Response::new(endless);
    *response.status_mut() = http::StatusCode::OK;
    match get_pet::response(response).await {
        Err(Error::Transport(error)) => {
            assert!(error.to_string().contains("longer than"), "{error}")
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_base_address_with_a_query_is_refused() {
    let request = get_pet::request(
        "http://pets.example/?x=1",
        &get_pet::Request {
            id: "a".to_owned(),
            x_request_id: None,
        },
    );
    assert!(matches!(request, Err(Error::Request(_))));
}

#[tokio::test]
async fn event_stream_odd_inputs_are_told_apart_from_events() {
    // A byte order mark cut between chunks is still not part of the first line.
    let cut = chunked(&[b"\xEF\xBB", b"\xBFevent: gone\ndata: a\n\n"]);
    assert_eq!(gone_texts(cut).await, ["a"]);
    // An empty event name is no name: the event is a `message`, which this contract does not list.
    let mut events = pet_events::response(chunked(&[b"event:\ndata: x\n\n"]))
        .await
        .expect("a stream");
    assert!(
        matches!(events.next().await, Some(Err(StreamError::UnknownEvent(name))) if name == "message")
    );
}

#[tokio::test]
async fn an_event_that_never_ends_is_an_error_and_then_the_stream_is_over() {
    // Lines of data and never the blank line that ends the event: 20 MiB of them, past the 16 MiB an event may take.
    let line: &'static [u8] = Box::leak(
        format!("data: {}\n", "x".repeat(1023))
            .into_bytes()
            .into_boxed_slice(),
    );
    let endless: ByteStream = Box::pin(tokio_stream::iter(
        std::iter::repeat(line)
            .take(20 * 1024)
            .map(|chunk| Ok(Bytes::from_static(chunk))),
    ));
    let mut response = http::Response::new(endless);
    *response.status_mut() = http::StatusCode::OK;
    let mut events = pet_events::response(response).await.expect("a stream");
    assert!(matches!(
        events.next().await,
        Some(Err(StreamError::Transport(_)))
    ));
    assert!(
        events.next().await.is_none(),
        "after that error the stream is over, not stuck on it"
    );
}
