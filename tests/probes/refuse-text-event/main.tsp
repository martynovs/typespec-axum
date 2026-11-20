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
model Pet { n: string }
@events union Ev { @contentType("text/plain") a: Pet }
@route("/e") @get op feed_events(): SSEStream<Ev>;
