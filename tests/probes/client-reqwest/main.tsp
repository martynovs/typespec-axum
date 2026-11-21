import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@route("/c") @get op get_c(@cookie session: string, @cookie theme?: string, @cookie("X-Visitor") visitor?: string): Out;
/** A redirect is an answer, not something to follow. */
@route("/go") @get op go(): { @statusCode _: 302; @header location: string } | Out;
