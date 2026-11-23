import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Out { v: string }
// Parts named like the keywords and the functions the reader of a form calls.
@route("/m") @post op upload(
  @header contentType: "multipart/form-data",
  @multipartBody body: { type: HttpPart<string>; bad: HttpPart<string>; text_part: HttpPart<string>; file_part: HttpPart<File>; json_part?: HttpPart<File>; `kebab-case`?: HttpPart<string> },
): Out;
