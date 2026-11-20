import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union Json { string, int32, Json[], Record<Json> }
model H { j: Json }
model Node { kids: Kids }
union Kids { string, Node[] }
model R2 is Record<R2>;
model B { a: A }
model A is Record<B>;
union Expr { lit: Lit, neg: Neg }
model Lit { v: int32 }
model Neg { inner: Expr }
@route("/h") @get op get_h(): H;
@route("/n") @get op get_n(): Node;
@route("/r") @get op get_r(): R2;
@route("/b") @get op get_b(): B;
@route("/e") @get op get_e(): Expr;
