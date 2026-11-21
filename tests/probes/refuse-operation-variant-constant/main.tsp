import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
@route("/1") @get op a_b(): string;
@route("/2") @get op ab(): string;
