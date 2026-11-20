import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Pet { n: string }
model Wrap<T> { items: T[] }
model Out { v: string }
@route("/a") @post op post_array(@body body?: Pet[]): Out;
@route("/b") @post op post_wrap(@body body?: Wrap<Pet>): Out;
@route("/c") @post op post_open(@body body?: {}): Out;
@route("/d") @post op post_pet(@body body?: Pet): Out;
