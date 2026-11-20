import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Bag<T> is Record<T>;
union U { int32, Bag<unknown> }
model Req { u: U; m: Record<Bag<unknown> | null> }
@route("/x") @post op doit(@body body: Req): { @statusCode _: 204 };
