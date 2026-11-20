import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union A { string, (A | int32)[] }
union B { string, Record<B | null> }
model Req { a: A; b: B }
@route("/a") @post op post_a(@body body: Req): Req;
