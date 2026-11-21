import "@typespec/http";
import "@typespec/openapi";
import "@typespec/streams";
import "@typespec/sse";
import "@typespec/events";
using Http;
using OpenAPI;
using SSE;
using Events;
@service namespace Probe;
@events
union Client {
  one: string,
}
@route("/f") @get op watch(): SSEStream<Client>;
