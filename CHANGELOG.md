# Changes

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
