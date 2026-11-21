import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Plain { a: string; b?: int32 }
model WithFloat { f: float64 }
model HoldsFloat { inner: WithFloat; list: Plain[] }
model HoldsPlain { p: Plain; m: Record<Plain>; any: unknown; n?: Plain | null }
model Tree { kids: Tree[]; leaf?: Plain }
model Cycle { next?: CycleB }
model CycleB { back?: Cycle; price: float32 }
union Either { Plain, string }
union Floaty { WithFloat, string }
model Holds { e: Either; f: Floaty }
alias Big = int64;
@route("/p") @post op make(@body body: HoldsPlain): HoldsFloat;
@route("/t") @post op tree(@body body: Tree): Holds;
@route("/c") @post op cycle(@body body: Cycle): Plain;
