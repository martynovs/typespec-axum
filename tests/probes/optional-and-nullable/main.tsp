import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Item { note?: string | null; age?: uint8 | null; ok?: boolean }
@patch @route("/i") op patch_item(@header contentType: "application/merge-patch+json", @body item: MergePatchUpdate<Item>): Item;
