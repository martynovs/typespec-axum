import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Pet { name: string }
model Tags is string[];
union Mixed { Pet, Tags }
union Names { string[], null }
union Mixed2 { Pet, Names }
model Holder { a: Mixed; b: Mixed2 }
@route("/x") @post op doit(@body body: Holder): Holder;
