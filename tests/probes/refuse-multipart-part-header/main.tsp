import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@route("/m") @post op upload(@header contentType: "multipart/form-data", @multipartBody body: { doc: HttpPart<{ @header("x-sum") sum: string; @body body: File }> }): Out;
