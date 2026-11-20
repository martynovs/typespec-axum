import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
model R { @statusCode _: 200; @header("X-A-B") one: string; @header("X_A_B") two: string; @body body: Out }
@route("/h") @get op get_h(): R;
