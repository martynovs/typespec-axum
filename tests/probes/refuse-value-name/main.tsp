import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Value { a: string }
@route("/o") @get op get_o(): Value;
