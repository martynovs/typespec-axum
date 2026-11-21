//! The contract as an irpc protocol: the HTTP client served over irpc, and called through irpc as any `Api`, so the same call goes
//! irpc client -> protocol -> HTTP client -> router -> handler.
use axum::Router;
use axum::body::Body;
use bytes::Bytes;
use pets_example::api::petstore as server;
use pets_example::client::petstore::whoami;
use pets_example::client::petstore::{
    Api, Client, PetEvent, create_pet, get_pet, list_pets, pet_events,
};
use pets_example::client::{ByteStream, Error, StreamError, Transport, TransportError};
use pets_example::irpc_api::Wire;
use pets_example::irpc_api::petstore::{Protocol, Remote, handler, spawn};
use pets_example::store::Shop;
use pets_example::types::NewPet;
use serde_json::json;
use std::future::Future;
use std::sync::Arc;
use tokio_stream::StreamExt;
use tower::ServiceExt;

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

fn http_client() -> Client<InProcess> {
    Client::new(
        InProcess(server::mount(Router::new(), &Shop::default())),
        "http://pets.example",
    )
}

fn new_pet(name: &str) -> NewPet {
    serde_json::from_value(json!({"name": name, "species": "dog", "tags": ["good"]}))
        .expect("a new pet")
}

/// Written against the trait: it does not know whether HTTP or irpc is behind it.
async fn adopt_and_read(api: &impl Api) -> (create_pet::Answer, get_pet::Answer) {
    let created = api
        .create_pet(create_pet::Request {
            body: new_pet("Rex"),
        })
        .await
        .expect("created");
    let pet = api
        .get_pet(get_pet::Request {
            id: created.body.id.to_string(),
            x_request_id: None,
        })
        .await
        .expect("the pet");
    (created, pet)
}

#[tokio::test]
async fn the_same_calls_work_over_http_and_over_irpc() {
    let (created, pet) = adopt_and_read(&http_client()).await;
    assert_eq!(pet, created.body);
    let remote = Remote(spawn(Arc::new(http_client())));
    let (created, pet) = adopt_and_read(&remote).await;
    assert_eq!(pet, created.body);
    assert!(created.location.ends_with(&created.body.id.to_string()));
}

#[tokio::test]
async fn refusals_and_failures_survive_the_protocol() {
    let remote = Remote(spawn(Arc::new(http_client())));
    // A refusal the contract lists, with its body.
    match remote
        .get_pet(get_pet::Request {
            id: "nobody".to_owned(),
            x_request_id: None,
        })
        .await
    {
        Err(Error::Refused(get_pet::Refusal::Status404(failure))) => {
            assert_eq!(failure.code, "not_found")
        }
        other => panic!("{other:?}"),
    }
    // The page of a list, with its query.
    let page = remote
        .list_pets(list_pets::Request {
            species: Some("cat".to_owned()),
            tag: vec![],
            ids: vec![],
            limit: None,
        })
        .await
        .expect("a page");
    assert!(page.pets.is_empty());
}

