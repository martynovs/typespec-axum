import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Limits { max?: string }
model Bounds { min?: string }
model Item { a: Limits; b: Bounds }
@route("/i") @get op get_i(): Item;
