/** The Rust templates of `client.rs`: a client of the contract, over a transport the application chooses. */
import { type Answer, type Events, type Op } from "../contract.js";
import { type Config, Refusal } from "../config.js";
import { generatedNotice, q } from "../rust.js";

const lines = (xs: string[]) => xs.filter((x) => x !== "").join("\n");

/** Names `Client` has already, which an operation may not take. */
export const CLIENT_METHODS = new Set(["new", "transport", "base", "into_inner"]);

/** Names the client file defines or imports, which an event stream may not take (it is a type of the service's module). */
const CLIENT_TYPES = new Set([
  "Client", "Api", "Transport", "Stream", "Error", "Request", "Refusal", "Answer", "Bytes", "Pin", "ByteStream", "StreamError", "TransportError",
  "Reqwest", "Context", "Poll", "Future", "SseStream", "Option", "Result", "Vec", "Box", "String", "Self", "Some", "None", "Ok", "Err",
]);

/** The crates the client's code names by path, which a module or an operation of its may not be named like (it would shadow the crate). */
export const CLIENT_CRATES = new Set(["http", "bytes", "reqwest", "tokio", "irpc"]);

/** Refuses an event stream named like something the client defines, or like the stream type of another (`Foo` and `FooStream`). */
export const checkClientNames = (module: string, ops: Op[]) => {
  const names = new Set(ops.flatMap((o) => (o.events ? [o.events.name] : [])));
  for (const name of names) {
    if (CLIENT_TYPES.has(name) || names.has(`${name}Stream`)) {
      throw new Refusal(`${module}: the stream ${name} takes the name of something the client defines (or the name of the type of another stream): rename it in the contract`);
    }
  }
};

