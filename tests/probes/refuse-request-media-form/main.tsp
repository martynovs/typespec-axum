import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
model F { a: string }
@route("/f") @post op form(@header contentType: "application/x-www-form-urlencoded", @body body: F): Out;
