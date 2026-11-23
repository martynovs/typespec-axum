import "@typespec/http";
import "@typespec/openapi";
import "./shared.tsp";
using Http;
using OpenAPI;
@service namespace Probe;
model Limits { max?: string }
model Unused { a?: string }
scalar Big extends int64;
scalar Host extends string;
scalar Token extends string;
union Either { Limits, string }
model Holder { either: Either; big: Big | string; host: Host | int32; nullable: Token | null; /** The access token. */ token: Token; tokens: Token[]; maybe?: Token }
/** A mapped model taken and returned directly, with no generated type in between. */
@route("/d") @post op direct(@body body: Limits): Limits;
@route("/h") @post op hold(@body body: Holder): Holder;
@route("/c") @get op cents(@query amount: Shared.Cents): Limits;
@route("/s") @post op named(@header contentType: "application/json", @body body: Host): Host;
@route("/p") @get op param(@query t: Token, @header x_token: Token): Limits;
union Pick { Token, int32 }
model Tokens is Token[];
model ByName is Record<Token>;
model Rows is Token[][];
model Probing { pick: Pick; tokens: Tokens; by_name: ByName; rows: Rows }
@route("/q") @post op probing(@body body: Probing): Probing;