export const clientHeader = (c: Config) => `${generatedNotice(c.generator)}
#![allow(missing_docs, dead_code, unused_imports, unused_variables, unused_mut, clippy::all, clippy::pedantic)]
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use bytes::Bytes;
use tokio_stream::{Stream, StreamExt as _};

/// The body of a response as the transport reads it off the connection: a stream of chunks.
pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, TransportError>> + Send>>;

/// A failure of the transport: the connection, the TLS, a timeout. What it holds is the transport's own error.
#[derive(Debug)]
pub struct TransportError(pub Box<dyn std::error::Error + Send + Sync>);

impl TransportError {
    pub fn new(error: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> Self {
        Self(error.into())
    }
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for TransportError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&*self.0)
    }
}

/// What sends the requests of a client: the application's HTTP client, a test double, or a router called in process.
pub trait Transport: Send + Sync {
    fn send(&self, request: http::Request<Bytes>) -> impl Future<Output = Result<http::Response<ByteStream>, TransportError>> + Send;
}

/// Why a call failed. \`R\` is the operation's \`Refusal\`: the statuses its contract lists as refusals, with their bodies.
#[derive(Debug)]
pub enum Error<R> {
    /// The transport could not send the request or read the response.
    Transport(TransportError),
    /// The request could not be made from what was given (a header value HTTP cannot carry, say).
    Request(String),
    /// The response has a status the contract lists, and a body or a header it does not describe.
    Decode { status: http::StatusCode, message: String, body: Bytes },
    /// The server refused the request, as the contract says it may.
    Refused(R),
    /// The response has a status the contract does not list.
    Unlisted { status: http::StatusCode, body: Bytes },
}

impl<R: std::fmt::Debug> std::fmt::Display for Error<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(error) => write!(f, "the transport failed: {error}"),
            Self::Request(message) => write!(f, "the request could not be made: {message}"),
            Self::Decode { status, message, .. } => write!(f, "the response {status} does not match the contract: {message}"),
            Self::Refused(refusal) => write!(f, "the server refused the request: {refusal:?}"),
            Self::Unlisted { status, .. } => write!(f, "the response {status} is not one the contract lists"),
        }
    }
}

impl<R: std::fmt::Debug> std::error::Error for Error<R> {}

/// Why an event of a stream could not be read.
#[derive(Debug)]
pub enum StreamError {
    Transport(TransportError),
    /// The stream names an event the contract does not list.
    UnknownEvent(String),
    /// The data of an event is not what the contract says it carries.
    Decode { event: String, message: String },
}

impl std::fmt::Display for StreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(error) => write!(f, "the transport failed: {error}"),
            Self::UnknownEvent(event) => write!(f, "the stream sent the event {event}, which the contract does not list"),
            Self::Decode { event, message } => write!(f, "the data of the event {event} does not match the contract: {message}"),
        }
    }
}

impl std::error::Error for StreamError {}

/// Characters a path segment keeps as they are.
const SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

/// A segment of the path. \`.\` and \`..\` are navigation to a URL parser, whatever they are encoded as, so they name nothing and are refused.
fn push_segment(uri: &mut String, value: &str) -> Result<(), String> {
    if value == "." || value == ".." {
        return Err(format!("a path parameter cannot be {value:?}: a URL reads it as navigation"));
    }
    uri.push('/');
    uri.extend(percent_encoding::utf8_percent_encode(value, SEGMENT));
    Ok(())
}

fn encode_query(value: &str) -> String {
    form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn push_pair(query: &mut String, name: &str, encoded_value: &str) {
    if !query.is_empty() {
        query.push('&');
    }
    query.extend(form_urlencoded::byte_serialize(name.as_bytes()));
    query.push('=');
    query.push_str(encoded_value);
}

/// The most of a response body (or of a line of an event stream) that is read: a longer one is an error, not memory.
const MAX_BODY_BYTES: usize = ${c.clientMaxBodyBytes};

async fn collect(mut body: ByteStream) -> Result<Bytes, TransportError> {
    let mut all = Vec::new();
    while let Some(chunk) = body.next().await {
        let chunk = chunk?;
        if all.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(TransportError::new(format!("the response body is longer than {MAX_BODY_BYTES} bytes")));
        }
        all.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(all))
}

fn header_text(headers: &http::HeaderMap, name: &str) -> Option<String> {
    headers.get(name).map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
}

fn header_texts(headers: &http::HeaderMap, name: &str) -> Vec<String> {
    headers.get_all(name).iter().map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned()).collect()
}

/// A value written as text (a text/plain body, the data of a text event): a number or a boolean reads as JSON, anything else as the
/// string it is (JSON first, for a type that is not text, when \`json_first\`).
fn text_value<T: serde::de::DeserializeOwned>(text: &str, json_first: bool) -> Result<T, serde_json::Error> {
    let as_string = || serde_json::from_value(serde_json::Value::String(text.to_owned()));
    if json_first { serde_json::from_str(text).or_else(|_| as_string()) } else { as_string().or_else(|_| serde_json::from_str(text)) }
}

fn decode_error<R>(status: http::StatusCode, message: impl std::fmt::Display, body: &Bytes) -> Error<R> {
    Error::Decode { status, message: message.to_string(), body: body.clone() }
}

fn missing_header<R>(status: http::StatusCode, name: &str) -> Error<R> {
    Error::Decode { status, message: format!("the response has no {name} header"), body: Bytes::new() }
}

/// The events of a \`text/event-stream\` body, each as its name and data. A line ends with \`\\n\`, \`\\r\` or \`\\r\\n\`.
struct SseStream {
    body: ByteStream,
    buffer: Vec<u8>,
    /// Where the line being read begins in \`buffer\`, and how many bytes of it have been searched for its end.
    start: usize,
    searched: usize,
    first: bool,
    ended: bool,
    event: Option<String>,
    data: Vec<String>,
    /// The bytes of the event being read (its name and its data): one event is capped like a line.
    pending: usize,
}

impl SseStream {
    fn new(body: ByteStream) -> Self {
        Self { body, buffer: Vec::new(), start: 0, searched: 0, first: true, ended: false, event: None, data: Vec::new(), pending: 0 }
    }
}

impl SseStream {
    /// Ends the stream with this error: nothing more is read, so a consumer that goes on asking is told it is over.
    fn give_up(&mut self, message: String) -> Poll<Option<<Self as Stream>::Item>> {
        self.ended = true;
        self.buffer.clear();
        self.start = 0;
        self.searched = 0;
        self.data.clear();
        Poll::Ready(Some(Err(TransportError::new(message))))
    }
}

impl Stream for SseStream {
    type Item = Result<(String, String), TransportError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = &mut *self;
        loop {
            let from = this.start + this.searched;
            match this.buffer[from..].iter().position(|byte| *byte == b'\\n' || *byte == b'\\r') {
                // A \`\\r\` at the very end may be the first half of \`\\r\\n\`: the next chunk says.
                Some(offset) if this.buffer[from + offset] == b'\\r' && from + offset + 1 == this.buffer.len() && !this.ended => {
                    this.searched = from + offset - this.start;
                }
                Some(offset) => {
                    let end = from + offset;
                    let line = String::from_utf8_lossy(&this.buffer[this.start..end]).into_owned();
                    let crlf = this.buffer[end] == b'\\r' && this.buffer.get(end + 1) == Some(&b'\\n');
                    this.start = if crlf { end + 2 } else { end + 1 };
                    this.searched = 0;
                    if line.is_empty() {
                        let event = this.event.take();
                        this.pending = 0;
                        if !this.data.is_empty() {
                            let data = this.data.join("\\n");
                            this.data.clear();
                            return Poll::Ready(Some(Ok((event.unwrap_or_else(|| "message".to_owned()), data))));
                        }
                    } else if !line.starts_with(':') {
                        let (field, value) = match line.split_once(':') {
                            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
                            None => (line.as_str(), ""),
                        };
                        match field {
                            // An empty name is no name: the event is a \`message\`.
                            "event" => this.event = (!value.is_empty()).then(|| value.to_owned()),
                            "data" => this.data.push(value.to_owned()),
                            _ => {}
                        }
                        this.pending += value.len();
                        if this.pending > MAX_BODY_BYTES {
                            return this.give_up(format!("an event of the stream is longer than {MAX_BODY_BYTES} bytes"));
                        }
                    }
                    continue;
                }
                None => this.searched = this.buffer.len() - this.start,
            }
            // No line is complete: an event that never finishes is dropped, and the room taken by lines read is given back.
            if this.ended {
                return Poll::Ready(None);
            }
            if this.start > 0 {
                this.buffer.drain(..this.start);
                this.start = 0;
            }
            if this.buffer.len() > MAX_BODY_BYTES {
                return this.give_up(format!("a line of the event stream is longer than {MAX_BODY_BYTES} bytes"));
            }
            match this.body.as_mut().poll_next(cx) {
                Poll::Ready(Some(Ok(chunk))) => {
                    this.buffer.extend_from_slice(&chunk);
                    // A byte order mark first is not part of the first line, however the chunks cut it.
                    if this.first && (this.buffer.len() >= 3 || this.buffer.contains(&b'\\n')) {
                        if this.buffer.starts_with(&[0xEF, 0xBB, 0xBF]) {
                            this.buffer.drain(..3);
                        }
                        this.first = false;
                    }
                }
                Poll::Ready(Some(Err(error))) => return Poll::Ready(Some(Err(error))),
                Poll::Ready(None) => this.ended = true,
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}
${c.clientReqwest ? `
/// A transport over a \`reqwest::Client\`.
#[derive(Debug, Clone)]
pub struct Reqwest(pub reqwest::Client);

