import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Pet { name: string }
model Ok200 { @statusCode _: 200; @header("X-Rate-Limit") rate: string; @header("x-next") next?: string; @body body: Pet; }
@route("/a") @get op get_a(@header("x-tags") tags: string[], @header("x-count") count: int32): Ok200;
@route("/o") @put op put_opt(@body body?: Pet): void;
@route("/q") @get op arrays(@query tags: string[], @query(#{explode:false}) csv: string[]): void;
