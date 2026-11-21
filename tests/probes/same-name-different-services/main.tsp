import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;

@service namespace Probe { model Item { a: string } @route("/a") @get op get_a(): Item; }
@service namespace Other { model Item { b: int32 } @route("/b") @get op get_b(): Item; }
