import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
enum Color { red, green, blue }
model M { a: Color.red; b: Color.blue | Color.red; c?: Color.green }
@route("/m") @get op get_m(): M;
