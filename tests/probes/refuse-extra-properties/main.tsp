import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Bag { name: string; ...Record<string> }
@route("/b") @get op b(): Bag;
