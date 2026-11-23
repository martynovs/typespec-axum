import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@route("/m") @post op upload(@header contentType: "multipart/mixed", @multipartBody body: [HttpPart<string, #{ name: "a" }>]): Out;
