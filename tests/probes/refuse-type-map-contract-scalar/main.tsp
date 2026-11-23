import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
scalar Wire2 extends string;
scalar Wire3 extends Wire2;
model Holder { w: Wire3 }
@route("/t") @get op get_t(): Holder;
