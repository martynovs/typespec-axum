/** The Rust of `client.rs` for an operation that takes a file or a form: the form's type, and the request body it is written as. */
import type { Config } from "../config.js";
import type { Op } from "../contract.js";
import { q } from "../rust.js";
import type { FormPart } from "../upload.js";

const lines = (items: string[]) => items.join("\n");

/** Names of the helpers below, which an event stream may not take. */
export const UPLOAD_TYPES = ["MultipartPart"];

/** The writer of a `multipart/form-data` body, written once when an operation has a form. */
export const multipartWriter = String.raw`
/// One part of a form the client writes.
struct MultipartPart {
    name: &'static str,
    filename: Option<String>,
    content_type: Option<String>,
    contents: Bytes,
}

fn multipart_random() -> u128 {
    use std::hash::{BuildHasher, Hasher};
    let high = std::collections::hash_map::RandomState::new().build_hasher().finish();
    let low = std::collections::hash_map::RandomState::new().build_hasher().finish();
    (u128::from(high) << 64) | u128::from(low)
}

fn multipart_holds(contents: &[u8], boundary: &[u8]) -> bool {
    contents.windows(boundary.len()).any(|window| window == boundary)
}

/// A name or a file name as the quoted value of a header parameter: a quote and a backslash are escaped, and a line break (which would end the header) is percent-encoded.
fn multipart_quoted(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"").replace('\r', "%0D").replace('\n', "%0A")
}

/// The body of a \`multipart/form-data\` request, and the \`Content-Type\` that names its boundary: one no part holds (RFC 7578, 4.1).
fn multipart_body(parts: &[MultipartPart]) -> (String, Bytes) {
    let boundary = loop {
        let candidate = format!("typespec-{:032x}", multipart_random());
        if !parts.iter().any(|part| multipart_holds(&part.contents, candidate.as_bytes())) {
            break candidate;
        }
    };
    let mut out: Vec<u8> = Vec::new();
    for part in parts {
        out.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"", multipart_quoted(part.name)).as_bytes());
        if let Some(filename) = &part.filename {
            out.extend_from_slice(format!("; filename=\"{}\"", multipart_quoted(filename)).as_bytes());
        }
        out.extend_from_slice(b"\r\n");
        if let Some(content_type) = &part.content_type {
            // A media type is a header's value: one with a line break would be a second header.
            let content_type = content_type.replace(['\r', '\n'], " ");
            out.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
        }
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(&part.contents);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), Bytes::from(out))
}
`.replace(/\\`/g, "`");

const fieldType = (p: FormPart, c: Config) => {
  const one = p.kind === "file" ? `${c.typesPath}::UploadFile` : p.ty;
  return p.multi ? `Vec<${one}>` : p.optional ? `Option<${one}>` : one;
};

/** The `Form` a client call is given: the parts of the contract's form. */
export const formType = (o: Op, c: Config) => `
    /// The parts of the form, as the contract lists them.
    #[derive(Debug, Clone)]
    pub struct Form {
${lines(o.upload!.parts.map((p) => `        pub ${p.field}: ${fieldType(p, c)},`))}
    }`;

/** The `Request::body` of an operation that takes a file or a form. */
export const uploadBodyType = (o: Op) => (o.upload!.kind === "form" ? "Form" : o.bodyOptional ? "Option<Bytes>" : "Bytes");

const concrete = (media: string[]) => (media.length === 1 && !media[0].includes("*") ? media[0] : undefined);

/** One part of the form, written as the parts the client sends. */
const partCode = (p: FormPart) => {
  const values = p.multi || p.optional ? `input.body.${p.field}.iter()` : `std::iter::once(&input.body.${p.field})`;
  const fallback = concrete(p.media);
  const part = p.kind === "file"
    ? `MultipartPart { name: ${q(p.name)}, filename: value.filename.clone(), content_type: ${fallback ? `value.content_type.clone().or_else(|| Some(${q(fallback)}.to_owned()))` : "value.content_type.clone()"}, contents: value.contents.clone() }`
    : p.kind === "json"
      ? `MultipartPart { name: ${q(p.name)}, filename: None, content_type: Some("application/json".to_owned()), contents: Bytes::from(serde_json::to_vec(value).map_err(|error| Error::Request(error.to_string()))?) }`
      : `MultipartPart { name: ${q(p.name)}, filename: None, content_type: None, contents: Bytes::from(${p.kind === "text" ? "value.clone().into_bytes()" : "value.to_string().into_bytes()"}) }`;
  return `    for value in ${values} {\n        parts.push(${part});\n    }`;
};

/** How \`request\` writes the body of an operation that takes a file or a form, and sets its \`Content-Type\`. */
export const uploadRequestBody = (o: Op, contentType: string) => {
  const upload = o.upload!;
  if (upload.kind === "form") {
    return `    let mut parts: Vec<MultipartPart> = Vec::new();
${lines(upload.parts.map(partCode))}
    let (form_type, payload) = multipart_body(&parts);
    builder = builder.header(http::header::CONTENT_TYPE, form_type);`;
  }
  return o.bodyOptional
    ? `    let payload = match &input.body {\n        Some(body) => {\n            builder = builder.header(http::header::CONTENT_TYPE, ${contentType});\n            body.clone()\n        }\n        None => Bytes::new(),\n    };`
    : `    builder = builder.header(http::header::CONTENT_TYPE, ${contentType});\n    let payload = input.body.clone();`;
};
