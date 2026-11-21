# typespec-axum

[![CI](https://github.com/martynovs/typespec-axum/actions/workflows/ci.yml/badge.svg)](https://github.com/martynovs/typespec-axum/actions/workflows/ci.yml)

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
- **Answers are typed.** A handler returns the operation's `Answer` (a body, headers and a status the contract lists) or refuses with a
  `Refused`, which is a response of its own. A response with no named shape fails the emit rather than becoming `serde_json::Value`.
- **The document is the contract's.** `document()` returns the OpenAPI 3.2 document, checked against `@typespec/openapi3`'s own output
  from the same contract (see [`examples/pets`](examples/pets/tests/api.rs)). With `document: typespec` it follows that output more closely still (see [Known differences](#known-differences-from-typespecopenapi3)).

## Quick start

```sh
npm install --save-dev @martynovs/typespec-axum @typespec/compiler @typespec/http @typespec/openapi @typespec/streams @typespec/events
```

```yaml
# tspconfig.yaml
emit:
  - "@martynovs/typespec-axum"
options:
  "@martynovs/typespec-axum":
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
| `model` | `struct` (`#[serde(rename = ...)]`, snake_case fields, `r#` for keywords); `name?: T` is `Option<T>` that is absent, never `null`; `name?: T \| null` is `Option<Option<T>>`, `None` for absent and `Some(None)` for `null`; `extends` copies the base's fields into the struct (the document lists them flat, where `@typespec/openapi3` writes `allOf`) |
| `enum` | string: `enum` with `rename`; numeric: `#[repr(i64)] enum` with the contract's numbers, `wire()` |
| `union` | `#[serde(untagged)] enum`; `T \| null` is `Option<T>`; a union that is a variant of another is flattened into it (`union B { A, int32 }` has the variants of `A` and `int32`), so no enum holds an enum (a named union of string literals is a string enum of its own, and a variant of a union that also has other types, or the same literals spread into one that has only literals); a union nothing names (`string \| int32`) is one too, numbered (`Anon3`); the document inlines it for a property and refers to it as a component everywhere else. A property typed as a string literal (`kind: "cat"`, or `"a" \| "b"`, with or without `?` and `\| null`) accepts only those values, so an untagged union of models picks its variant by it; a named union of string literals and `null` is a string enum in an `Option`. Numeric and boolean literals (`kind: 1`) are not checked |
| `decimal`, `decimal128` | `Decimal`, a newtype over `serde_json::Number` written as a JSON number (exact with serde_json's `arbitrary_precision` feature; a float without it); a component `Decimal` of the document |
| `scalar X extends string` | `struct X(pub String)`, so the document keeps the name |
| `T[]`, `Record<T>` | `Vec<T>`, `BTreeMap<String, T>` (a named `model X is Record<T>` is a newtype) |
| `int8` ... `uint64`, `float32/64` | `i8` ... `u64`, `f32/f64` (`format` kept: `uint32` stays `uint32` in the document) |
| `@minValue`, `@maxValue`, `@minLength`, `@maxLength`, `@pattern`, `@example`, `@doc`, `@summary` | in the document, and as [constants](#constants) |
| `@cookie` | an `Option<String>` of `Input`: the first cookie of that name in the request's `Cookie` headers, without quotes (an array is refused: a cookie holds one value) |
| `@path` / `@query` / `@header` | `Input` fields: `String`, `Option<String>`; `Vec<String>` for an array: a query with `explode: true` is one pair per value, without it one comma-separated pair; a header array is every value of the header, comma-split |
| `@body` | `Input::body`, decoded as JSON (`Option<T>` for `body?`, absent when empty). The request must say it is JSON (`415` otherwise; see `require-json-content-type`). A body that does not decode is refused with the `400` (else `422`) the operation lists, or with axum's own rejection when it lists neither |
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
| `max-query-bytes` | `4096` | A longer query string is refused with `400` before it is parsed. |
| `max-query-pairs` | `64` | So are more `&`-separated pairs. |
| `max-json-depth` | `32` | A JSON body that nests deeper (`{` and `[` outside strings) is refused with `400` before it is parsed. |
| `document` | `derived` | `derived`: the document is what utoipa's derives write. `typespec`: schemas written by hand to follow `@typespec/openapi3` more closely (enums as `oneOf` per member when `enum-strategy: annotated`, `format: uint8`, ...). |
| `require-json-content-type` | `true` | A JSON body is read only from a request whose `Content-Type` is `application/json` or `+json` (else `415`), as axum's `Json` does. |
| `untyped-responses` | `forbid` | `allow` types a response with no named shape as `serde_json::Value` instead of failing the emit. |

## What it refuses to generate

The emit fails with a diagnostic naming the type or operation, for what it cannot do faithfully:

- a response with no named shape (`untyped-responses: forbid`), and a `text/plain` body that is not a string, a number, a boolean or a scalar;
- a path parameter that is not a whole segment (`/files/{name}.json`: axum's router, `matchit`, has no parameters followed by text in a segment), or a parameter whose field collides with a generated one (`body`, `unknown`);
- a response media type other than JSON, `text/plain` or SSE, and a response without a numeric status;
- a request body that is not JSON (`text/plain`, form, XML, multipart, `bytes`);
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

There is no client, and no other web framework: `Parts` and the handler traits are plain `http`, only `run`
and `mount` are axum's. Discriminated unions (`@discriminator`) are not written specially.

## Development

```sh
bun install
just test       # build, regenerate examples/pets, run its tests (needs rustfmt and cargo)
just probes     # compile tests/probes: contracts that must be emitted and built, or refused with a named diagnostic
just check      # fail when the committed generated files are not what the emitter writes
just serve      # run the example
```

`examples/pets/generated` is committed so a change to the emitter shows what it does to the output.

## License

Licensed under either of [Apache License 2.0](LICENSE-APACHE) or [MIT license](LICENSE-MIT) at your option.
