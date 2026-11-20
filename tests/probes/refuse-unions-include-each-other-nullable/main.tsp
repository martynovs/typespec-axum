import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union U { string, V }
union V { U, null }
model Req { u: U }
@route("/x") @post op doit(@body body: Req): Req;
