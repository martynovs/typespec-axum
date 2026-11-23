# typespec-rust-api

[![CI](https://github.com/martynovs/typespec-rust-api/actions/workflows/ci.yml/badge.svg)](https://github.com/martynovs/typespec-rust-api/actions/workflows/ci.yml)

A [TypeSpec](https://typespec.io) emitter that writes the Rust of an API straight from its contract: **serde wire types**, an **axum server**, an
**HTTP client**, an **[irpc](https://docs.rs/irpc) protocol** and the **OpenAPI document** (built with [utoipa](https://docs.rs/utoipa)). Choose what you need
([Choosing what is written](#choosing-what-is-written)); one contract keeps them from drifting apart. No OpenAPI file in the middle.
(Formerly `@martynovs/typespec-axum`, which wrote the types and the axum server.)

```
main.tsp ──tsp compile──▶ types.rs    serde types, one per model, enum, union and scalar (+ utoipa schemas)
                          axum.rs     server: per operation a trait, its input and answer, the handler that reads the request, the route
                          client.rs   client: a Client over a transport you choose, typed answers and refusals, event streams  (client: true)
                          irpc.rs     the contract as an irpc protocol, served from and called through the client's Api            (irpc: true)
```

- **The contract is the router.** Each operation becomes a trait with one method that returns the handler, or `None` when the node
  cannot serve it (the route is then not mounted). Implement the traits, call `mount`.
- **Requests are read once, without surprises.** Path parameters are read by position, the query in one pass over borrowed pairs, and
  a query over a bound is refused before it is parsed. A parameter the contract does not list is counted, never stored.
- **Answers are typed.** A handler returns the operation's `Answer` (a body, headers and a status the contract lists) or refuses with a
  `Refused`, which is a response of its own. A response with no named shape fails the emit rather than becoming `serde_json::Value`.
- **The document is the contract's.** `document()` returns the OpenAPI 3.2 document, checked against `@typespec/openapi3`'s own output
  from the same contract (see [`examples/pets`](examples/pets/tests/api.rs)). With `document: typespec` it follows that output more closely still (see [Known differences](#known-differences-from-typespecopenapi3)).

## Quick start

```sh
npm install --save-dev @martynovs/typespec-rust-api @typespec/compiler @typespec/http @typespec/openapi @typespec/streams @typespec/events @typespec/sse
```

```yaml
# tspconfig.yaml
emit:
  - "@martynovs/typespec-rust-api"
options:
  "@martynovs/typespec-rust-api":
    emitter-output-dir: "{project-root}/src/generated"
```

```sh
npx tsp compile .
rustfmt --edition 2024 src/generated/types.rs src/generated/axum.rs   # the emitter leaves layout to rustfmt
```

```toml
# Cargo.toml
[dependencies]
axum = { version = "0.8", default-features = false, features = ["http1", "json", "tokio", "query", "matched-path", "multipart"] }   # "multipart" only with a form
bytes = "1"             # only with a file or a form
form_urlencoded = "1"
percent-encoding = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio-stream = { version = "0.1", default-features = false }
utoipa = "6"            # not with `document: none`
```

```rust
// src/lib.rs
#[path = "generated/types.rs"] pub mod types;   // `types-path` says where this is (default `crate::types`)
#[path = "generated/axum.rs"] pub mod api;
```

## Choosing what is written

| File | When | Option |
|---|---|---|
| `types.rs` | always: the serde wire types of the contract | `document` (the utoipa schemas; `none` for none), `type-map`, `derive-eq` |
| `axum.rs` | the endpoints, by default | `server: false` leaves it out |
| `client.rs` | `client: true` | `client-reqwest`, `client-max-body-bytes`, `client-path` |
| `irpc.rs` | `irpc: true` (needs `client`) | |

So `server: false` with `client: true` is a client (and with `irpc: true` an irpc client and server) with no axum in it; `server: false` alone writes the types only.
`server: false` needs `document: none` (the document is the server's), and refuses the options of the server (`reject-with`, `refusal-type`, `extension-expr`).

## What a contract becomes

Given [`examples/pets/main.tsp`](examples/pets/main.tsp), whose `get_pet` is

```tsp
@route("/pets/{id}")
@get
op get_pet(@path id: PetId, @header("x-request-id") request_id?: string): Pet | NotFound;
```

the emitter writes, in `api::petstore` (the namespace, lower-cased):

```rust
pub trait GetPet: Send + Sync {
    /// The handler of this operation, or `None` when this node cannot serve it, so the router does not mount the route.
    fn get_pet_handler(&self) -> Option<get_pet::Call>;
}

pub mod get_pet {
    pub struct Input {
        pub unknown: usize,               // query pairs the operation does not list
        pub id: String,                   // percent-decoded
        pub x_request_id: Option<String>,
    }
    pub type Answer = Pet;                // `NotFound` is a refusal, not an answer
    pub type Call = Arc<dyn Fn(Parts, Input) -> Pin<Box<dyn Future<Output = Result<Answer, Refused>> + Send>> + Send + Sync>;

    pub fn call(handler) -> Call;                        // a function of the request
    pub fn call_with_state(state: Arc<T>, handler) -> Call; // a method of a shared state: `Store::get_pet`
    pub fn mount<S: GetPet>(router: Router, api: &S) -> Router;
}
```

You implement the trait for your node and mount the contract:

```rust
impl GetPet for Shop {
    fn get_pet_handler(&self) -> Option<get_pet::Call> {
        Some(get_pet::call_with_state(self.0.clone(), Store::get_pet))   // async fn get_pet(self: Arc<Self>, Parts, get_pet::Input)
    }
}
// ... one impl per operation, then:
let app = petstore::mount(Router::new(), &shop);   // or `get_pet::mount` for one route
```

[`examples/pets`](examples/pets) is a complete server: `just serve`.

Also generated, per contract (namespace):

| | |
|---|---|
| `mount(router, &api)` | Mounts every route `api` serves. `router` is yours: start it with your layers and state. |
| `Operation` | One variant per operation, each holding its `Route { method, path, extensions }`; constants `Operation::GET_PET`, `Operation::ALL`; `AsRef<Route>`. Exhaustive `match` over the contract. |
| `document()` | The OpenAPI 3.2 `serde_json::Value`, from the same `#[utoipa::path]`s the handlers carry. |
| `ApiDoc` | The `utoipa::OpenApi` it comes from. |

Every `x-*` extension on an operation (`@extension("x-scope", "admin")`) is in its `Route::extensions` as `{ name, json }` and in the
document: the contract carries it, your server decides what it means (authorization, rate limits, ...).

## Files and forms

A request body can be a file or a form, read with axum's own extractors and under axum's own body limit.

| The contract | `Input::body` | Document |
|---|---|---|
| `@body body: bytes` (any `@header contentType`), or `@bodyRoot file: File` (or a model that extends it) | `axum::body::Bytes` (`Option<Bytes>` for `body?`) | `contentMediaType` for each media type |
| `@multipartBody body: { title: HttpPart<string>; meta: HttpPart<Meta>; doc: HttpPart<File>; photos: HttpPart<File>[]; ... }` | `Form`, a struct of the operation with a field for each part: `String`, a scalar parsed from the text, a model read as JSON, or `UploadFile`; an optional part is an `Option`, a part that is an array a `Vec` | an object schema with `encoding`, as `@typespec/openapi3` writes it |

- The media type is checked first: a body or a file part of a type the contract does not list is `415` (a file part that states no type is taken to be the contract's, as RFC 7578 allows; `*/*` and `image/*` allow any). A form is read by axum's `Multipart`, so a request that is not a form is the operation's listed refusal (`400`, `422`, `401`, as a JSON body that does not decode is), or axum's own answer when it lists none. A missing, repeated or unreadable part is the same. A body that cannot be read (too large) is axum's `413`.
- **The limit is axum's.** The body is limited by `DefaultBodyLimit` as for any axum handler: 2 MiB unless your application adds the layer. `max-upload-bytes` sets the layer on the routes of the operations that take a file or a form, which replaces the application's for them. Parts that are text or JSON are bounded by `max-form-field-bytes` and the number of parts by `max-form-parts`. A body is read into memory (up to the limit, for each request in flight), so bound the number of uploads at once (`tower`'s `ConcurrencyLimit`) too.
- `UploadFile` (in `types.rs`) holds `filename`, `content_type` and `contents: bytes::Bytes`; its `Debug` prints the length, not the bytes. The file name is the client's text: never use it as a path. A text part is read as UTF-8 whatever charset it states, and a file part is held whole, bounded only by the body's limit.
- The client has the same `Form` (and `bytes::Bytes` for a file) in `Request::body` and writes the `multipart/form-data` body itself (with its own `Content-Type`, so a `content_type` of the request is not sent), with a boundary no part holds; no feature of `reqwest` is needed.
- Not generated (the emit fails, saying why): `multipart/mixed`, a named model as the multipart body, a part with headers, a part that is a `File` with text contents, an optional form, irpc (a request is one message of at most 16 MiB there), and a file or `bytes` response. A part the contract does not list is read past.

## The client

`client: true` also writes `client.rs`: a client of the same contract, with no axum in it. It sends through a `Transport` you implement
(your HTTP client, a test double, or a router called in process); `client-reqwest: true` adds one over `reqwest` (`Reqwest`). It needs
`http`, `bytes`, `tokio-stream`, `serde_json`, `percent-encoding` and `form_urlencoded` (and `reqwest` with its `stream` feature).

```rust
let client = client::petstore::Client::new(Reqwest::default(), "http://localhost:3000");
let created = client.create_pet(create_pet::Request { body: new_pet }).await?;       // Answer { body, location, x_given_name }
match client.get_pet(get_pet::Request { id, x_request_id: None }).await {
    Err(Error::Refused(get_pet::Refusal::Status404(failure))) => { /* a refusal the contract lists, with its body */ }
    ..
}
let mut events = client.pet_events(pet_events::Request { id }).await?;                // a Stream of the contract's events
```

| Per operation (`client::<service>::<operation>`) | |
|---|---|
| `Request` | The parameters as text (the path ones, the query ones as `Option<String>` or `Vec<String>`, headers, cookies) and the body. |
| `Answer` | As on the server: one variant per success status, a struct where headers come with it, a stream (`<Events>Stream`) for server-sent events. |
| `Refusal` | One variant per error status the contract lists, with its body. `Error<Refusal>` also says the transport failed, the request could not be made, the response did not match the contract (`Decode`), or the status is not listed (`Unlisted`). |
| `request(base, &Request)`, `response(..)`, `send(&transport, base, &Request)` | The pieces: build the HTTP request (to sign or log it), read a response, or both. `Client<T>` has one method per operation that calls `send`. |

Each service also has an `Api` trait with a method per operation, which `Client<T>` implements: write against it and the transport (or irpc, below) can be swapped.
`Reqwest::default()` does not follow redirects, since a 3xx is an answer the contract may list. A stream of events is `<Events>Stream` (a `Stream` of
`Result<Event, StreamError>`); an event name the contract does not list is an `UnknownEvent` error.

What the client reads: a response body (or a line of an event stream) longer than `client-max-body-bytes` (16 MiB) is an error, not memory; events
end their lines with `\n`, `\r` or `\r\n` as the standard says, a byte order mark first is skipped, and an event with no data is not an event.
`Reqwest::default()` waits 10 s to connect and 60 s for bytes (a stream's keep-alives are bytes); there is no overall timeout, which a stream could not have, so wrap
the call in one, or give `Reqwest` a `reqwest::Client` of your own. The base address is `scheme://host[/prefix]`: a query or a fragment in it is refused.

What the client does with values: header and cookie values are bytes, read as UTF-8 (on the server too); a path parameter that is `.` or `..` is refused
(`Error::Request`), since a URL reads it as navigation whatever it is encoded as; a cookie holding `;` is refused; query and path values are percent-encoded, an array that is not
exploded is one pair with its values comma-separated. `Request`, `Refusal` and the events derive no `Clone`, since a type used only there need not have one; a `type-map` type inside a model must be `Debug`, `Clone`, `PartialEq`, `Serialize` and `Deserialize`, as the models derive them. Headers on an error
status, a second body shape of one status, and a literal non-ASCII segment of a route (which a client percent-encodes and a router matches raw) are not covered.

## irpc

`irpc: true` (with `client`) also writes `irpc.rs`: each service as an [irpc](https://docs.rs/irpc) protocol, for the client and the server of it.
One generated file has both sides; the HTTP client's `Api` trait is what they share.

| | |
|---|---|
| `Protocol` | A call for each operation, answered with the `Answer` or how the call failed (`Failure`, a serializable `Error`). A stream is a server-streaming call: `Frame`s `Open`, then `Event`s and `Fault`s, then `End`. |
| `Remote(irpc::Client<Protocol>)` | **The client side.** It implements `Api`, as `Client<T>` (over HTTP) does, so the call sites do not change. |
| `handler(api)` | What a remote listener takes (`irpc::noq::listen`, iroh's). A request that does not decode (a `NaN` serializes as `null`) fails its own call and not the connection: with irpc's default handler it would close the connection and with it the other callers' calls and streams. |
| `serve(api, messages)`, `spawn(api)` | **The server side.** They answer the calls with any `Api`: an HTTP client (a proxy), in-process handlers, a test double. `spawn` does it on a task and returns the in-process `irpc::Client`. |

```rust
// The server: implement `Api` once (or put an HTTP client behind it), serve it over QUIC.
tokio::spawn(irpc::noq::listen::<irpc_api::petstore::Protocol>(endpoint, irpc_api::petstore::handler(Arc::new(my_pets))));   // or iroh's

// The client: the same `Api` as over HTTP.
let pets = irpc_api::petstore::Remote(irpc::Client::noq(client_endpoint, server_address));
let created = pets.create_pet(create_pet::Request { body: new_pet }).await?;
let mut events = pets.pet_events(pet_events::Request { id }).await?;                    // a Stream, as over HTTP

// Code written against the trait does not know which it has:
async fn adopt(api: &impl client::petstore::Api) { .. }
```

What to know:

- **The wire.** The types of a contract are written for JSON (untagged unions, absent fields), which the binary format of a remote irpc call (postcard)
  cannot carry. Requests and replies are `Wire<T>`: the value itself in process, the JSON of the contract between processes, so everything the HTTP
  client carries crosses unchanged. A body of a failure that has one (an unlisted status, a response that did not decode) is carried as hexadecimal text.
- **Limits.** irpc limits a message to 16 MiB: a request over it is an error of the call, a reply over it is a `Transport` error that does not say why.
  A float crosses as JSON; give `serde_json` its `float_roundtrip` feature or its last digit may change.
- **Streams.** The call returns once the other side has taken it, as over HTTP, not at the first event. What goes wrong in a stream keeps its kind
  (`UnknownEvent`, `Decode`), a stream cut off before its end is an error, and dropping the stream lets the serving side go. A stream with other answers
  or response headers is not in the protocol (the emit says so).
- **The server is not the axum server.** `serve` takes an `Api` (a request in, an `Answer` or `Refusal` out), not the handler traits of `axum.rs`; there is no
  bridge from one to the other, so serving the same logic over HTTP and irpc means implementing both (or `Api` over an HTTP client).
- **Versions.** Both sides need the same contract. A call is told by its place in `Protocol`, and the places are the operations by id, so adding an operation moves the
  ones after it; each call also carries its operation's id, which the server checks, so a client and a server of different contracts fail the call (`Request`: the
  caller's contract is not this server's) instead of answering another operation. Regenerate and deploy both sides together.
- **Connections.** noq allows 100 concurrent streams on a connection (its default): 100 held, unread streams make the next call wait. A server that went away is found out after the QUIC idle timeout, about 30 s.
- **Needs** `irpc` (features `derive`, `rpc`; `noq_endpoint_setup` for localhost QUIC in tests), `tokio` (features `rt`, `macros`, `sync`), `tokio-stream`, and `serde_json`.
  `client-path` (default `crate::client`) is where `client.rs` is. Tested over localhost QUIC (noq); iroh uses the same protocol.

## Several contracts

One compile writes one set of files with one set of options, for every `@service` it finds. To write a web API one way and an irpc API another, give each its
own project directory (a `main.tsp` and a `tspconfig.yaml`), as [`examples/split`](examples/split) does:

```
contracts/
  common/main.tsp          @service namespace Shop.Common   the models both share
  common/tspconfig.yaml    server: false                     -> generated/common/types.rs
  web/main.tsp             @service namespace Shop.Web       import "../common/main.tsp"
  web/tspconfig.yaml       document: none, type-map          -> types.rs, axum.rs   (a `type-map` also works with a document: see its row)
  rpc/main.tsp             @service namespace Shop.Rpc       import "../common/main.tsp"
  rpc/tspconfig.yaml       server: false, client, irpc       -> types.rs, client.rs, irpc.rs
```

```yaml
# rpc/tspconfig.yaml
emit: ["@martynovs/typespec-rust-api"]
output-dir: "{project-root}/../generated"
options:
  "@martynovs/typespec-rust-api":
    emitter-output-dir: "{output-dir}/rpc"
    server: false                       # no axum in this one
    client: true
    irpc: true
    client-path: crate::rpc::client     # where the generated files sit in your crate
    types-path: crate::rpc::types
    type-map:                           # the models `common` wrote: named, not written again
      Item: crate::common::types::Item
      NewItem: crate::common::types::NewItem
```

```sh
tsp compile contracts/common && tsp compile contracts/web && tsp compile contracts/rpc
```

```rust
// src/lib.rs: the generated files are modules of your crate
#[path = "../generated/common"] pub mod common { pub mod types; }
#[path = "../generated/web"]    pub mod web    { pub mod types; #[path = "axum.rs"] pub mod api; }
#[path = "../generated/rpc"]    pub mod rpc    { pub mod types; pub mod client; #[path = "irpc.rs"] pub mod irpc_api; }
```

Without the `common` project each contract writes its own `Item` (two types of one shape in two modules), which is fine when they share nothing. `type-map` with a document (`derived` or `typespec`) needs
`utoipa::ToSchema` on the types it names (their schema is the application's, and a derive writes it), and they must derive `Debug`, `Clone`, `PartialEq`, `Serialize` and `Deserialize`, as the generated ones do. An `@service` with no
operations (`common`) writes the types its namespace declares. The `rpc` service implements the client's `Api` and is served with `irpc_api::shop_rpc::spawn`; the
`web` service implements the axum handler traits; both answer with the same `common::types::Item`.

## Constants

What the contract states is also a value Rust can read. Nothing is checked for you: whether to validate, and what a refusal looks like, is
your application's.

| Where | Constants |
|---|---|
| a model or scalar `Pet` | `Pet::DESCRIPTION` (`@doc`), `Pet::SUMMARY` (`@summary`), `Pet::EXAMPLE` (the first `@example`, as JSON text) |
| a field `age` of `Pet` | `Pet::AGE_DESCRIPTION`, `AGE_SUMMARY`, `AGE_EXAMPLE`, `AGE_MINIMUM`, `AGE_MAXIMUM`, `AGE_MIN_LENGTH`, `AGE_MAX_LENGTH`, `AGE_PATTERN` (each when stated) |
| a constrained scalar `PetId` | `PetId::MIN_LENGTH`, `MAX_LENGTH`, `PATTERN`, `MINIMUM`, `MAXIMUM` |
| an enum `Species` and its members | `Species::DESCRIPTION`; per member `Species::DOG_DESCRIPTION`, `DOG_SUMMARY` |
| a union `PetEvent` and its named variants, a container (`model X is Record<T>`) | the same: `PetEvent::DESCRIPTION`, `PetEvent::CHANGED_DESCRIPTION`; the `@events` enum of an operation's stream has them too (`petstore::PetEvent::GONE_DESCRIPTION`) |
| an operation `list_pets` | `list_pets::SUMMARY`, `list_pets::DESCRIPTION`; per parameter `list_pets::LIMIT_MAXIMUM`, `LIMIT_DESCRIPTION`, ... |

A bound has the Rust type of what it bounds (`LIMIT_MAXIMUM: u32`); a length is a `usize`; text is a `&'static str`.

## How TypeSpec maps

| TypeSpec | Rust |
|---|---|
| `model` | `struct` (`#[serde(rename = ...)]`, snake_case fields, `r#` for keywords); `name?: T` is `Option<T>` that is absent, never `null`; `name?: T \| null` is `Option<Option<T>>`, `None` for absent and `Some(None)` for `null`; `...Record<never>` closes a model (`#[serde(deny_unknown_fields)]`: a property it does not list is refused); `extends` copies the base's fields into the struct (the document lists them flat, where `@typespec/openapi3` writes `allOf`) |
| `model Envelope<T>` | one generic `struct Envelope<T>` and each instance `Envelope<Vec<Held>>`, with a document or without (the template's parameters are the types of its fields: `T`, `T[]`, `Record<T>`, or are not used by one; an instance whose argument may be `null`, a template that extends another, uses a parameter in a union or takes a value (`Refused<401>`) is a struct of its own for each instance, `EnvelopeOfArrayOfHeld`; so is the later of two instances that are one Rust type, `Envelope<string>` and `Envelope<utcDateTime>`). A generic struct derives no schema: with a document each instance has a small type in `types.rs` (`EnvelopeOfHeldSchema`) that says the schema, under the name the instance has as a struct of its own, and it is written in place where the instance is used, as `@typespec/openapi3` writes it |
| `enum` | string: `enum` with `rename`; numeric: `#[repr(i64)] enum` with the contract's numbers, `wire()` |
| `union` | `#[serde(untagged)] enum`; `T \| null` is `Option<T>`; a union that is a variant of another is flattened into it (`union B { A, int32 }` has the variants of `A` and `int32`), so no enum holds an enum (a named union of string literals is a string enum of its own, and a variant of a union that also has other types, or the same literals spread into one that has only literals); a union nothing names (`string \| int32`) is one too, numbered (`Anon3`); the document inlines it for a property and refers to it as a component everywhere else. A property typed as a string literal (`kind: "cat"`, or `"a" \| "b"`, with or without `?` and `\| null`) accepts only those values, so an untagged union of models picks its variant by it; a named union of string literals and `null` is a string enum in an `Option`. Numeric and boolean literals (`kind: 1`) are not checked |
| `decimal`, `decimal128` | `Decimal`, a newtype over `serde_json::Number` written as a JSON number (exact with serde_json's `arbitrary_precision` feature; a float without it); a component `Decimal` of the document |
| `scalar X extends string` | `struct X(pub String)`, so the document keeps the name |
| `T[]`, `Record<T>` | `Vec<T>`, `BTreeMap<String, T>` (a named `model X is Record<T>` is a newtype) |
| `int8` ... `uint64`, `float32/64` | `i8` ... `u64`, `f32/f64` (`format` kept: `uint32` stays `uint32` in the document) |
| `@minValue`, `@maxValue`, `@minLength`, `@maxLength`, `@pattern`, `@example`, `@doc`, `@summary` | in the document, and as [constants](#constants) |
| `@cookie` | an `Option<String>` of `Input`: the first cookie of that name in the request's `Cookie` headers, without quotes (an array is refused: a cookie holds one value) |
| `@path` / `@query` / `@header` | `Input` fields: `String` for a path parameter, `Option<String>` for the others, required ones included (whether one is missing is for the application to say); `Vec<String>` for an array: a query with `explode: true` is one pair per value, without it one comma-separated pair; a header array is every value of the header, comma-split |
| `@body` | `Input::body`, decoded as JSON (`Option<T>` for `body?`, absent when empty). The request must say it is JSON (`415` otherwise; see `require-json-content-type`). A body that does not decode is refused with the first of `400`, `422`, `401` the operation lists as a JSON answer, or with axum's own rejection when it lists none: a refusal with no body or a `text/plain` one declares no JSON answer, so it is not counted |
| `200..=399` response | a variant of `Answer`, with a struct for the headers it sets (`Option<String>` for an optional one, sent only when there is a value; a value HTTP cannot carry is answered `500`) |
| `4xx` / `5xx` response | documented, and a handler's `Err(Refused)`; never an `Answer` |
| `SSEStream<Events>` (`@typespec/sse`) | `Events`, a stream of axum `Event`s; the `@events` union becomes an enum with `From<_> for Event` |
| `@extension("x-*", v)` | `Route::extensions` and the document |

Parameters are strings on purpose: parsing `"12"` into a number, and what to do when it is not one, is the handler's, and the contract
cannot say how a refusal looks. (`Input` is where a typed layer goes.)

## Names

A type has the name it has in the contract. Two different types of one name in different namespaces are two Rust types: the first keeps the name, the next
takes its namespace's name in front (`Shop.Item` is `Item`, `Depot.Item` is `DepotItem`). Two with one shape (a model each service declares for
itself) are one type.

## Several services

Each `@service` namespace is a Rust module of its own, with its own `mount`, `Operation` and `document()`. A route two services both declare is
written once, in the first, and only when they declare the same operation (the same name, tags, parameters, body and answers): the
second's `mount` and `Operation` leave it to the first, and its document lists it from there. Mount services that have a route of one
shape under different parameter names (`/pets/{id}` and `/pets/{petId}`) on routers of their own: one router refuses both.

## Options

| Option | Default | |
|---|---|---|
| `types-path` | `crate::types` | Rust path of the module that holds `types.rs`, from the crate (`crate::...`): `super::` and `self::` are refused, the modules sit at different depths. |
| `refusal-type` | one defined in `axum.rs` | Rust path of your own `Refused` (`IntoResponse`). The generated one wraps a `Response` and is `From<StatusCode>`. |
| `reject-with` | none | Rust path of `fn(StatusCode, &'static str) -> Refused` (or your `refusal-type`), which makes the refusal of a request that cannot be read: a body that does not decode, a body nested past `max-json-depth`, a query over a bound, a path parameter that is not UTF-8 (all with the first of `400`, `422`, `401` the operation lists as a JSON answer, else `400`) and a body that is not JSON (`415`). A body that does not decode on an operation that lists none of those statuses (a refusal with no body or a `text/plain` one does not count), and a body that cannot be read (too large, say), keep axum's own answer, with or without `reject-with`. Without it each of the others is a `text/plain` answer. |
| `derive-eq` | `false` | `true` adds `Eq` to every struct, container and union whose parts are all `Eq`: a type with a float (`float32`, `float64`) is left at `PartialEq`, and so is one made of such a type or of a type of the `type-map` whose entry does not say `eq: true` (`String` and the integers need no word). |
| `max-query-bytes` | `4096` | A longer query string is refused (see `reject-with`: `400` unless the operation lists another) before it is parsed. |
| `max-query-pairs` | `64` | So are more `&`-separated pairs. |
| `max-upload-bytes` | none (axum's `DefaultBodyLimit`) | The limit of a body on the routes that take a file or a form, set as axum's `DefaultBodyLimit` on each route. |
| `max-form-field-bytes` | `65536` | The longest part of a form that is text or JSON (a file part is bounded by the body's limit): `413` beyond it. |
| `max-form-parts` | `128` | The most parts a form may have: more is refused as a form that is not one. |
| `max-json-depth` | `32` (at most `128`) | A JSON body that nests deeper (`{` and `[` outside strings) is refused (see `reject-with`) before it is parsed. |
| `document` | `derived` | `derived`: the document is what utoipa's derives write. `typespec`: schemas written by hand to follow `@typespec/openapi3` more closely (enums as `oneOf` per member when `enum-strategy: annotated`, `format: uint8`, ...). `none`: no document: no `ApiDoc`, no `document()`, no `ToSchema`, no `#[utoipa::path]`, and the generated code does not use utoipa, so it is not a dependency. |
| `enum-strategy` | `default` | With `document: typespec`, how an enum is written, as `@typespec/openapi3`'s option of the name: `default`, one `enum` of its values; `annotated`, a `oneOf` of `const` members with their `@summary` as `title` and their doc as `description` (OpenAPI 3.1). utoipa holds no `const`, so an annotated enum is put into the finished document as it is, and the schema of the type itself stays a plain `enum`. |
| `server` | `true` | `false` leaves out `axum.rs`: see [Choosing what is written](#choosing-what-is-written). |
| `client` | `false` | Also write `client.rs`: see [The client](#the-client). |
| `irpc` | `false` | With `client`: also write `irpc.rs`, the contract as an irpc protocol: see [irpc](#irpc). |
| `client-path` | `crate::client` | Where `client.rs` is, for `irpc.rs`. |
| `client-max-body-bytes` | `16777216` | With `client`: the most of a response body (or of one line of an event stream) it reads; more is an error. |
| `client-reqwest` | `false` | With `client`: a `Reqwest` transport in `client.rs`. |
| `type-map` | none | Types the application writes itself: a map from the contract's name (`Bounds`, or `Shop::Wire::Bounds`, the namespace in front with `::` (an option's name cannot hold a dot), when more than one namespace has a type of that name: a bare name that is ambiguous is an error) to a Rust path (`crate::wire::Bounds`), or to `{ path, eq, partial-eq, inline, schema }`. The emitter writes no type for it and every reference names the path. For a model, an enum or a scalar (`Instant: String`; a mapped scalar is taken to be `Display`, and a scalar that extends it is `Eq` as its entry says, with no `Hash`); not a union, which is flattened, and not a template. With a document (`derived` or `typespec`) each must implement `utoipa::ToSchema` (and `PartialSchema`; a derive writes both): the emitter writes no schema for it, so what the document says of it is the application's, and the document matches `@typespec/openapi3` only as far as the application's schema does. The document names a schema by the type's Rust name (so a mapped type may not share a name with a type the emitter writes, which is refused, and `#[schema(as = ..)]` is not followed), and a type of another crate cannot implement `ToSchema` for you: give the entry `inline: true` when the type has a `PartialSchema` (utoipa gives one to `uuid::Uuid` and the `chrono` and `time` types with its features: the schema is then written in place, in a field and in a body, with no component). `inline` is for a field (in a model, a list or optional) and for a required parameter; a body, an answer, an optional or list parameter, a field with a constraint or example, and a scalar over it are refused, since utoipa asks `ToSchema` of them (a list or a map of it, `model Tokens is Token[]`, is not: its schema is written by hand). A type of another crate that has neither (`webauthn_rs_proto::CreationChallengeResponse`) takes `schema: contract`: the document is written from the contract's model, enum or scalar of that name, by a type of `types.rs` that implements what utoipa asks, so the type needs no trait of utoipa, and it is a field, a list, a body, an answer or a parameter, required or not. `partial-eq: false` says the type is not `PartialEq` (these usually are not), and no type that holds it derives it either. With `schema: contract` (and `inline: true`), a scalar that extends such a type is refused, and with `schema: contract` so is an event that holds one; a list or a map of one (`model Tokens is Token[]`) works, and its schema is written by hand. Or wrap it in a type of your own (`#[serde(transparent)]`) and map that. A path that names no component (a primitive, `String`, a `std` type, a generic type) is written in place from its own `PartialSchema`, which it must implement (utoipa does for the primitives, `String`, `Vec`, maps, `Option` and `Box`; not for `IpAddr`, `Duration` or a `PathBuf`: wrap those); any other path is a component and needs `ToSchema`. A mapped model in an untagged union is the variant named by its type (`Limits`), not its path. With `document: none` no utoipa is used. An optional field of a mapped type is a plain `Option` of it. A name no type of the contract has is an error. |
| `extension-expr` | none | Extensions of an operation the application reads at compile time: an extension's name (`x-guard`) to `{ macro, type, const, accessor, required }`. Each operation that states it gets `pub const <const>: <type> = <macro>!(<its JSON>);` in its module, and `Operation` a `const fn <accessor>(&self)` returning a reference to it (`Option<&'static T>`, or `&'static T` when `required`: an operation without it fails the emit). The macro is yours: it matches the JSON as tokens (`"none"`, `{"scope": "read"}`), and a value it does not accept stops your build at that token. `Route::extensions` still carries the raw JSON. |
| `require-json-content-type` | `true` | A JSON body is read only from a request whose `Content-Type` is `application/json` or `+json` (else `415`), as axum's `Json` does. |
| `untyped-responses` | `forbid` | `allow` types a response with no named shape as `serde_json::Value` instead of failing the emit. |

## What it refuses to generate

The emit fails with a diagnostic naming the type or operation, for what it cannot do faithfully:

- a response with no named shape (`untyped-responses: forbid`), and a `text/plain` body that is not a string, a number, a boolean or a scalar;
- a path parameter that is not a whole segment (`/files/{name}.json`: axum's router, `matchit`, has no parameters followed by text in a segment), or a parameter whose field collides with a generated one (`body`, `unknown`);
- a response media type other than JSON, `text/plain` or SSE, and a response without a numeric status;
- a request body that is not JSON, a file (`bytes`, `File`) or `multipart/form-data` (`text/plain`, `x-www-form-urlencoded`, XML), and the multipart cases listed under "Files and forms";
- a path parameter written with an operator (`{+path}`, `{;id}`, `{id*}`: only a plain `{name}` segment is read), a field or parameter name with no ASCII letter or digit, two response headers that become one field;
- an `@events` union whose event has no named shape, or is `text/plain` but not a string, number, boolean or scalar;
- a contract with no `@service`, and a type named `Value` or `Object`;
- `@encode` (it changes how a value is written without changing its type, which the Rust type would not follow) and `@visibility` (a model with one shape for reading and another for writing needs a struct for each, and one struct serves every operation);
- a model with properties and `...Record<T>`;
- a type named like something `types.rs` uses (`Option`, `Result`, `Vec`, `String`, `Box`, `Some`, `Ok`, ...);
- a union that includes itself, however far down;
- two operations of one name or on one route (`@sharedRoute`), an operation named like a crate the generated code uses (`std`, `axum`, ...) or `operation`, and one named with a single letter;
- a numeric enum with a member that is not a whole number;
- `@info` entries the document cannot hold.

## Known differences from @typespec/openapi3

The document is built by utoipa from the generated types, so it is not byte-for-byte `@typespec/openapi3`'s. `document: typespec` closes most of the
gap and was checked on a 241-schema contract; these remain:

- A `extends` model lists its inherited fields flat, where `@typespec/openapi3` writes `allOf`.
- A plain `enum` is a `oneOf` per member under `document: typespec` (as `enum-strategy: annotated` writes it), whatever the strategy of the other emitter.
- `utcDateTime`, `plainDate`, `bytes` and the like are strings without a `format` or `contentEncoding`.
- Only the first `@example` of a type is written.
- A map whose values may be `null` and are a named type (`Record<Pet \| null>`) holds a `NullablePet`, a component of its own.
- A model keeps the properties it lists and drops any other when it reads a value (so an empty model writes back `{}`), where the schema leaves a model open.
- A union that mixes string literals with other types (`"latest" | int32`) takes any string; a property typed as the literals alone is checked.
- A value repeated among the literals of a union or enum (`("a" | "b") | ("b" | "c")`) is one value.
- A body that nests too deep gets `400` before the `Content-Type` is looked at.
- A recursive union of structs is read by trying its variants one after another, which can cost time that doubles with each level of nesting for a body that does not fit; `max-json-depth` bounds it. Give the structs a literal property to tell them apart and the wrong variant fails at once.
- serde reads a JSON array as the fields of a struct in order, and the generated handler does not refuse one; an untagged union tries its variants in order (lists first), so the first to take a value is the one.
- Under `document: derived` a property typed as a string literal is documented as a plain string, while the type holds it to the literal; `typespec` writes the literal.
- `unknown` (any JSON) is documented as an object, though the handler takes any value.
- A property typed as one member of an enum (`Color.red`) is the enum: any member is accepted.
- Two responses with one status and media (two error bodies) are documented by the first; `anyOf` is not written.
- An `@tag` on an interface or namespace and an `@operationId` are followed; a name is `Container_operation` for an operation in an interface or a namespace of its own.
- Parameter defaults and the schemas of response headers (always a string) are not written.
- `@useAuth`, `@server` and security schemes are not carried into the document; `@tag` and `#deprecated` are.

## Not (yet) covered

There is no other web framework: `Parts` and the handler traits are plain `http`, only `run`
and `mount` are axum's. Discriminated unions (`@discriminator`) are not written specially.

## Development

```sh
bun install
just test       # build, regenerate examples/pets, run its tests (needs rustfmt and cargo)
just probes     # compile tests/probes: contracts that must be emitted and built, or refused with a named diagnostic
just check      # fail when the committed generated files are not what the emitter writes
just webauthn   # the real webauthn-rs-proto types as the bodies and answers of a generated server (needs the crate from crates.io)
just serve      # run the example
```

`examples/pets/generated` is committed so a change to the emitter shows what it does to the output.

## Changes

**0.5.0**
- A request body can be a file (`bytes`, `File`: `Input::body` is `Bytes`) or a `multipart/form-data` form (`Input::body` is a `Form` of the operation, read with axum's `Multipart`), in the server, the client and the document (written as `@typespec/openapi3` writes it). New options `max-upload-bytes`, `max-form-field-bytes`, `max-form-parts`; a contract with a form needs axum's `multipart` feature and the `bytes` crate. See "Files and forms". `UploadFile` is now a name a model of the contract may not take.

**0.4.0**
- With `document: typespec`, the document is closer to `@typespec/openapi3`'s: a nullable field or parameter is `anyOf` of its type and `null` (not a list of types), a `uint32` (or `uint8`, `uint64`) field or parameter has its exact format and its stated limits, literals of one kind are one `enum`, an enum follows the new `enum-strategy` option, a response header is required or a list as the contract says, and a template instance that holds itself refers to its own component.
- With `document: typespec`, what utoipa cannot hold is put into the finished document as the contract states it: a keyword beside `anyOf` or a `$ref` (a `minimum`, a `default`), a type of the application's whose schema is the contract's, an annotated enum, a closed model (`unevaluatedProperties: {not: {}}`), and an empty list of parameters. On Ruex's contract the Served documents then equal the independent `@typespec/openapi3` documents, which is what its comparison gate asks.
- `schema: contract` on a type of the `type-map` that is a primitive (`Instant: String`) keeps the primitive as the Rust type and gives the document the scalar's own component, which fields of it (a list, a nullable one) refer to.
- **Breaking:** with a document, a template is one generic struct, as it is without one (`Envelope<Pet>`), and each instance has its own schema type, so the application names `Envelope<T>` once under every `document`. 0.3.0 wrote a struct for each instance under a document (`EnvelopeOfPet`). The schema of an instance is written from the contract in `derived` mode too (nullable fields as `anyOf`, literals as `enum`), where the derive wrote it before.

**0.3.0**
- `type-map` works with a document (`derived` or `typespec`): each mapped type implements `utoipa::ToSchema`, or has `inline: true` and a `PartialSchema`, or has `schema: contract` and needs no trait of utoipa at all (a type of another crate, such as the WebAuthn ones). `partial-eq: false` for a type that is not `PartialEq`.
- **Breaking:** a type of the `type-map` that is a member of an untagged union is the variant named by its type (`Limits`), where it was named by its whole path (`CrateHandLimits`).

**0.2.1**
- A body that does not decode is refused with the first of `400`, `422`, `401` the operation lists as a JSON answer; a refusal with no body or a `text/plain` one is not counted.

## License

Licensed under either of [Apache License 2.0](LICENSE-APACHE) or [MIT license](LICENSE-MIT) at your option.
