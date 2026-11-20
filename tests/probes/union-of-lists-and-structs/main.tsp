import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Inner { v?: string }
model Foo { inner?: Inner; other?: Inner }
union OneOrMany { Foo, Foo[] }
@route("/a") @post op post_it(@body body: OneOrMany): OneOrMany;
