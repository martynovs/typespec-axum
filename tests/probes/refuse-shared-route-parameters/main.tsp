import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
model Out { v: string }
model NotFound { @statusCode _: 404; @body body: Out }
model Gone { @statusCode _: 410; @body body: Out }
@service(#{title:"A"}) namespace Probe { @route("/x") @get op get_x(@query @minValue(1) q: int32): Out | NotFound; }
@service(#{title:"B"}) namespace B { @route("/x") @get op get_x(@query q: string): Out | Gone; }
