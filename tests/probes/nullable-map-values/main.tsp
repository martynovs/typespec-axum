import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
enum Color { red, green }
union Mode { "a", "b", null }
model Pet { n: string }
model Item { pets: Record<Pet | null>; colors: Record<Color | null>; modes: Record<Mode>; plain: Record<string | null> }
@route("/i") @post op post_item(@body item: Item): Record<Pet | null>;
