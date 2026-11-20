import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
enum Num { a: 1.5 }
model M { n: Num }
@route("/n") @get op n(): M;
