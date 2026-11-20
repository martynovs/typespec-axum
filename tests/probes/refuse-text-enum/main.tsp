import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
enum Color { red, green }
@route("/c") @get op c(): { @header contentType: "text/plain"; @body b: Color };
