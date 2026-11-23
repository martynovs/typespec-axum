import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Limits { x: string }
namespace Wire { model Limits { max?: string } }
model Item { a: Limits; b: Wire.Limits }
@route("/i") @get op get_i(): Item;
