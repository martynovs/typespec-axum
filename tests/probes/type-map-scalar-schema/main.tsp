import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
/** An instant on the wire. */
scalar Instant extends string;
model Row {
  at: Instant;
  maybe?: Instant | null;
  many: Instant[];
  plain: string;
  /** When it was. */
  documented: Instant;
}
@route("/r") @get op get_row(@query ids?: uint32[], @query count?: uint32, @header("x-count") x_count: string): Row;
