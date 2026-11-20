import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@route("/c") @post op post_c(@header contentType: "application/json", @body body: Out): Out;
