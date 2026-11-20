import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
@route("/c") @get op c(@cookie session: string): string;
