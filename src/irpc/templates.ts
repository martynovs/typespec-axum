/** The Rust templates of `irpc.rs`: the contract as an irpc protocol, served from the client's `Api` and called through it. */
import { type Config, Refusal } from "../config.js";
import { generatedNotice } from "../rust.js";
import { type Op } from "../contract.js";

const lines = (xs: string[]) => xs.filter((x) => x !== "").join("\n");

/** Names the code of a service's module uses (the variants and their structs are items of the same module, which would shadow them). */
const NAMES = new Set([
  "Protocol", "Message", "Remote", "Wire", "Failure", "Reply", "WithChannels", "Result", "Option", "Ok", "Err", "Some", "None", "Box", "Vec", "String", "Self",
  "Arc", "Error", "Future", "TransportError", "StreamFault", "Frame",
]);

/** Modules the irpc file imports or names by path, which a service's module may not be named like (it would shadow them). */
const MODULES = new Set(["mpsc", "oneshot", "irpc", "serde", "serde_json", "tokio", "tokio_stream", "http", "std", "core", "alloc"]);

/** The irpc functions of a service that an operation id may not take (they are items of the same module). */
const FUNCTIONS = new Set(["serve", "spawn", "events_of"]);

export const irpcHeader = (c: Config) => `${generatedNotice(c.generator)}
#![allow(missing_docs, dead_code, unused_imports, unused_variables, unused_mut, clippy::all, clippy::pedantic)]
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use ::irpc::channel::{mpsc, oneshot};
use ::irpc::{WithChannels, rpc_requests};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use tokio_stream::{Stream, StreamExt as _};
use ${c.clientPath}::{Error, StreamError, TransportError};

/// A value that is itself in process and the JSON of the contract between processes: the types of a contract are written for JSON
/// (untagged unions, absent fields), which the binary format of a remote irpc call cannot carry, so a remote call carries their JSON.
#[derive(Debug, Clone)]
pub struct Wire<T>(pub T);

impl<T: Serialize> Serialize for Wire<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(&serde_json::to_vec(&self.0).map_err(serde::ser::Error::custom)?)
    }
}

impl<'de, T: serde::de::DeserializeOwned> Deserialize<'de> for Wire<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let bytes = <Vec<u8>>::deserialize(deserializer)?;
        serde_json::from_slice(&bytes).map(Wire).map_err(serde::de::Error::custom)
    }
}

/// How a call failed, as a protocol carries it: \`Error\` with the transport's error as its text. A refusal is not one of these: it is a value of
/// the contract, so it travels as \`Wire\`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Failure {
    Transport(String),
    Request(String),
    Decode { status: u16, message: String, body: Vec<u8> },
    Unlisted { status: u16, body: Vec<u8> },
}

impl Failure {
    /// The failure an error is, or the refusal when it is one.
    fn of<R>(error: Error<R>) -> Result<Self, R> {
        Ok(match error {
            Error::Transport(error) => Self::Transport(error.to_string()),
            Error::Request(message) => Self::Request(message),
            Error::Decode { status, message, body } => Self::Decode { status: status.as_u16(), message, body: body.to_vec() },
            Error::Refused(refusal) => return Err(refusal),
            Error::Unlisted { status, body } => Self::Unlisted { status: status.as_u16(), body: body.to_vec() },
        })
    }
}

impl<R> From<Failure> for Error<R> {
    fn from(failure: Failure) -> Self {
        let status = |status: u16| http::StatusCode::from_u16(status).unwrap_or(http::StatusCode::INTERNAL_SERVER_ERROR);
        match failure {
            Failure::Transport(message) => Self::Transport(TransportError::new(message)),
            Failure::Request(message) => Self::Request(message),
            Failure::Decode { status: code, message, body } => Self::Decode { status: status(code), message, body: body.into() },
            Failure::Unlisted { status: code, body } => Self::Unlisted { status: status(code), body: body.into() },
        }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// The reply to a call: the answer or the refusal, which are values of the contract (so \`Wire\`), or how the call failed.
#[derive(Debug, Serialize, Deserialize)]
#[serde(bound(serialize = "A: Serialize, R: Serialize", deserialize = "A: serde::de::DeserializeOwned, R: serde::de::DeserializeOwned"))]
pub enum Reply<A, R> {
    Answer(Wire<A>),
    Refused(Wire<R>),
    Failed(Failure),
}

impl<A, R> From<Result<A, Error<R>>> for Reply<A, R> {
    fn from(result: Result<A, Error<R>>) -> Self {
        match result {
            Ok(answer) => Self::Answer(Wire(answer)),
            Err(error) => match Failure::of(error) {
                Ok(failure) => Self::Failed(failure),
                Err(refusal) => Self::Refused(Wire(refusal)),
            },
        }
    }
}

impl<A, R> From<Reply<A, R>> for Result<A, Error<R>> {
    fn from(reply: Reply<A, R>) -> Self {
        match reply {
            Reply::Answer(Wire(answer)) => Ok(answer),
            Reply::Refused(Wire(refusal)) => Err(Error::Refused(refusal)),
            Reply::Failed(failure) => Err(failure.into()),
        }
    }
}

/// What a server says of a call that means another operation than the one at its place: the caller's contract is not its own.
fn wrong_contract(called: &str, here: &str) -> String {
    format!("the caller's contract is not this server's: it calls {called} where the server has {here}")
}

/// How an event of a stream failed to be read, as a protocol carries it: \`StreamError\` with the transport's error as its text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum StreamFault {
    Transport(String),
    UnknownEvent(String),
    Decode { event: String, message: String },
}

impl From<StreamError> for StreamFault {
    fn from(error: StreamError) -> Self {
        match error {
            StreamError::Transport(error) => Self::Transport(error.to_string()),
            StreamError::UnknownEvent(event) => Self::UnknownEvent(event),
            StreamError::Decode { event, message } => Self::Decode { event, message },
        }
    }
}

impl From<StreamFault> for StreamError {
    fn from(fault: StreamFault) -> Self {
        match fault {
            StreamFault::Transport(message) => Self::Transport(TransportError::new(message)),
            StreamFault::UnknownEvent(event) => Self::UnknownEvent(event),
            StreamFault::Decode { event, message } => Self::Decode { event, message },
        }
    }
}

/// What a stream call sends back, in order: \`Open\` once the call went through (or \`Refused\` or \`Failed\`, and nothing more), then the events and
/// their faults, then \`End\`. A stream that stops without \`End\` was cut off.
#[derive(Debug, Serialize, Deserialize)]
#[serde(bound(serialize = "E: Serialize, R: Serialize", deserialize = "E: serde::de::DeserializeOwned, R: serde::de::DeserializeOwned"))]
pub enum Frame<E, R> {
    Open,
    Event(Wire<E>),
    Fault(StreamFault),
    End,
    Refused(Wire<R>),
    Failed(Failure),
}

/// The events of a stream the other side sends, once it has said the call went through.
async fn events_of<E: Send + Sync + 'static, R: std::fmt::Debug + Send + Sync + 'static>(
    mut frames: mpsc::Receiver<Frame<E, R>>,
) -> Result<Pin<Box<dyn Stream<Item = Result<E, StreamError>> + Send>>, Error<R>> {
    match frames.recv().await {
        Ok(Some(Frame::Open)) => {}
        Ok(Some(Frame::Refused(Wire(refusal)))) => return Err(Error::Refused(refusal)),
        Ok(Some(Frame::Failed(failure))) => return Err(failure.into()),
        Ok(Some(_)) => return Err(Error::Transport(TransportError::new("the stream did not begin by saying the call went through"))),
        Ok(None) => return Err(Error::Transport(TransportError::new("the other side closed before the call went through"))),
        Err(error) => return Err(Error::Transport(TransportError::new(error))),
    }
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    tokio::spawn(async move {
        loop {
            // The consumer dropping the stream ends this, and with it the receiver, which tells the other side to stop.
            let (item, last) = tokio::select! {
                _ = tx.closed() => break,
                frame = frames.recv() => match frame {
                    Ok(Some(Frame::Event(Wire(event)))) => (Ok(event), false),
                    Ok(Some(Frame::Fault(fault))) => (Err(StreamError::from(fault)), false),
                    Ok(Some(Frame::End)) => break,
                    Ok(Some(Frame::Open)) => continue,
                    Ok(Some(Frame::Failed(failure))) => (Err(StreamError::Transport(TransportError::new(failure.to_string()))), true),
                    Ok(Some(Frame::Refused(_))) => (Err(StreamError::Transport(TransportError::new("the stream was refused after it began"))), true),
                    Ok(None) => (Err(StreamError::Transport(TransportError::new("the stream was cut off before the other side finished it"))), true),
                    Err(error) => (Err(StreamError::Transport(TransportError::new(error))), true),
                },
            };
            if tx.send(item).await.is_err() || last {
                break;
            }
        }
    });
    Ok(Box::pin(tokio_stream::wrappers::ReceiverStream::new(rx)))
}
`;

