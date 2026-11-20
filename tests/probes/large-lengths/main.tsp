import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { @maxLength(4294967296) a: string; @minLength(0) b: string }
@route("/o") @get op get_o(): Out;