/// A redirect is an answer the contract may list, so the default client does not follow one. It waits 10 s to connect and 60 s for
/// bytes, which a server-sent stream keeps coming with its keep-alives; build a \`reqwest::Client\` for others.
impl Default for Reqwest {
    fn default() -> Self {
        Self(
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(std::time::Duration::from_secs(10))
                .read_timeout(std::time::Duration::from_secs(60))
                .build()
                .expect("a reqwest client"),
        )
    }
}

impl Transport for Reqwest {
    fn send(&self, request: http::Request<Bytes>) -> impl Future<Output = Result<http::Response<ByteStream>, TransportError>> + Send {
        let client = self.0.clone();
        async move {
            let request = reqwest::Request::try_from(request).map_err(TransportError::new)?;
            let response = client.execute(request).await.map_err(TransportError::new)?;
            let (status, headers, version) = (response.status(), response.headers().clone(), response.version());
            let body: ByteStream = Box::pin(response.bytes_stream().map(|chunk| chunk.map_err(TransportError::new)));
            let mut out = http::Response::new(body);
            *out.status_mut() = status;
            *out.headers_mut() = headers;
            *out.version_mut() = version;
            Ok(out)
        }
    }
}
` : ""}`;

// ---------------------------------------------------------------------------------------------------------------------
// One operation
// ---------------------------------------------------------------------------------------------------------------------

