import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Node { name: string; child?: U; }
union U { Node, string, null }
model Holder { u: U; }
@route("/x") @post op doit(@body body: Holder): Holder;
