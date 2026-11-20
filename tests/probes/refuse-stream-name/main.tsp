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
@events union Feed { a: string }
@route("/f") @get op feed(): SSEStream<Feed>;
