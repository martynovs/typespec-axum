import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
/** What the application's type is called in the document. */
enum Transport { usb, nfc }
model Base { id: string }
/** The challenge the server gives. */
model Challenge extends Base {
  /** The bytes, base64. */
  @minLength(4) challenge: string;
  @example("rp.example.com") rp_id?: string = "example.com";
  #deprecated "use rp_id"
  old?: string;
  transports?: Transport[];
  kind: "public-key";
  attachment?: "platform" | "cross-platform";
  flag?: true;
  timeout?: int32 | null;
  extra?: Record<string>;
}
model Reply { id: string; challenge: Challenge }
model Holder { challenge: Challenge; many: Challenge[]; maybe?: Challenge; nullable: Challenge | null }
union Either { Challenge, string }
@route("/c") @post op begin(@body body: Challenge, @query again?: Transport): Challenge;
@route("/l") @get op list(): Challenge[];
@route("/h") @post op hold(@body body: Holder): Reply;
@route("/p") @get op param(@header x_transport: Transport): Either;
