import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Pet { name: string; age?: int32 }
model Page { items: Pet[]; next?: string }
/** Only the template names it. */
model Problem { @minLength(3) code: string }
/** What every answer is. */
model Envelope<T> {
  /** The outcome. */
  status: "ok" | "failed";
  data: T;
  message?: string;
  problem?: Problem;
}
model Holder { pets: Envelope<Pet>; many: Envelope<Pet[]>[]; maybe?: Envelope<Page> }
@route("/p") @get op get_pet(): Envelope<Pet>;
@route("/l") @get op list(): Envelope<Pet[]>;
@route("/c") @post op create(@body body: Envelope<Page>): Envelope<Page>;
@route("/h") @get op hold(): Holder;
@route("/s") @get op by_string(): Envelope<string>;
@route("/u") @get op by_time(): Envelope<utcDateTime>;
