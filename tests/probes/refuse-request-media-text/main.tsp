import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@route("/t") @post op txt(@header contentType: "text/plain", @body body: string): Out;
