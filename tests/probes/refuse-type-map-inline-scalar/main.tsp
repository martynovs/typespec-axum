import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
scalar Token extends string;
scalar Token2 extends Token;
model Holder { t: Token2 }
@route("/t") @get op get_t(): Holder;
