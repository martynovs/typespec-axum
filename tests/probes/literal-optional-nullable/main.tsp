import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model L { kind?: "cat" | null; t?: "a" | "b"; u: "x" | null }
@route("/l") @post op put_l(@body l: L): L;
