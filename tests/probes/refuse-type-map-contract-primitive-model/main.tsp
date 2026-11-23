import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Wire { a: string }
@route("/t") @get op get_t(): Wire;
