import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
enum Sort { `-created`: "-created", created: "created" }
enum Level { low: 1, high: 3000000000, neg: -3000000000 }
model E { s: Sort; l: Level }
@route("/e") @get op get_e(@query s?: Sort): E;
