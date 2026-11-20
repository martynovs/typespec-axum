import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union A { string, B }
union B { int32, A }
model Req { a: A }
@route("/x") @post op doit(@body body: Req): Req;
