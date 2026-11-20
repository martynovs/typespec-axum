import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union LitC { ("a" | "b"), "d" }
union LitA { "c", ("a" | "b"), null }
model W<T> { v: T }
model Holder { a: LitC | null; b?: LitC | null; c: W<LitC | null>; d: LitA; e?: LitA }
@route("/x") @post op doit(@body body: Holder): Holder;
