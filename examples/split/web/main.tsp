import "@typespec/http";
import "../common/main.tsp";

using Http;
using Shop.Common;

/** The web API: what browsers and partners call over HTTP. */
@service(#{ title: "Shop web API" })
namespace Shop.Web;

model NotFound {
  @statusCode _: 404;
  @body body: { message: string };
}

@route("/items") @get op list_items(): Item[];
@route("/items") @post op add_item(@body item: NewItem): { @statusCode _: 201; @body body: Item };
@route("/items/{id}") @get op get_item(@path id: string): Item | NotFound;