const refusalOf = (o: Op) => `api::${o.id}::Refusal`;

/** The reply of an operation: its answer, its refusal or how the call failed; for a stream, the events one after another. */
const reply = (o: Op) => o.events
  ? `mpsc::Sender<Frame<api::${o.events.name}, ${refusalOf(o)}>>`
  : `oneshot::Sender<Reply<api::${o.id}::Answer, ${refusalOf(o)}>>`;

/** A call carries the id of the operation it means, which the server checks: a caller and a server of different contracts may place an operation differently. */
const variant = (o: Op) => `    #[rpc(tx = ${reply(o)})]
    #[wrap(${o.trait})]
    ${o.trait}(Wire<api::${o.id}::Request>, String),`;

const remoteMethod = (o: Op) => `
        fn ${o.id}(&self, request: api::${o.id}::Request) -> impl Future<Output = Result<api::${o.id}::Answer, api::${o.id}::Error>> + Send {
            let client = self.0.clone();
            async move {
${o.events
    ? `                let events = client.server_streaming(${o.trait}(Wire(request), ${JSON.stringify(o.id)}.to_owned()), 16).await.map_err(|error| Error::Transport(TransportError::new(error)))?;
                events_of(events).await.map(api::${o.events.name}Stream::from)`
    : `                let reply: Reply<_, _> = client.rpc(${o.trait}(Wire(request), ${JSON.stringify(o.id)}.to_owned())).await.map_err(|error| Error::Transport(TransportError::new(error)))?;
                reply.into()`}
            }
        }`;

