import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace `my-svc`;
@route("/1") @get op ab(): string;
