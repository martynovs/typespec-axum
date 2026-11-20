import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Pet { id: string; n?: int32 }
model Wrap<T> { items: T[] }
@route("/a") @get op pick_id(): PickProperties<Pet, "id">;
@route("/b") @get op pick_n(): PickProperties<Pet, "n">;
@route("/c") @get op wrap_a(): Wrap<{a: string}>;
@route("/d") @get op wrap_b(): Wrap<{b: int32}>;
