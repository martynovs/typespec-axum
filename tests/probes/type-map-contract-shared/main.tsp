import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
model Challenge { challenge: string; kind: "public-key" }
interface Passkey {
  @route("/challenge") @post begin(@body body: Challenge): Challenge;
}
@service(#{title:"Public"}) namespace Probe { interface P extends Passkey {} }
@service(#{title:"Admin"}) namespace Admin { interface P extends Passkey {} @route("/own") @get op own(): Challenge[]; }
