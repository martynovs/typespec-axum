import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
namespace Shared { scalar Code extends string; }
model Own { v: string }
@route("/o") @get op get_o(@query code: Shared.Code): Own;
