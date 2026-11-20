import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@sharedRoute @route("/s") @get op one(): Out;
@sharedRoute @route("/s") @get op two(): Out;
