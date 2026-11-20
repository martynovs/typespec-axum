import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
enum E { @doc("x") a, @doc("y") A }
union U { @doc("1") `a-b`: string, @doc("2") a_b: int32 }
model Req { e: E; u: U }
@route("/x") @post op doit(@body body: Req): Req;
