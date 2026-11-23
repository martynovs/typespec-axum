import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
scalar Token extends string;
/** With no document there is no `ToSchema` to ask for: `inline` changes nothing, and a body, an answer, an optional or list parameter are as usual. */
@route("/t") @post op put_t(@header contentType: "application/json", @body body: Token, @query ids?: Token[], @header x_token?: Token): Token[];
