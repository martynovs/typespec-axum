import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Node { meta?: { parent: Node } }
model Page<T> { items: T[] }
model Tree { kids?: Page<Tree> | null; more: Page<Tree> | null }
model Dog { friends: Record<Dog | null> }
@route("/a") @get op get_a(): Node;
@route("/b") @get op get_b(): Tree;
@route("/c") @get op get_c(): Dog;
