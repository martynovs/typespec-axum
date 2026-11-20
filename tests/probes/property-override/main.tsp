import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Base { kind: string; extra: string }
model Child extends Base { kind: "child"; more: int32 }
@route("/c") @get op get_c(): Child;
