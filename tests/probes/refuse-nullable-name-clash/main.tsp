import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Pet { n: string }
model NullablePet { x: int32 }
model M { a: Record<Pet | null>; b: NullablePet }
@route("/m") @get op get_m(): M;
