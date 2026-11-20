import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Bag<T> is Record<T>;
model Pair<T> { third?: Bag<T> | null }
model Line { v2: Pair<int32> | string }
@route("/a") @get op get_line(): Line;
