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
@events union Ev { a: unknown, b: string }
@route("/e") @get op feed_events(): SSEStream<Ev>;
