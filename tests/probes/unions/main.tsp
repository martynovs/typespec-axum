import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union Status { "active", "inactive" }
union Mixed { string, int32, null }
union Pair { a: string, b: int32 }
model W { s: Status; m: Mixed; p: Pair; ps: Pair[]; opt?: string | null; }
@route("/w") @get op get_w(): W;
