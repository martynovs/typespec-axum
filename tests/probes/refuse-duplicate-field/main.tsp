import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model U { userId: string; user_id: string }
@route("/u") @get op u(): U;
