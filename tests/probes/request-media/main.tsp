import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Item { n?: string }
@route("/a") @patch op patch_a(@header contentType: "application/merge-patch+json", @body body: MergePatchUpdate<Item>): Item;
@route("/b") @post op post_b(@header contentType: "application/json; charset=utf-8", @body body: Item): Item;
@route("/c") @post op post_c(@header contentType: "application/vnd.x+json", @body body: Item): Item;
