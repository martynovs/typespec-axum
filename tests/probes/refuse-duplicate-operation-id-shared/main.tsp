import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
model Out { v: string }
@service(#{title:"A"}) namespace Probe { @route("/a") @get op foo(): Out; }
@service(#{title:"B"}) namespace B { @route("/a") @get op foo(): Out; @operationId("foo") @route("/b") @get op bar(): Out; }
