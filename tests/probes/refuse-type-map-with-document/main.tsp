import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
scalar Instant extends string;
enum Color { red, green }
model Limits { ...Record<never>; max?: string | null; min?: string | null; }
model Bounds { ...Record<never>; price?: Limits; }
model Minted { secret: string }
model Item {
  at: Instant;
  color: Color;
  bounds?: Bounds;
  limits: Limits;
  many: Limits[];
  by_name: Record<Limits>;
  minted?: Minted | null;
  note: string;
}
@route("/i") @post op make(@body body: Item, @query since?: Instant): Item;
@route("/t") @get op stamp(): { @header("content-type") ct: "text/plain"; @body body: Instant; };
