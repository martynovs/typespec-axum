import "@typespec/http";
import "@typespec/openapi";
import "@typespec/streams";
import "@typespec/sse";
import "@typespec/events";
using Http;
using OpenAPI;
using SSE;
using Events;
model Challenge { challenge: string }
@events union Ev { begun: Challenge }
interface Feed { @route("/feed") @get feed_events(): SSEStream<Ev>; }
@service(#{title:"Public"}) namespace Probe { interface F extends Feed {} }
@service(#{title:"Admin"}) namespace Admin { interface F extends Feed {} }
