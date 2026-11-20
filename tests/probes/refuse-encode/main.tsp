import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Pet { @encode("unixTimestamp", int64) created: utcDateTime }
@route("/p") @get op p(): Pet;
