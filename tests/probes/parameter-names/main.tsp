import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@route("/pets/{id}") @get op get_pet(@path id: string): Out;
@route("/pets/{id}") @delete op delete_pet(@path id: string): Out;
