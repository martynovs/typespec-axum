import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
/** One line.
Another line after a carriage return. */
model Out { @doc("Quoted \"text\"\r\nmore") v: string }
@route("/o") @get op get_o(): Out;
