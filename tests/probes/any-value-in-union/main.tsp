import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
// A body may hold any JSON (`unknown`), and a union may have it as a variant; the document must still build.
model Anything { a: string | unknown; b: float32[] | unknown; c?: unknown }
@route("/a") @post op post_anything(@body body: Anything): Out;
