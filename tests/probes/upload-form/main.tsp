import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Meta { tags: string[]; }
model Out { v: string }
model ImageFile extends File<"image/png" | "image/jpeg"> {}
@error model Refusal { message: string }

@route("/form/{id}") @post op upload(
  @path id: string,
  @header contentType: "multipart/form-data",
  @multipartBody body: {
    title: HttpPart<string>;
    count: HttpPart<int32>;
    meta: HttpPart<Meta>;
    doc: HttpPart<File>;
    photos: HttpPart<ImageFile>[];
    note?: HttpPart<string>;
    avatar?: HttpPart<File>;
    ids?: HttpPart<string[]>;
  },
): Out | { @statusCode _: 400; @body body: Refusal };
