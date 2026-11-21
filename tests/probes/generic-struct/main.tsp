import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Filters { a: string }
model Envelope<T> {
  status: string;
  message?: string | null;
  data: T;
  filters?: Filters | null;
  /** At most 3 rows. */
  @maxItems(3) more?: T[];
}
model Begun<Options> { ceremony: string; options: Options }
model Wrap<T> { items: T[]; by_name: Record<T>; extra?: T }
model Held { id: string }
model Opts { challenge: string }
alias NoData = null;
@route("/l") @get op list(): Envelope<Held[]>;
@route("/o") @get op one(): Envelope<Held>;
@route("/n") @post op nothing(): Envelope<NoData>;
@route("/b") @post op begin(): Envelope<Begun<Opts>>;
@route("/w") @get op wrapped(): Wrap<Held>;
@route("/x") @get op nullable(): Envelope<string | null>;
@route("/s") @get op number(): Envelope<int32>;