const serveArm = (o: Op) => o.events
  ? `            Message::${o.trait}(WithChannels { inner, tx, .. }) => {
                let ${o.trait}(Wire(request), operation) = inner;
                tokio::spawn(async move {
                    if operation != ${JSON.stringify(o.id)} {
                        tx.send(Frame::Failed(Failure::Request(wrong_contract(&operation, ${JSON.stringify(o.id)})))).await.ok();
                        return;
                    }
                    match api.${o.id}(request).await {
                        Err(error) => {
                            let frame = match Failure::of(error) {
                                Ok(failure) => Frame::Failed(failure),
                                Err(refusal) => Frame::Refused(Wire(refusal)),
                            };
                            tx.send(frame).await.ok();
                        }
                        Ok(mut events) => {
                            if tx.send(Frame::Open).await.is_err() {
                                return;
                            }
                            loop {
                                // A caller that dropped the stream ends it, quiet as it is.
                                let item = tokio::select! {
                                    _ = tx.closed() => return,
                                    item = events.next() => item,
                                };
                                let frame = match item {
                                    Some(Ok(event)) => Frame::Event(Wire(event)),
                                    Some(Err(error)) => Frame::Fault(StreamFault::from(error)),
                                    None => {
                                        tx.send(Frame::End).await.ok();
                                        return;
                                    }
                                };
                                if tx.send(frame).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                });
            }`
  : `            Message::${o.trait}(WithChannels { inner, tx, .. }) => {
                let ${o.trait}(Wire(request), operation) = inner;
                tokio::spawn(async move {
                    if operation != ${JSON.stringify(o.id)} {
                        tx.send(Reply::Failed(Failure::Request(wrong_contract(&operation, ${JSON.stringify(o.id)})))).await.ok();
                        return;
                    }
                    tx.send(Reply::from(api.${o.id}(request).await)).await.ok();
                });
            }`;

export const irpcModule = (module: string, ops: Op[], c: Config) => {
  if (MODULES.has(module)) throw new Refusal(`${module}: the namespace is named like a module the irpc file uses: rename it in the contract`);
  for (const o of ops) {
    if (NAMES.has(o.trait)) throw new Refusal(`${module}: the operation ${o.id} is the variant ${o.trait} of the irpc protocol, a name the generated code uses: rename it in the contract`);
    if (FUNCTIONS.has(o.id)) throw new Refusal(`${module}: the operation ${o.id} takes the name of a function of the irpc module (${[...FUNCTIONS].join(", ")}): rename it in the contract`);
    if (o.events && (o.answers.length > 1 || o.answers[0].headers.length)) {
      throw new Refusal(`${module}: the stream ${o.id} has other answers or response headers, which an irpc stream cannot carry: give it one answer, the stream`);
    }
  }
  return `
pub mod ${module} {
    use super::*;
    use ${c.clientPath}::${module} as api;

    /// The contract as an irpc protocol: a call for each operation, the request and the reply carried as \`Wire\`.
    #[rpc_requests(message = Message)]
    #[derive(Debug, Serialize, Deserialize)]
    pub enum Protocol {
${lines(ops.map(variant))}
    }

    /// A service of this contract on the other side of an irpc client (in process or remote), called as any \`Api\`.
    #[derive(Debug, Clone)]
    pub struct Remote(pub ::irpc::Client<Protocol>);

    impl api::Api for Remote {
${lines(ops.map(remoteMethod))}
    }

    /// Answers the calls of \`messages\` with \`api\`, each on a task of its own, until the sender is dropped. For a remote caller, hand
    /// the sender to \`irpc::rpc::listen\` as well.
    pub async fn serve<A: api::Api + 'static>(api: Arc<A>, mut messages: tokio::sync::mpsc::Receiver<Message>) {
        while let Some(message) = messages.recv().await {
            let api = api.clone();
            match message {
${lines(ops.map(serveArm))}
            }
        }
    }

    /// What a listener (\`irpc::noq::listen::<Protocol>\`, iroh's) takes to serve \`api\` to remote callers. A request that does not decode fails its own call,
    /// not the connection (and so not the other callers' calls and streams on it).
    pub fn handler<A: api::Api + 'static>(api: Arc<A>) -> ::irpc::rpc::Handler<Protocol> {
        ::irpc::rpc::Handler::from(spawn(api).as_local().expect("a local client")).skip_bad_requests(true)
    }

    /// Serves \`api\` on a task and returns the client that calls it in process.
    pub fn spawn<A: api::Api + 'static>(api: Arc<A>) -> ::irpc::Client<Protocol> {
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        tokio::spawn(serve(api, rx));
        ::irpc::Client::local(tx)
    }
}`;
};
