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
scalar Tag extends string;
@events union Ev { @contentType("text/plain") count: int32, @contentType("text/plain") tag: Tag, @contentType("text/plain") flag: boolean }
@route("/e") @get op feed_events(): SSEStream<Ev>;