#[tokio::test]
async fn events_come_through_the_protocol_as_a_stream() {
    let remote = Remote(spawn(Arc::new(http_client())));
    let id = remote
        .create_pet(create_pet::Request {
            body: new_pet("Rex"),
        })
        .await
        .expect("created")
        .body
        .id
        .to_string();
    let mut events = remote
        .pet_events(pet_events::Request { id })
        .await
        .expect("a stream");
    assert!(matches!(events.next().await, Some(Ok(PetEvent::Changed(pet))) if pet.name == "Rex"));
    assert!(matches!(events.next().await, Some(Ok(PetEvent::Gone(_)))));
    assert!(events.next().await.is_none());
    // A refusal before the stream begins is the error of the call.
    match remote
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

#[test]
fn what_goes_between_processes_is_the_contracts_json() {
    // The binary format of a remote irpc call (postcard) cannot carry what the contract's JSON does (absent fields, untagged unions);
    // `Wire` carries the JSON, so it round-trips.
    let request = create_pet::Request {
        body: new_pet("Rex"),
    };
    let bytes = postcard::to_stdvec(&Wire(request)).expect("encoded");
    let Wire(back): Wire<create_pet::Request> = postcard::from_bytes(&bytes).expect("decoded");
    assert_eq!(back.body.name, "Rex");
    assert_eq!(back.body.age, None);
}

/// The same calls across a QUIC connection on localhost: what crosses is the protocol's postcard, with the contract's JSON inside.
#[tokio::test]
async fn the_same_calls_work_across_a_quic_connection() {
    let (endpoint, _certificate) =
        irpc::noq::make_server_endpoint("127.0.0.1:0".parse().expect("an address"))
            .expect("a server endpoint");
    let address = endpoint.local_addr().expect("an address");
    tokio::spawn(irpc::noq::listen::<Protocol>(
        endpoint,
        handler(Arc::new(http_client())),
    ));
    let client_endpoint =
        irpc::noq::make_insecure_client_endpoint("127.0.0.1:0".parse().expect("an address"))
            .expect("a client endpoint");
    let remote = Remote(irpc::Client::noq(client_endpoint, address));

    let (created, pet) = adopt_and_read(&remote).await;
    assert_eq!(pet, created.body);
    match remote
        .get_pet(get_pet::Request {
            id: "nobody".to_owned(),
            x_request_id: None,
        })
        .await
    {
        Err(Error::Refused(get_pet::Refusal::Status404(failure))) => {
            assert_eq!(failure.code, "not_found")
        }
        other => panic!("{other:?}"),
    }
    let mut events = remote
        .pet_events(pet_events::Request {
            id: created.body.id.to_string(),
        })
        .await
        .expect("a stream");
    assert!(matches!(
        events.next().await,
        Some(Ok(PetEvent::Changed(_)))
    ));
    assert!(matches!(events.next().await, Some(Ok(PetEvent::Gone(_)))));
    assert!(events.next().await.is_none());
}

/// The HTTP client for everything but the events, which a test feeds by hand.
struct Fed {
    inner: Client<InProcess>,
    events: std::sync::Mutex<Option<tokio::sync::mpsc::Receiver<Result<PetEvent, StreamError>>>>,
    dropped: Arc<std::sync::atomic::AtomicBool>,
}

/// A stream that says when it is dropped.
struct Watched(
    tokio_stream::wrappers::ReceiverStream<Result<PetEvent, StreamError>>,
    Arc<std::sync::atomic::AtomicBool>,
);

impl tokio_stream::Stream for Watched {
    type Item = Result<PetEvent, StreamError>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        std::pin::Pin::new(&mut self.0).poll_next(cx)
    }
}

