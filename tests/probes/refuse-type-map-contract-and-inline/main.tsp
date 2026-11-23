import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Wire { a: string }
scalar Stamp extends string;
model Holder { w: Wire; s: Stamp }
@route("/t") @get op get_t(): Holder;
