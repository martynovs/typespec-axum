import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
/** Closed: a property it does not list is refused. */
model Closed {
  ...Record<never>;
  name: string;
  size?: int32;
}
model Open { name: string }
@route("/c") @post op make(@body body: Closed): Open;
