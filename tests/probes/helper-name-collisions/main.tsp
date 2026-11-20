import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model M { cD: "a"; cd: "b"; u: uint8; w: uint8 }
model A_b { c: "x" }
model A { b_c: "y" }
model Box<T> { v: T }
model Out { m: M; x: A_b; y: A; p: Box<uint32>; q: Box<uint8>; r: Box<int16> }
@route("/o") @get op get_o(): Out;
