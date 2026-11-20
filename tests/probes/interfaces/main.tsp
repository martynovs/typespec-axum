import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Item { a: string }
interface Pets { @route("/pets") @get list(): Item; }
interface Owners { @route("/owners") @get list(): Item; }
