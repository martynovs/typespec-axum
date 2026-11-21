import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
@extension("x-guard", "none") @route("/a") @get op ab(): string;
