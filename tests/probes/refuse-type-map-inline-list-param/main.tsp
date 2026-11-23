import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
scalar Token extends string;
@route("/t") @get op get_t(@query ids: Token[]): void;
