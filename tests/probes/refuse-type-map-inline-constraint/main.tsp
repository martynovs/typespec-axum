import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
scalar Token extends string;
model Holder { @minLength(8) token: Token }
@route("/t") @get op get_t(): Holder;
