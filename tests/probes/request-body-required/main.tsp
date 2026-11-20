import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Pet { n: string }
model Out { v: string }
@route("/a") @post op post_optional(@body body?: Pet): Out;
@route("/b") @post op post_nullable(@body body: Pet | null): Out;
@route("/c") @post op post_plain(@body body: Pet): Out;
