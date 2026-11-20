import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@route("/pets/{petId}") @get op get_pet(@path petId: string): Out;
@route("/pets/{id}") @delete op delete_pet(@path id: string): Out;
