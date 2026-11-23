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
model Challenge { challenge: string }
@events union Ev { begun: Challenge }
@route("/e") @get op feed_events(): SSEStream<Ev>;
