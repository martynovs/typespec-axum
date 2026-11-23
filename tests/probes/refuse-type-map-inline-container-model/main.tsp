import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
scalar Token extends string;
model Tokens is Token[];
model Holder { t: Tokens }
@route("/t") @get op get_t(): Holder;
