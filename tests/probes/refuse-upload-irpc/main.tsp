import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
model ImageFile extends File<"image/png" | "image/jpeg"> {}

@route("/octet") @post op octet(@header contentType: "application/octet-stream", @body body: bytes): Out;
@route("/octet-image") @put op octetImage(@header contentType: "image/png" | "image/jpeg", @body body: bytes): Out;
@route("/octet-optional") @post op octetOptional(@header contentType: "application/octet-stream", @body body?: bytes): Out;
@route("/file") @post op fileAny(@bodyRoot file: File): Out;
@route("/file-image") @put op fileImage(@bodyRoot image: ImageFile): Out;
