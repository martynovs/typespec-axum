import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union E { E[], null }
union F { Record<F>, null }
union G { G[] | null }
union H { x: H[], y: (H[] | null) }
model Wrap { e: E; f: F; g: G; h: H }
@route("/x") @post op doit(@body body: Wrap): Wrap;
