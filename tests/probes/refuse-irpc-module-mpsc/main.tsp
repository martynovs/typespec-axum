import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Mpsc;
@route("/a") @get op ab(): string;
