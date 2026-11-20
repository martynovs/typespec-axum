import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
@route("/m") @get op multi(): { @statusCode _: 207; @body b: string[] } | { @statusCode _: 302; @header location: string; } | { @statusCode _: 304; };
