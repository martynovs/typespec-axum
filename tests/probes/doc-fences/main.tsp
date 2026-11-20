import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
/**
 * Example:
 *
 * ```
 * let x = 1 +
 * ```
 */
model Out { v: string }
@route("/o") @get op get_o(): Out;
