import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
model Health { ok: boolean }
model Status { up: boolean; since: string }
@service namespace Svc1 { @route("/health") @get op health(): Health; }
@service namespace Svc2 { @route("/health") @get op health(): Status; }
