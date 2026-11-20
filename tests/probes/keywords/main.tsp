import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Links { self: string; gen: string; crate: string; super: string; type: string; `fn`?: string }
enum Sort { `-created`: "-created", created: "created", `self`: "self" }
@route("/l") @get op `move`(@query sort?: Sort): Links;
