import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
model Out { v: string }
@service namespace Axum { @route("/x") @get op get_x(): Out; }
