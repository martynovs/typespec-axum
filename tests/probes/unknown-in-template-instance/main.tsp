import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Env<T> { first: T; }
union U { Env<unknown>, string }
model Holder { u: U; m: Record<Env<unknown> | null>; l: unknown[]; o?: unknown }
@route("/x") @post op doit(@body body: Holder): { @statusCode _: 204 };