const inputType = (p: Op["params"][number]) =>
  p.kind === "path" ? "String" : p.repeated && (p.kind === "query" || p.kind === "header") ? "Vec<String>" : "Option<String>";

/** The type of an answer's body in the client: a stream of events is the client's own type. */
const bodyType = (a: Answer, o: Op) => (a.media === "text/event-stream" ? `${o.events!.name}Stream` : a.ty);

const requestFn = (o: Op) => {
  const segments = o.path === "/" ? [] : o.path.split("/").slice(1);
  const path = (o.path === "/" ? [] : segments.map((s) => {
    const param = s.match(/^\{(\w+)\}$/);
    if (!param) return `    uri.push_str(${q("/" + s)});`;
    const p = o.params.find((x) => x.kind === "path" && x.name === param[1])!;
    return `    push_segment(&mut uri, &input.${p.field}).map_err(Error::Request)?;`;
  }));
  const queries = o.params.filter((p) => p.kind === "query").map((p) => {
    if (!p.repeated) return `    if let Some(value) = &input.${p.field} {\n        push_pair(&mut query, ${q(p.name)}, &encode_query(value));\n    }`;
    if (p.explode) return `    for value in &input.${p.field} {\n        push_pair(&mut query, ${q(p.name)}, &encode_query(value));\n    }`;
    return `    if !input.${p.field}.is_empty() {\n        push_pair(&mut query, ${q(p.name)}, &input.${p.field}.iter().map(|value| encode_query(value)).collect::<Vec<_>>().join(","));\n    }`;
  });
  const named = (p: Op["params"][number], header: string) => p.kind === "header" && p.name.toLowerCase() === header;
  const contentTypeParam = o.params.find((p) => named(p, "content-type"));
  const acceptParam = o.params.find((p) => named(p, "accept"));
  const bodyMedia = o.bodyMedia ?? "application/json";
  const headers = o.params.filter((p) => p.kind === "header" && p !== contentTypeParam && p !== acceptParam).map((p) =>
    p.repeated
      ? `    for value in &input.${p.field} {\n        builder = builder.header(${q(p.name)}, value.as_str());\n    }`
      : `    if let Some(value) = &input.${p.field} {\n        builder = builder.header(${q(p.name)}, value.as_str());\n    }`);
  const cookies = o.params.filter((p) => p.kind === "cookie");
  const media = [...new Set([...o.answers.map((a) => a.media), ...o.docResponses.flatMap((r) => r.contents.map((c) => c.media))].filter(Boolean))];
  const encode = `serde_json::to_vec(body).map_err(|error| Error::Request(error.to_string()))?`;
  const contentType = contentTypeParam ? `input.${contentTypeParam.field}.as_deref().unwrap_or(${q(bodyMedia)})` : q(bodyMedia);
  const body = !o.body ? "    let payload = Bytes::new();"
    : o.bodyOptional ? `    let payload = match &input.body {\n        Some(body) => {\n            builder = builder.header(http::header::CONTENT_TYPE, ${contentType});\n            Bytes::from(${encode})\n        }\n        None => Bytes::new(),\n    };`
    : `    let body = &input.body;\n    builder = builder.header(http::header::CONTENT_TYPE, ${contentType});\n    let payload = Bytes::from(${encode});`;
  return `
    /// The HTTP request for this operation, to send as it is or to change first (sign it, say).
    pub fn request(base: &str, input: &Request) -> Result<http::Request<Bytes>, Error> {
        if base.contains(['?', '#']) {
            return Err(Error::Request("the base address has a query or a fragment: give it as scheme://host[/prefix]".to_owned()));
        }
        let mut uri = String::from(base.trim_end_matches('/'));
${lines(path)}
        let mut query = String::new();
${lines(queries)}
        if !query.is_empty() {
            uri.push('?');
            uri.push_str(&query);
        }
        let mut builder = http::Request::builder().method(http::Method::${o.method.toUpperCase()}).uri(uri).header(http::header::ACCEPT, ${acceptParam ? `input.${acceptParam.field}.as_deref().unwrap_or(${q(media.join(", ") || "*/*")})` : q(media.join(", ") || "*/*")});
${lines(headers)}${cookies.length ? `
        let mut cookies: Vec<String> = Vec::new();
${lines(cookies.map((p) => `        if let Some(value) = &input.${p.field} {\n            if value.contains(';') || value.chars().any(char::is_control) {\n                return Err(Error::Request(format!("the cookie {} holds a character a cookie cannot", ${q(p.name)})));\n            }\n            cookies.push(format!("{}={}", ${q(p.name)}, value));\n        }`))}
        if !cookies.is_empty() {
            builder = builder.header(http::header::COOKIE, cookies.join("; "));
        }` : ""}
${body.replace(/^ {4}/gm, "        ")}
        builder.body(payload).map_err(|error| Error::Request(error.to_string()))
    }`;
};

