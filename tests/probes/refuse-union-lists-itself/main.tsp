import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union Animal { Animal, int16, string }
model M { a: Animal }
@route("/m") @get op get_m(): M;
