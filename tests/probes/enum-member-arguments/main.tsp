import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
enum A { red, blue }
enum B { red, blue }
model Wrap<T> { v: string }
model Out { a: Wrap<A.red>; b: Wrap<B.red> }
@route("/o") @get op get_o(): Out;
