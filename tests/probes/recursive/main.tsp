import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Tree { children: Tree[]; parent?: Tree; next?: Tree[] }
model A { b?: B }
model B { a?: A }
@route("/t") @get op get_t(): Tree;
@route("/a") @get op get_a(): A;
