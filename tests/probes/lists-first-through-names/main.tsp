import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Foo { a?: int32 }
model L is U[];
union U { Foo, L }
union V { string, int32[] }
union W { Foo, V }
model Req { l: L; w: W }
@route("/x") @post op doit(@body body: Req): Req;
