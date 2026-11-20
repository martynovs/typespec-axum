import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model pet { a: string }
model other { p?: pet }
@route("/o") @get op get_o(@body b: pet): other;
