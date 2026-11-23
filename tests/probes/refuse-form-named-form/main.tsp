import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@route("/form") @post op form(@header contentType: "multipart/form-data", @multipartBody body: { name: HttpPart<string> }): Out;
