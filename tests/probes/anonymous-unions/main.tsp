import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Cat { meow: string }
model Dog { woof: string }
model W { a: string | int32; b?: Cat | Dog; c: (string | int32 | null)[]; d?: string | int32 | null }
@route("/w") @get op get_w(@body w: W): W;
