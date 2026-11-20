import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
scalar Slug extends string;
@minLength(2) @maxLength(9) @pattern("^[a-z]+$") scalar ShortSlug extends Slug;
scalar Money extends float64;
scalar Price extends Money;
model Out { s: ShortSlug; p: Price }
@route("/o") @get op get_o(): Out;
