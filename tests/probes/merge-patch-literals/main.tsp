import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Item { size?: "s" | "m"; flavor?: "a" | "b" | null; shape?: "round" }
@patch @route("/i") op patch_item(@header contentType: "application/merge-patch+json", @body item: MergePatchUpdate<Item>): Item;
