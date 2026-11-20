import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
@maxValue(3000000000) scalar Size extends int64;
model H { @maxValue(5000000000) other: int64; count: int64 = 3000000000; @example(4000000000) ex?: int64; @maxValue(18446744073709551615) u: uint64; @maxValue(1e30) f: float64; size: Size }
@route("/h") @get op get_h(): H;
