import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
model Out { v: string; }
@service(#{title:"One"}) namespace Probe { @tag("alpha") @route("/z") @get op bar(): Out; }
@service(#{title:"Two"}) namespace Two { @tag("beta") @route("/z") @get op bar(): Out; }
