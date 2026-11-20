import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union A { string, X }
union X { Y, null }
union Y { A, null }
model Req { a: A }
@route("/x") @post op doit(@body body: Req): Req;
