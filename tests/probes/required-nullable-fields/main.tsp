import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Strict { x: string | null; y: int32 }
model Page { list: string[] | null }
model Dict is Record<int32>;
union Either { Page, Dict }
@route("/a") @post op post_it(@body body: Strict): Either;
