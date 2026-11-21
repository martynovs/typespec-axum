import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Held { id: string }
model Envelope<T> { status: string; data: T }
/** Holds an Envelope of itself. */
model Node { id: string; next?: Envelope<Node> }
/** Holds an instance of itself. */
model Loop<T> { data: T; other?: Loop<string> }
@withOptionalProperties model Patch<T> { data: T; n: int32 }
model Tagged<K> { kind: K; id: string }
model Cat { kind: "cat"; id: string; meow: string }
union Pet { Tagged<"dog" | "bird">, Cat }
/** A model of the contract named like the standard Record. */
model Record<T> { id: string; data: T }
model Page<Item> { items: Item[]; total: int32 }
model Item { sku: string }
@route("/n") @get op get_node(): Node;
@route("/l") @get op get_loop(): Loop<Held>;
@route("/p") @post op patch(@body body: Patch<Held>): void;
@route("/pet") @post op add_pet(@body pet: Pet): void;
@route("/r") @get op get_record(): Record<Held>;
@route("/pg") @get op list_page(): Page<Held>;
@route("/i") @get op get_item(): Item;
