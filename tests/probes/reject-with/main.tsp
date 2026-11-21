import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Item { n: int32 }
model Failure { code: int32 }
/** Lists 400. */
@route("/a/{id}") @post op list_400(@path id: string, @query q?: string, @body body: Item): Item | { @statusCode _: 400; @body body: Failure };
/** Lists 422 and 401: 422 comes first. */
@route("/b") @post op list_422(@body body: Item): Item | { @statusCode _: 401; @body body: Failure } | { @statusCode _: 422; @body body: Failure };
/** Lists 401 only. */
@route("/c") @post op list_401(@body body: Item): Item | { @statusCode _: 401; @body body: Failure };
/** Lists none. */
@route("/d") @post op list_none(@body body: Item): Item;
/** Lists a plain-text 400 and 413 (axum's own, for a body it cannot read) and a JSON 401: the 401 is what a body that does not decode is refused with. */
@route("/e") @post op list_text_and_401(@body body: Item): Item | { @statusCode _: 400; @header contentType: "text/plain"; @body body: string } | { @statusCode _: 413; @header contentType: "text/plain"; @body body: string } | { @statusCode _: 401; @body body: Failure };
/** Lists only a plain-text 400: no JSON refusal, so a body that does not decode keeps axum's own answer. */
@route("/f") @post op list_text_400(@body body: Item): Item | { @statusCode _: 400; @header contentType: "text/plain"; @body body: string };
/** Lists a bare 400 (no body) and a JSON 401: the bare 400 declares no JSON answer, so the 401 is the status. */
@route("/g") @post op list_bare_400_and_401(@body body: Item): Item | { @statusCode _: 400 } | { @statusCode _: 401; @body body: Failure };
/** Lists only a bare 400: no JSON refusal, so a body that does not decode keeps axum's own answer. */
@route("/h") @post op list_bare_400(@body body: Item): Item | { @statusCode _: 400 };
