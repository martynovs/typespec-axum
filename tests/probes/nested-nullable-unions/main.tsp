import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union Maybe { string, null }
union B { Maybe, int32 }
model Holder { b?: B; c?: Maybe; d: B }
@route("/h") @post op post_it(@body body: Holder): Holder;