/** The expression that reads a body of the given media into the Rust type. */
const decodeBody = (ty: string, media: string, status: string) =>
  media === "text/plain"
    ? (ty === "String" ? "String::from_utf8_lossy(&bytes).into_owned()" : `text_value::<${ty}>(&String::from_utf8_lossy(&bytes), ${/^(bool|[iuf]\d+)$/.test(ty)}).map_err(|error| decode_error(${status}, error, &bytes))?`)
    : `serde_json::from_slice::<${ty}>(&bytes).map_err(|error| decode_error(${status}, error, &bytes))?`;

const answerHeaders = (a: Answer) => a.headers.map((h) =>
  h.repeated ? `${h.field}: header_texts(&parts.headers, ${q(h.name)})`
    : h.optional ? `${h.field}: header_text(&parts.headers, ${q(h.name)})`
    : `${h.field}: header_text(&parts.headers, ${q(h.name)}).ok_or_else(|| missing_header(parts.status, ${q(h.name)}))?`);

const refusalVariant = (status: number) => `Status${status}`;

const refusals = (o: Op) => o.docResponses.filter((r) => r.status >= 400).map((r) => {
  const content = r.contents.find((c) => c.ty && (c.media === "application/json" || c.media === "text/plain"));
  return { status: r.status, variant: refusalVariant(r.status), ty: content?.ty, media: content?.media ?? "" };
});

/** The derives that make a type one a protocol can carry (`irpc`), when it can be: a stream cannot. */
const serde = (c: Config) => (c.irpc ? ", serde::Serialize, serde::Deserialize" : "");

