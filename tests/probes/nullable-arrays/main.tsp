import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@route("/n") @get op get_n(@query q1: string[] | null, @query q2?: string[] | null, @header h1: string[] | null): Out;
