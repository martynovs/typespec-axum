import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@tag("a") @tag("b") @route("/a") @get op get_a_thing(): Out;
#deprecated "use get_a_thing"
@route("/b") @get op get_b_thing(): Out;
