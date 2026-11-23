import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
scalar Token extends string;
@route("/t") @post op put_t(@header contentType: "application/json", @body body: Token): void;
