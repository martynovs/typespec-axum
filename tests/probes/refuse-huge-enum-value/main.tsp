import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
enum E { a: 9223372036854775807 }
model M { e: E }
@route("/m") @get op get_m(): M;
