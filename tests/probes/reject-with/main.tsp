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
