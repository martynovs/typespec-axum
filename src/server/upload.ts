/**
 * The Rust of `axum.rs` for an operation that takes a file or a form, built on axum's own `Multipart` extractor and its `DefaultBodyLimit`:
 * the application's body limit applies as it does to any axum handler.
 */
import type { Config } from "../config.js";
import type { Op } from "../contract.js";
import { q } from "../rust.js";
import type { FormPart } from "../upload.js";

const lines = (items: string[]) => items.join("\n");

/** What every operation with a file or a form shares: the media type check, and (for a form) the reading of its parts. */
export const uploadSupport = (c: Config, forms: boolean) => `
/// Whether a media type (\`image/png; q=1\`) is one of those allowed: \`*/*\` allows any, \`image/*\` any of a kind.
fn media_allowed(given: &str, allowed: &[&str]) -> bool {
    let essence = given.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    allowed.iter().any(|one| {
        *one == "*/*"
            || *one == essence
            || one.strip_suffix("/*").is_some_and(|kind| essence.strip_prefix(kind).is_some_and(|rest| rest.starts_with('/')))
    })
}

/// The media type the request says its body is, or none.
fn request_media(headers: &AxHeaderMap) -> &str {
    headers.get(axum::http::header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("")
}
${forms ? formSupport(c) : ""}`;

const formSupport = (c: Config) => `
use axum::extract::multipart::{Field as AxField, Multipart as AxMultipart, MultipartError as AxMultipartError};

const MAX_FORM_FIELD_BYTES: usize = ${c.maxFormFieldBytes};
const MAX_FORM_PARTS: usize = ${c.maxFormParts};

/// Why a form could not be read: the body could not be read (too large, say), which is axum's own answer, or it is not the form the
/// contract describes, which is a refusal of the request.
enum FormFault {
    Read(AxResponse),
    Malformed(AxResponse),
}

fn bad(message: &'static str) -> FormFault {
    FormFault::Malformed((AxStatusCode::BAD_REQUEST, message).into_response())
}

impl From<AxMultipartError> for FormFault {
    fn from(error: AxMultipartError) -> Self {
        // axum says 400 for a form that is not one, and 413 or 500 for a body that cannot be read.
        if error.status() == AxStatusCode::BAD_REQUEST { Self::Malformed(error.into_response()) } else { Self::Read(error.into_response()) }
    }
}

/// The text or JSON of one part, never more than \`MAX_FORM_FIELD_BYTES\`.
async fn part_bytes(field: &mut AxField<'_>) -> Result<AxBytes, FormFault> {
    let mut all: Vec<u8> = Vec::new();
    while let Some(chunk) = field.chunk().await? {
        if all.len() + chunk.len() > MAX_FORM_FIELD_BYTES {
            return Err(FormFault::Read((AxStatusCode::PAYLOAD_TOO_LARGE, "a part of the form is longer than this API accepts").into_response()));
        }
        all.extend_from_slice(&chunk);
    }
    Ok(AxBytes::from(all))
}

async fn text_part(field: &mut AxField<'_>) -> Result<String, FormFault> {
    String::from_utf8(part_bytes(field).await?.to_vec()).map_err(|_| bad("a part of the form is not UTF-8 text"))
}

async fn json_part<T: serde::de::DeserializeOwned>(field: &mut AxField<'_>) -> Result<T, FormFault> {
    let bytes = part_bytes(field).await?;
    if !json_depth_within(&bytes, MAX_JSON_DEPTH) {
        return Err(bad("a part of the form nests deeper than this API accepts"));
    }
    serde_json::from_slice(&bytes).map_err(|_| bad("a part of the form does not match the API contract"))
}

async fn file_part(field: AxField<'_>, allowed: &[&str], stated: Option<&str>) -> Result<${c.typesPath}::UploadFile, FormFault> {
    let filename = field.file_name().map(str::to_owned);
    // A part that states no media type is taken to be the contract's (when it lists one): only one that states another is refused.
    let content_type = field.content_type().map(str::to_owned).or_else(|| stated.map(str::to_owned));
    if content_type.as_deref().is_some_and(|given| !media_allowed(given, allowed)) {
        return Err(FormFault::Read(reject(AxStatusCode::UNSUPPORTED_MEDIA_TYPE, "a file of the form is of a media type this operation does not accept")));
    }
    let contents = field.bytes().await?;
    Ok(${c.typesPath}::UploadFile { filename, content_type, contents })
}
`;

const allowed = (media: string[]) => `&[${media.map(q).join(", ")}]`;

const fieldType = (p: FormPart, c: Config) => {
  const one = p.kind === "file" ? `${c.typesPath}::UploadFile` : p.ty;
  return p.multi ? `Vec<${one}>` : p.optional ? `Option<${one}>` : one;
};

