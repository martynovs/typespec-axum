import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union Status { "on", "off", null }
union Single { "only", null }
model S { s: Status; one: Single; maybe?: Status }
@route("/s") @get op get_s(): S;
