import "@typespec/http";
import "@typespec/openapi";
import "./far.tsp";
using Http;
using OpenAPI;
@service namespace Probe;
model Holder { far?: Far | null; fars: Far[] | null }
@route("/h") @get op get_h(): Holder;