const answerTypes = (o: Op, extra: string) => {
  const multiple = o.answers.length > 1;
  const withHeaders = o.answers.filter((a) => a.headers.length);
  const type = (a: Answer) => bodyType(a, o);
  const variant = (a: Answer) => (a.headers.length ? `${a.variant}(${a.variant}),` : type(a) ? `${a.variant}(${type(a)}),` : `${a.variant},`);
  return `
${lines(withHeaders.map((a) => `    #[derive(Debug${extra})]
    pub struct ${multiple ? a.variant : "Answer"} {
${type(a) ? `        pub body: ${type(a)},` : ""}
${lines(a.headers.map((h) => `        pub ${h.field}: ${h.repeated ? "Vec<String>" : h.optional ? "Option<String>" : "String"},`))}
    }`))}
${multiple
    ? `    #[derive(Debug${extra})]\n    pub enum Answer {\n${lines(o.answers.map((a) => "        " + variant(a)))}\n    }`
    : !o.answers[0].headers.length ? `    pub type Answer = ${type(o.answers[0]) ?? "()"};` : ""}`;
};

const responseFn = (o: Op) => {
  const multiple = o.answers.length > 1;
  const success = o.answers.map((a) => {
    const status = "parts.status";
    const stream = a.media === "text/event-stream";
    const value = stream ? `${o.events!.name}::stream(body)` : !a.ty ? "()" : decodeBody(a.ty, a.media, status);
    const read = stream || !a.ty && !a.headers.length ? "" : "            let bytes = collect(body).await.map_err(Error::Transport)?;\n";
    const construct = a.headers.length
      ? `${multiple ? a.variant : "Answer"} { ${[...(a.ty ? ["body: value"] : []), ...answerHeaders(a)].join(", ")} }`
      : a.ty ? "value" : "()";
    const wrapped = multiple ? (a.headers.length || a.ty ? `Answer::${a.variant}(${construct})` : `Answer::${a.variant}`) : construct;
    return `        ${a.status} => {
${read}${a.ty || stream ? `            let value = ${value};\n` : ""}            Ok(${wrapped})
        }`;
  });
  const refused = refusals(o).map((r) => `        ${r.status} => {
            let bytes = collect(body).await.map_err(Error::Transport)?;
${r.ty ? `            let value = ${decodeBody(r.ty, r.media, "parts.status")};\n            Err(Error::Refused(Refusal::${r.variant}(value)))` : `            Err(Error::Refused(Refusal::${r.variant}))`}
        }`);
  return `
    /// Reads the response to this operation into its answer, or the way it failed.
    pub async fn response(response: http::Response<ByteStream>) -> Result<Answer, Error> {
        let (parts, body) = response.into_parts();
        match parts.status.as_u16() {
${lines(success)}
${lines(refused)}
        _ => {
            let bytes = collect(body).await.map_err(Error::Transport)?;
            Err(Error::Unlisted { status: parts.status, body: bytes })
        }
        }
    }`;
};

const refusalType = (o: Op, extra: string) => {
  const rs = refusals(o);
  return `
    /// The refusals this operation lists, by status, with the body each carries.
    #[derive(Debug${extra})]
    pub enum Refusal {
${lines(rs.map((r) => `        ${r.variant}${r.ty ? `(${r.ty})` : ""},`))}
    }`;
};

const operationModule = (o: Op, c: Config) => `
pub mod ${o.id} {
    use super::*;

    /// What the operation is called with: its parameters, as text, and its body.
    #[derive(Debug${serde(c)})]
    pub struct Request {
${lines(o.params.map((p) => `        pub ${p.field}: ${inputType(p)},`))}
${o.body ? `        pub body: ${o.bodyOptional ? `Option<${o.body}>` : o.body},` : ""}
    }
${answerTypes(o, o.events ? "" : serde(c))}
${refusalType(o, serde(c))}

    pub type Error = super::super::Error<Refusal>;
${requestFn(o)}
${responseFn(o)}

    /// Sends the request through the transport and reads the response.
    pub async fn send<T: Transport>(transport: &T, base: &str, input: &Request) -> Result<Answer, Error> {
        let request = request(base, input)?;
        let response = transport.send(request).await.map_err(Error::Transport)?;
        self::response(response).await
    }
}`;

// ---------------------------------------------------------------------------------------------------------------------
// A service
// ---------------------------------------------------------------------------------------------------------------------

const eventsType = (e: Events, c: Config) => `
/// An event of the stream \`${e.name}\`.
#[derive(Debug${serde(c)})]
pub enum ${e.name} {
${lines(e.variants.map((v) => `    ${v.variant}(${v.ty}),`))}
}

