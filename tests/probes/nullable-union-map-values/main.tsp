import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Pet { n: string }
union MaybePet { Pet, null }
union Lit { "a", "b", null }
model H { e: Record<MaybePet | null>; l: Record<Lit | null> }
@route("/x") @post op doit(@body body: H): H;
