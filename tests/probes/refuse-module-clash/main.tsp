import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
model Out { v: string }
@service namespace A.B_C { @route("/x") @get op get_x(): Out; }
@service namespace A_B.C { @route("/y") @get op get_y(): Out; }
