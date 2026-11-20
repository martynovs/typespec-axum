import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union Mixed { string, int32, null }
model Item { v?: string | int32 | null; m?: Mixed; w?: string | null }
@patch @route("/i") op patch_item(@header contentType: "application/merge-patch+json", @body item: MergePatchUpdate<Item>): Item;
