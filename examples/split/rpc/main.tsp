import "@typespec/http";
import "@typespec/openapi";
import "@typespec/streams";
import "@typespec/sse";
import "@typespec/events";
import "../common/main.tsp";

using Http;
using SSE;
using Events;
using Shop.Common;

/** The inside API: what the shop's own services call over irpc (QUIC), with the same typed requests and answers. */
@service(#{ title: "Shop rpc" })
namespace Shop.Rpc;

model Gone {
  @statusCode _: 404;
  @body body: { message: string };
}

/** A change to the stock. */
@events
union StockEvent {
  added: Item,
  removed: string,
}

@route("/stock") @post op reserve(@body item: NewItem): { @statusCode _: 200; @body body: Item } | Gone;
@route("/stock/{id}") @get op stock(@path id: string): Item | Gone;
@route("/stock/events") @get op follow(): SSEStream<StockEvent>;
