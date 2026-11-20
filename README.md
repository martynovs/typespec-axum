# typespec-axum

A [TypeSpec](https://typespec.io) emitter that writes Rust straight from the contract: **serde wire types**, **axum endpoints** and the
**OpenAPI document** of the same contract, built with [utoipa](https://docs.rs/utoipa). No OpenAPI file in the middle, so
the handlers, the types and the served document cannot drift apart.

```
main.tsp ──tsp compile──▶ types.rs   serde + utoipa types, one per model, enum, union and scalar
                          axum.rs    per operation: a trait, its input and answer, the handler that reads the request, the route
```

- **The contract is the router.** Each operation becomes a trait with one method that returns the handler, or `None` when the node
  cannot serve it (the route is then not mounted). Implement the traits, call `mount`.
- **Requests are read once, without surprises.** Path parameters are read by position, the query in one pass over borrowed pairs, and
  a query over a bound is refused before it is parsed. A parameter the contract does not list is counted, never stored.
- **Answers are typed.** A handler returns the operation's `Answer` or refuses; a body, header or status the contract does not
  list cannot be written. A response with no named shape fails the emit rather than becoming `serde_json::Value`.
- **The document is the contract's.** `document()` returns the OpenAPI 3.2 document, checked against `@typespec/openapi3`'s own output
  from the same contract (see [`examples/pets`](examples/pets/tests/api.rs)).

## Quick start

```sh
npm install --save-dev typespec-axum @typespec/compiler @typespec/http @typespec/openapi @typespec/streams @typespec/events
```

```yaml
# tspconfig.yaml
emit:
  - typespec-axum
options:
  typespec-axum:
    emitter-output-dir: "{project-root}/src/generated"
```

```sh
npx tsp compile .
rustfmt --edition 2024 src/generated/types.rs src/generated/axum.rs   # the emitter leaves layout to rustfmt
```

```toml
# Cargo.toml
[dependencies]
axum = { version = "0.8", default-features = false, features = ["http1", "json", "tokio", "query", "matched-path"] }
form_urlencoded = "1"
percent-encoding = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio-stream = { version = "0.1", default-features = false }
utoipa = "6"
```

```rust
// src/lib.rs
#[path = "generated/types.rs"] pub mod types;   // `types-path` says where this is (default `crate::types`)
#[path = "generated/axum.rs"] pub mod api;
```

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

## How TypeSpec maps

| TypeSpec | Rust |
|---|---|
| `model` | `struct` (`#[serde(rename = ...)]`, snake_case fields, `r#` for keywords); `name?: T` is `Option<T>` that is absent, never `null`; `extends` copies the base's fields into the struct (the document lists them flat, where `@typespec/openapi3` writes `allOf`) |
| `enum` | string: `enum` with `rename`; numeric: `#[repr(i64)] enum` with the contract's numbers, `wire()` |
| `union` | `#[serde(untagged)] enum`; `T \| null` is `Option<T>` |
| `scalar X extends string` | `struct X(pub String)`, so the document keeps the name |
| `T[]`, `Record<T>` | `Vec<T>`, `BTreeMap<String, T>` (a named `model X is Record<T>` is a newtype) |
| `int8` ... `uint64`, `float32/64` | `i8` ... `u64`, `f32/f64` (`format` kept: `uint32` stays `uint32` in the document) |
| `@minValue`, `@maxLength`, `@pattern`, `@example`, `@doc`, `@summary` | in the document (`#[schema(..)]`, doc comments) |
| `@path` / `@query` / `@header` | `Input` fields: `String`, `Option<String>`, `Vec<String>` for a repeated query (`explode`) |
| `@body` | `Input::body`, decoded as JSON; a body that does not decode is refused with the operation's `400` (else `422`) |
| `200..=399` response | a variant of `Answer`, with a struct for the headers it sets |
| `4xx` / `5xx` response | documented, and a handler's `Err(Refused)`; never an `Answer` |
| `SSEStream<Events>` (`@typespec/sse`) | `Events`, a stream of axum `Event`s; the `@events` union becomes an enum with `From<_> for Event` |
| `@extension("x-*", v)` | `Route::extensions` and the document |

Parameters are strings on purpose: parsing `"12"` into a number, and what to do when it is not one, is the handler's, and the contract
cannot say how a refusal looks. (`Input` is where a typed layer goes.)

## Options

| Option | Default | |
|---|---|---|
| `types-path` | `crate::types` | Rust path of the module that holds `types.rs`. |
| `refusal-type` | one defined in `axum.rs` | Rust path of your own `Refused` (`IntoResponse`). The generated one wraps a `Response` and is `From<StatusCode>`. |
| `max-query-bytes` | `4096` | A longer query string is refused with `400` before it is parsed. |
| `max-query-pairs` | `64` | So are more `&`-separated pairs. |
| `untyped-responses` | `forbid` | `allow` types a response with no named shape as `serde_json::Value` instead of failing the emit. |

## What it refuses to generate

The emit fails, naming the operation, for what it cannot do faithfully: a response with no named shape (`forbid`), a path parameter that is
not a whole segment (`/files/{name}.json`), a parameter whose field collides with a generated one (`body`, `unknown`), a response media type
other than JSON, `text/plain` or SSE, a response without a numeric status, and `@info` entries the document cannot hold.

## Not (yet) covered

Request bodies are JSON only. There is no client, and no other web framework: `Parts` and the handler traits are plain `http`, only `run`
and `mount` are axum's. Discriminated unions (`@discriminator`) are not written specially.

## Development

```sh
bun install
just test       # build, regenerate examples/pets, run its tests (needs rustfmt and cargo)
just check      # fail when the committed generated files are not what the emitter writes
just serve      # run the example
```

`examples/pets/generated` is committed so a change to the emitter shows what it does to the output.

## License

Licensed under either of [Apache License 2.0](LICENSE-APACHE) or [MIT license](LICENSE-MIT) at your option.
