import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Cat { kind: "cat"; name: string }
model Dog { kind: "dog"; name: string; tag?: "a" | "b" }
union Pet { cat: Cat, dog: Dog }
@route("/p") @post op put_pet(@body pet: Pet): Pet;
