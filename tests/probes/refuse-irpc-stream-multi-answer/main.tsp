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
model Ev1 { n: int32 }
@events
union Feed {
  one: Ev1,
  bye: string,
}
@route("/f") @get op watch(): SSEStream<Feed> | { @statusCode _: 204 };
