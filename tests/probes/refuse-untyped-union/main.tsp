import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Cat { meow: string }
model Dog { woof: string }
@route("/a") @get op a(): Cat | Dog;
