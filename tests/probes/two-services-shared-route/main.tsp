import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
model Out { v: string; }
interface Health { @route("/health") @get health(): Out; }
@service(#{title:"Public"}) namespace Probe { interface H extends Health {} @route("/pub") @get op pubop(): Out; }
@service(#{title:"Admin"}) namespace Admin { interface H extends Health {} }
