import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
model Form { name: HttpPart<string>; }
@route("/m") @post op upload(@header contentType: "multipart/form-data", @multipartBody body: Form): Out;
