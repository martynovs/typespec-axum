import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
namespace Shop;
model Foo { v: string }
@route("/x") @get op get_x(): Foo;
