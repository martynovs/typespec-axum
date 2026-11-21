import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
@extension("x-guard", "none") @route("/a") @get op open(): Out;
@extension("x-guard", #{ scope: "read", binds: "account" }) @route("/b") @get op read(): Out;
@extension("x-guard", #{ scope: #["deposit", "withdraw"] }) @route("/c") @get op money(): Out;
@route("/d") @get op forgotten(): Out;
