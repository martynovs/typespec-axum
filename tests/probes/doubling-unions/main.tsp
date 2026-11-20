import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
union U0 { string, int32 }
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
model Req { u: U16 }
@route("/x") @post op doit(@body body: Req): Req;
