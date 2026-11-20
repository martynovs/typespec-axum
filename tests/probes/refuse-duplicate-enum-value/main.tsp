import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
enum E { a: 1, b: 2, c: 1 }
model M { e: E }
@route("/m") @get op get_m(): M;
