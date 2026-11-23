import "@typespec/http";
import "@typespec/openapi";
import "./shared.tsp";
using Http;
using OpenAPI;
@service namespace Probe;
model Limits { x: string }
/** The mapped `Other.Limits` is reached only through a field: no operation names it. */
model Item { a: Limits; b: Other.Limits }
@route("/i") @get op get_i(): Item;
