import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
namespace Common { model Order { id: string; items?: Record<Order | null> } }
@service(#{title:"A"}) namespace Probe { using Common; @route("/alpha") @get op alpha(): Order; }
@service(#{title:"B"}) namespace Svcb { using Common; @route("/alpha") @get op alpha(): Order; }
