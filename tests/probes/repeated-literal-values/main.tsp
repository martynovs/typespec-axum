import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union Mode { ("a" | "b"), ("b" | "c") }
union Other { a: "a", b: "a", c: "c" }
model Req { m: Mode; o: Other }
@route("/a") @post op post_a(@body body: Req): Req;
