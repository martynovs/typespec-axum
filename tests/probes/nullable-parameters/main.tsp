import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@route("/n") @get op get_n(@query q: string | null, @header h: int32 | null, @query r?: string | null): Out;
