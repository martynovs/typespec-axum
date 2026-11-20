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
union Feed {
  /** A pet was created. */
  created: string,
  @contentType("text/plain") `pet.created`: string,
  `pet-deleted`: string,
  self: string,
}
@route("/events") @get op events(): SSEStream<Feed>;
