import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union Json { string, float64, boolean, (Json | null)[], Record<Json | null> }
model Req { j: Json }
@route("/a") @post op post_a(@body b: Req): Req;
