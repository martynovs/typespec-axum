import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
/** Names that look like what the generated code imports are operations too. */
@route("/stream") @get op stream(): string;
@route("/pin") @get op pin(): string;
@route("/poll") @get op poll(): string;
@route("/bytes") @get op bytes_(): string;
@route("/context") @get op context_(): string;
@route("/serialize") @get op serialize(): string;
@route("/stream-ext") @get op stream_ext(): string;
@route("/api") @get op api(): string;
@route("/client-op") @get op client_(): string;
