import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Ids is string[];
model Out { v: string }
@route("/q") @get op get_q(@query(#{explode: true}) g?: Ids, @query e?: Ids, @header i?: Ids): Out;
