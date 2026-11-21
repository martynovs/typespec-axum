import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;

@service namespace Probe {
  namespace Shop { model Item { sku: string } }
  namespace Depot { model Item { bin: int32; weight?: float64 } }
  model Out { shop: Shop.Item; depot: Depot.Item; both: Depot.Item[] }
  @route("/o") @get op get_o(): Out;
}
