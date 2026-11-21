import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@route("/c") @get op get_c(@cookie session: string, @cookie theme?: string, @cookie("X-Visitor") visitor?: string): Out;
