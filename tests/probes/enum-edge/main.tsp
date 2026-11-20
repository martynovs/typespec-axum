import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
enum Sparse { a: 1, b: 2, c: 9007199254740991, d: -9007199254740991 }
model E { s: Sparse }
@route("/e") @get op get_e(): E;
