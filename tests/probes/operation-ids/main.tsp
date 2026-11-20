import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@operationId("listAllPets") @route("/all") @get op get_all(): Out;
namespace A { @route("/a") @get op list(): Out; }
namespace B { @route("/b") @get op list(): Out; }
