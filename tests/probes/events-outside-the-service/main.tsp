import "@typespec/http";
import "@typespec/openapi";
import "@typespec/streams";
import "@typespec/sse";
import "@typespec/events";
using Http;
using OpenAPI;
using SSE;
using Events;
namespace Common {
  model Order { id: string; items?: Record<Order | null> }
  @events union Ev { e0: Order }
}
@service namespace Probe { using Common; @route("/e") @get op alpha(): SSEStream<Ev>; }