/** What a part is read as. */
const partValue = (p: FormPart, c: Config) =>
  p.kind === "text" ? "text_part(&mut __field).await?"
    : p.kind === "scalar" ? `text_part(&mut __field).await?.parse::<${p.ty}>().ok()${/^f/.test(p.ty) ? ".filter(|value| value.is_finite())" : ""}.ok_or_else(|| bad("a part of the form is not the value its type is"))?`
    : p.kind === "json" ? `json_part::<${p.ty}>(&mut __field).await?`
    : `file_part(__field, ${allowed(p.media)}, ${p.media.length === 1 && !p.media[0].includes("*") ? `Some(${q(p.media[0])})` : "None"}).await?`;

/** The `Form` of an operation, and the function that reads it from axum's `Multipart`. */
export const formTypes = (o: Op, c: Config) => {
  const parts = o.upload!.parts;
  // A part's slot is named by its place, so no part can take the name of a function the reader calls.
  const slotOf = (p: FormPart) => `__p${parts.indexOf(p)}`;
  const slot = (p: FormPart) => (p.multi ? `        let mut ${slotOf(p)}: Vec<_> = Vec::new();` : `        let mut ${slotOf(p)}: Option<_> = None;`);
  const arm = (p: FormPart) => p.multi
    ? `            ${q(p.name)} => ${slotOf(p)}.push(${partValue(p, c)}),`
    : `            ${q(p.name)} => {
                if ${slotOf(p)}.is_some() {
                    return Err(bad("a part of the form is given twice"));
                }
                ${slotOf(p)} = Some(${partValue(p, c)});
            }`;
  const value = (p: FormPart) =>
    p.multi || p.optional ? slotOf(p) : `${slotOf(p)}.ok_or_else(|| bad("a part the form requires is missing"))?`;
  const required = parts.filter((p) => p.multi && !p.optional).map((p) => `        if ${slotOf(p)}.is_empty() {\n            return Err(bad("a part the form requires is missing"));\n        }`);
  return `
    /// The parts of the form, as the contract lists them. A part it does not list is read past.
    #[derive(Debug)]
    pub struct Form {
${lines(parts.map((p) => `        pub ${p.field}: ${fieldType(p, c)},`))}
    }

    async fn read_form(mut __multipart: AxMultipart) -> Result<Form, FormFault> {
${lines(parts.map(slot))}
        let mut __count = 0_usize;
        while let Some(mut __field) = __multipart.next_field().await? {
            __count += 1;
            if __count > MAX_FORM_PARTS {
                return Err(bad("the form has more parts than this API accepts"));
            }
            let Some(__name) = __field.name().map(str::to_owned) else {
                return Err(bad("a part of the form has no name"));
            };
            match __name.as_str() {
${lines(parts.map(arm))}
                _ => {}
            }
        }
${lines(required)}
        Ok(Form {
${lines(parts.map((p) => `            ${p.field}: ${value(p)},`))}
        })
    }`;
};

/** How \`run\` reads the body of an operation that takes a file or a form. */
export const uploadExtraction = (o: Op, rejection: (native: string) => string): string => {
  const upload = o.upload!;
  if (upload.kind === "bytes") {
    const any = upload.media.some((m) => m === "*/*");
    const check = `!media_allowed(request_media(&parts.headers), ${allowed(upload.media)})`;
    const refusal = `            return reject(AxStatusCode::UNSUPPORTED_MEDIA_TYPE, "the request body is of a media type this operation does not accept");`;
    // A body that is required is refused for its media type before it is read; one that may be left out is judged when it is not empty.
    return `
${any || o.bodyOptional ? "" : `        if ${check} {\n${refusal.replace(/^ {4}/, "")}\n        }\n`}        let mut body_request = AxRequest::new(body);
        *body_request.extensions_mut() = parts.extensions.clone();
        let bytes = match AxBytes::from_request(body_request, &()).await {
            Ok(bytes) => bytes,
            // A body that cannot be read (too large, say) is axum's own answer.
            Err(error) => return error.into_response(),
        };
${!any && o.bodyOptional ? `        if !bytes.is_empty() && ${check} {\n${refusal.replace(/^ {4}/, "")}\n        }\n` : ""}${o.bodyOptional ? "        let body = if bytes.is_empty() { None } else { Some(bytes) };" : "        let body = bytes;"}`;
  }

  return `
        if !media_allowed(request_media(&parts.headers), &["multipart/form-data"]) {
            return reject(AxStatusCode::UNSUPPORTED_MEDIA_TYPE, "the request body must be multipart/form-data");
        }
        // The body is read by axum's \`Multipart\`, under the limit axum applies to any handler: \`DefaultBodyLimit\`, the application's or this route's.
        let mut form_request = AxRequest::new(body);
        *form_request.headers_mut() = parts.headers.clone();
        *form_request.extensions_mut() = parts.extensions.clone();
        let multipart = match AxMultipart::from_request(form_request, &()).await {
            Ok(multipart) => multipart,
            Err(error) => return ${rejection("error.into_response()")},
        };
        let body = match read_form(multipart).await {
            Ok(form) => form,
            Err(FormFault::Read(response)) => return response,
            Err(FormFault::Malformed(native)) => return ${rejection("native")},
        };`;
};
