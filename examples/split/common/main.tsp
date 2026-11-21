import "@typespec/http";

using Http;

/** The models both contracts share: written once, as `generated/common`, and named by the others through `type-map`. */
@service(#{ title: "Shared models" })
namespace Shop.Common;

/** What a customer buys. */
model Item {
  id: string;
  name: string;
  @minValue(0) cents: int64;
}

/** An item to add. */
model NewItem {
  name: string;
  @minValue(0) cents: int64;
}
