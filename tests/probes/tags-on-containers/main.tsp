import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@tag("pets") interface Pets { @route("/pets") @get list_pets(): Out; }
@tag("outer") namespace Inner { @tag("own") @route("/inner") @get op get_inner(): Out; }
