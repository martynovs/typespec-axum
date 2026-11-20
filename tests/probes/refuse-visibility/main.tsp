import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Pet { @visibility(Lifecycle.Read) id: string; name: string }
@route("/p") @post op p(@body pet: Pet): Pet;
