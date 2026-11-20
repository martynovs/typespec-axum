import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union U0 { "a", "b" }
union U1 { a: U0, b: U0 }
union U2 { a: U1, b: U1 }
union U3 { a: U2, b: U2 }
union U4 { a: U3, b: U3 }
union U5 { a: U4, b: U4 }
union U6 { a: U5, b: U5 }
union U7 { a: U6, b: U6 }
union U8 { a: U7, b: U7 }
union U9 { a: U8, b: U8 }
union U10 { a: U9, b: U9 }
union U11 { a: U10, b: U10 }
union U12 { a: U11, b: U11 }
union U13 { a: U12, b: U12 }
union U14 { a: U13, b: U13 }
union U15 { a: U14, b: U14 }
union U16 { a: U15, b: U15 }
union U17 { a: U16, b: U16 }
union U18 { a: U17, b: U17 }
union U19 { a: U18, b: U18 }
union U20 { a: U19, b: U19 }
union U21 { a: U20, b: U20 }
union U22 { a: U21, b: U21 }
union U23 { a: U22, b: U22 }
union U24 { a: U23, b: U23 }
union U25 { a: U24, b: U24 }
union U26 { a: U25, b: U25 }
union U27 { a: U26, b: U26 }
union U28 { a: U27, b: U27 }
union U29 { a: U28, b: U28 }
union U30 { a: U29, b: U29 }
union U31 { a: U30, b: U30 }
union U32 { a: U31, b: U31 }
union U33 { a: U32, b: U32 }
union U34 { a: U33, b: U33 }
union U35 { a: U34, b: U34 }
union U36 { a: U35, b: U35 }
union U37 { a: U36, b: U36 }
union U38 { a: U37, b: U37 }
union U39 { a: U38, b: U38 }
union U40 { a: U39, b: U39 }
model M { u: U40; v: U40 | null; w?: U40 | "z" }
@route("/r") @post op go(@body body: M): M;
