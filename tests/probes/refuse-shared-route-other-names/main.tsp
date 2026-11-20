import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
model Out { v: string; }
@service(#{title:"Public"}) namespace Probe { @route("/health") @get op health(): Out; }
@service(#{title:"Admin"}) namespace Admin { interface Svc { @route("/health") @get health(): Out; } }
