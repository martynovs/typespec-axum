import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Pet { n: string }
model ErrA { a: string }
model ErrB { b: string }
@route("/f") @get op get_f(): Pet | { @statusCode _: 404; @body body: ErrA } | { @statusCode _: 404; @body body: ErrB };