impl Drop for Watched {
    fn drop(&mut self) {
        self.1.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Api for Fed {
    fn whoami(
        &self,
        request: whoami::Request,
    ) -> impl Future<Output = Result<whoami::Answer, whoami::Error>> + Send {
        Api::whoami(&self.inner, request)
    }
    fn list_pets(
        &self,
        request: list_pets::Request,
    ) -> impl Future<Output = Result<list_pets::Answer, list_pets::Error>> + Send {
        Api::list_pets(&self.inner, request)
    }
    fn create_pet(
        &self,
        request: create_pet::Request,
    ) -> impl Future<Output = Result<create_pet::Answer, create_pet::Error>> + Send {
        Api::create_pet(&self.inner, request)
    }
    fn delete_pet(
        &self,
        request: pets_example::client::petstore::delete_pet::Request,
    ) -> impl Future<
        Output = Result<
            pets_example::client::petstore::delete_pet::Answer,
            pets_example::client::petstore::delete_pet::Error,
        >,
    > + Send {
        Api::delete_pet(&self.inner, request)
    }
    fn get_pet(
        &self,
        request: get_pet::Request,
    ) -> impl Future<Output = Result<get_pet::Answer, get_pet::Error>> + Send {
        Api::get_pet(&self.inner, request)
    }
    fn pet_events(
        &self,
        _request: pet_events::Request,
    ) -> impl Future<Output = Result<pet_events::Answer, pet_events::Error>> + Send {
        let rx = self
            .events
            .lock()
            .expect("the lock")
            .take()
            .expect("one subscription");
        let stream: std::pin::Pin<
            Box<dyn tokio_stream::Stream<Item = Result<PetEvent, StreamError>> + Send>,
        > = Box::pin(Watched(
            tokio_stream::wrappers::ReceiverStream::new(rx),
            self.dropped.clone(),
        ));
        async move { Ok(stream.into()) }
    }
    fn touch_pet(
        &self,
        request: pets_example::client::petstore::touch_pet::Request,
    ) -> impl Future<
        Output = Result<
            pets_example::client::petstore::touch_pet::Answer,
            pets_example::client::petstore::touch_pet::Error,
        >,
    > + Send {
        Api::touch_pet(&self.inner, request)
    }
}

fn fed() -> (
    Remote,
    tokio::sync::mpsc::Sender<Result<PetEvent, StreamError>>,
    Arc<std::sync::atomic::AtomicBool>,
) {
    let (tx, rx) = tokio::sync::mpsc::channel(8);
    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let api = Fed {
        inner: http_client(),
        events: std::sync::Mutex::new(Some(rx)),
        dropped: dropped.clone(),
    };
    (Remote(spawn(Arc::new(api))), tx, dropped)
}

fn gone() -> PetEvent {
    PetEvent::Gone("bye".to_owned())
}

#[tokio::test]
async fn a_stream_is_open_before_its_first_event() {
    let (remote, tx, _) = fed();
    // As over HTTP: the call returns once the other side has taken it, and the events come when there are some.
    let mut events = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        remote.pet_events(pet_events::Request { id: "x".to_owned() }),
    )
    .await
    .expect("the call returns before the first event")
    .expect("a stream");
    tx.send(Ok(gone())).await.expect("sent");
    assert!(matches!(events.next().await, Some(Ok(PetEvent::Gone(_)))));
    drop(tx);
    assert!(
        events.next().await.is_none(),
        "a stream the other side finished ends"
    );
}

#[tokio::test]
async fn what_went_wrong_in_a_stream_keeps_its_kind() {
    let (remote, tx, _) = fed();
    let mut events = remote
        .pet_events(pet_events::Request { id: "x".to_owned() })
        .await
        .expect("a stream");
    tx.send(Err(StreamError::UnknownEvent("zzz".to_owned())))
        .await
        .expect("sent");
    tx.send(Err(StreamError::Decode {
        event: "changed".to_owned(),
        message: "bad".to_owned(),
    }))
    .await
    .expect("sent");
    tx.send(Ok(gone())).await.expect("sent");
    assert!(
        matches!(events.next().await, Some(Err(StreamError::UnknownEvent(name))) if name == "zzz")
    );
    assert!(
        matches!(events.next().await, Some(Err(StreamError::Decode { event, message })) if event == "changed" && message == "bad")
    );
    assert!(
        matches!(events.next().await, Some(Ok(PetEvent::Gone(_)))),
        "the stream goes on after them"
    );
}

#[tokio::test]
async fn dropping_a_stream_lets_the_other_side_go() {
    let (remote, tx, dropped) = fed();
    let events = remote
        .pet_events(pet_events::Request { id: "x".to_owned() })
        .await
        .expect("a stream");
    drop(events);
    // Nothing is sent: the other side learns the stream is gone without having anything to say.
    let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !dropped.load(std::sync::atomic::Ordering::SeqCst) && std::time::Instant::now() < until {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        dropped.load(std::sync::atomic::Ordering::SeqCst),
        "the served stream was dropped"
    );
    drop(tx);
}

#[tokio::test]
async fn a_call_for_another_operation_than_the_servers_is_refused() {
    use pets_example::irpc_api::petstore::{ListPets, Protocol};
    // A caller whose contract places `get_pet` where this server places `list_pets`: it is told so, and the server runs nothing.
    let client = spawn(Arc::new(http_client()));
    let list = list_pets::Request {
        species: None,
        tag: vec![],
        ids: vec![],
        limit: None,
    };
    let wrong: irpc::Client<Protocol> = client;
    let reply = wrong
        .rpc(ListPets(Wire(list), "get_pet".to_owned()))
        .await
        .expect("a reply");
    match reply {
        pets_example::irpc_api::Reply::Failed(pets_example::irpc_api::Failure::Request(
            message,
        )) => {
            assert!(message.contains("contract"), "{message}")
        }
        other => panic!("{other:?}"),
    }
}