/// The events of a response, as they come.
pub struct ${e.name}Stream(pub Pin<Box<dyn Stream<Item = Result<${e.name}, StreamError>> + Send>>);

impl Stream for ${e.name}Stream {
    type Item = Result<${e.name}, StreamError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.0.as_mut().poll_next(cx)
    }
}

impl std::fmt::Debug for ${e.name}Stream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("${e.name}Stream")
    }
}

impl From<Pin<Box<dyn Stream<Item = Result<${e.name}, StreamError>> + Send>>> for ${e.name}Stream {
    fn from(stream: Pin<Box<dyn Stream<Item = Result<${e.name}, StreamError>> + Send>>) -> Self {
        Self(stream)
    }
}

impl ${e.name} {
    /// The event a name and its data stand for.
    pub fn decode(event: &str, data: &str) -> Result<Self, StreamError> {
        let failed = |error: serde_json::Error| StreamError::Decode { event: event.to_owned(), message: error.to_string() };
        match event {
${lines(e.variants.map((v) => `            ${q(v.name)} => Ok(Self::${v.variant}(${v.plain ? (v.ty === "String" ? "data.to_owned()" : `text_value::<${v.ty}>(data, ${/^(bool|[iuf]\d+)$/.test(v.ty)}).map_err(failed)?`) : `serde_json::from_str::<${v.ty}>(data).map_err(failed)?`})),`))}
            _ => Err(StreamError::UnknownEvent(event.to_owned())),
        }
    }

    /// The events of a response body.
    pub fn stream(body: ByteStream) -> ${e.name}Stream {
        ${e.name}Stream(Box::pin(SseStream::new(body).map(|item| match item {
            Ok((event, data)) => Self::decode(&event, &data),
            Err(error) => Err(StreamError::Transport(error)),
        })))
    }
}`;

/** The operations of a service as a trait: the HTTP client implements it, and so can a service in process or a client of another transport. */
const apiTrait = (ops: Op[]) => `
    /// A service of this contract: what \`Client\` is over HTTP. Program against it to swap the transport, or to serve in process.
    pub trait Api: Send + Sync {
${lines(ops.map((o) => `        fn ${o.id}(&self, request: ${o.id}::Request) -> impl Future<Output = Result<${o.id}::Answer, ${o.id}::Error>> + Send;`))}
    }

    impl<T: Transport> Api for Client<T> {
${lines(ops.map((o) => `        fn ${o.id}(&self, request: ${o.id}::Request) -> impl Future<Output = Result<${o.id}::Answer, ${o.id}::Error>> + Send {
            async move { ${o.id}::send(&self.transport, &self.base, &request).await }
        }`))}
    }`;

export const clientModule = (module: string, ops: Op[], c: Config) => {
  const streams = new Map<string, Events>();
  for (const o of ops) if (o.events) streams.set(o.events.name, o.events);
  return `
pub mod ${module} {
    use super::*;
${lines([...streams.values()].map((e) => eventsType(e, c)))}
${lines(ops.map((o) => operationModule(o, c)))}
${apiTrait(ops)}

    /// A client of this contract: a transport and the address of the server.
    #[derive(Debug, Clone)]
    pub struct Client<T> {
        transport: T,
        base: String,
    }

    impl<T: Transport> Client<T> {
        pub fn new(transport: T, base: impl Into<String>) -> Self {
            Self { transport, base: base.into() }
        }

        pub fn transport(&self) -> &T {
            &self.transport
        }

        pub fn into_inner(self) -> T {
            self.transport
        }
${lines(ops.map((o) => `
        ${o.summary ? `/// ${o.summary.replace(/\r\n|\r|\n/g, " ")}\n        ` : ""}pub async fn ${o.id}(&self, request: ${o.id}::Request) -> Result<${o.id}::Answer, ${o.id}::Error> {
            ${o.id}::send(&self.transport, &self.base, &request).await
        }`))}
    }
}`;
};
