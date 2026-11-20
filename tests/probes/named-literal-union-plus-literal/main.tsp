import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union Kinds { "a", "b" }
union K2 { Kinds, "x" }
model Pet { name: string; kind: Kinds | "x"; k2: K2 }
model Dog { name: string; kind: "dog"; k2: "a" }
union Any { Pet, Dog }
model Req { v: Any }
@route("/x") @post op doit(@body body: Req): Req;
