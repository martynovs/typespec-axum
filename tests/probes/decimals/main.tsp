import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
scalar Price extends decimal;
@minValue(0) scalar Cheap extends decimal;
model Item { amount: decimal; maybe?: decimal; nullable: decimal | null; list: decimal[]; by: Record<decimal>; price: Price; cheap?: Cheap; big: decimal128 }
@route("/i") @post op post_i(@body item: Item, @query rate?: decimal): Item;
@route("/p") @get op get_p(): decimal;
