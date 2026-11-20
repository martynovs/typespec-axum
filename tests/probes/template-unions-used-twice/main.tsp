import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union Maybe<T> { T, string }
model Req { a: Maybe<int32>; b: Maybe<boolean> }
@route("/x") @post op doit(@body body: Req): Req;
