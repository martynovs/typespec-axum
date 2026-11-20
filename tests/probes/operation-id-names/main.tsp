import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@operationId("get-pet") @route("/a") @get op one(): Out;
@operationId("pets.list") @route("/b") @get op two(): Out;
@operationId("list pets") @route("/c") @get op three(): Out;
@operationId("1abc") @route("/d") @get op four(): Out;
