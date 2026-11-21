import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
@summary("One line\r\nTwo line")
@route("/a") @get op ab(): string;
