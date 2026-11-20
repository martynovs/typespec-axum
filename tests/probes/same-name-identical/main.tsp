import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
model Common { v: string }
@service namespace A { model Out { v: string } @route("/a") @get op get_a(): Out; }
@service namespace B { model Out { v: string } @route("/b") @get op get_b(): Out; }
