import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model M { amount: decimal }
@route("/m") @get op m(): M;
