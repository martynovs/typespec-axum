import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Wrapper<T> { value: T; next?: Wrapper<T>; }
@route("/a") @get op get_a(): Wrapper<string>;
