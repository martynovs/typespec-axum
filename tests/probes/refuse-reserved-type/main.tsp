import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Result { score: int32 }
@route("/r") @get op r(): Result;
