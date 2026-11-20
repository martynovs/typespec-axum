import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
/**
 * Tilde fences and a language:
 *
 * ~~~
 * let x = 1 +
 * ~~~
 *
 * ```rust
 * let y = 2 +
 * ```
 */
model Out { v: string }
@route("/o") @get op get_o(): Out;
