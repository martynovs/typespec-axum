/**
 * The Rust of `axum.rs`, as templates: each function takes data already worked out and returns a fragment with its line breaks where they
 * belong. No decision about the contract is made here; `rustfmt` lays out whatever is written.
 */
import type { Config, ExtensionExpr } from "../config.js";
import type { Answer, Events, Op } from "../contract.js";
import { q, rustJson } from "../rust.js";
import { constantsImpl } from "../types/templates.js";
import { formTypes, uploadExtraction } from "./upload.js";
import { forSchema, isInline, onlyPartial, schemaTypes } from "../schema.js";

const lines = (items: string[]) => items.join("\n");

/** The constant that holds an operation, with its values: `Operation::MINT`. */
const operationConst = (o: Op) => o.id.toUpperCase();

/** The name of the method that returns an operation's handler: \`list_pets_handler\`. */
const handlerName = (o: Op) => `${o.id.replace(/_$/, "")}_handler`;

// ---------------------------------------------------------------------------------------------------------------------
// Endpoints (axum.rs)
// ---------------------------------------------------------------------------------------------------------------------

/** What a handler refuses with: the type the contract's author names, or one `axum.rs` defines (a response, usually made of a status). */
const refusalType = (c: Config) => c.refusalType
  ? `use ${c.refusalType} as Refused;`
  : `/// What a handler answers with when it refuses the request: a response, usually made of a status (\`StatusCode::NOT_FOUND.into()\`).
#[derive(Debug)]
pub struct Refused(pub AxResponse);

impl From<AxStatusCode> for Refused {
    fn from(status: AxStatusCode) -> Self {
        Self(status.into_response())
    }
}

impl AxIntoResponse for Refused {
    fn into_response(self) -> AxResponse {
        self.0
    }
}`;

export const axumHeader = (c: Config) => `
#![allow(missing_docs, dead_code, unused_imports, unused_variables, unused_mut, clippy::all, clippy::pedantic)]
use serde_json::json;
use axum::body::Bytes as AxBytes;
use axum::extract::{FromRequest as _, Request as AxRequest, State as AxState};
use axum::http::{HeaderMap as AxHeaderMap, HeaderValue as AxHeaderValue, Method as AxMethod, StatusCode as AxStatusCode, request::Parts as AxParts};
use axum::response::{IntoResponse as _, IntoResponse as AxIntoResponse, Response as AxResponse, sse::{Event as AxEvent, KeepAlive as AxKeepAlive, Sse as AxSse}};
use axum::{Json as AxJson, Router as AxRouter};

pub type Events = std::pin::Pin<Box<dyn tokio_stream::Stream<Item = Result<AxEvent, std::convert::Infallible>> + Send>>;

${refusalType(c)}

/// An \`x-*\` extension of an operation, as the contract states it: its name and its JSON text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extension {
    pub name: &'static str,
    pub json: &'static str,
}

/// What a contract states of one operation: how it is called, where, and its extensions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub method: AxMethod,
    pub path: &'static str,
    pub extensions: &'static [Extension],
}

/// The longest query string, and the most pairs, any route of this API can need. A request over either is refused before its query
/// is parsed, so a long query cannot be made to allocate (the pairs are Strings, many times the size of the text they came from).
const MAX_QUERY_BYTES: usize = ${c.maxQueryBytes};
const MAX_QUERY_PAIRS: usize = ${c.maxQueryPairs};
const MAX_JSON_DEPTH: usize = ${c.maxJsonDepth};

/// The answer to a request that cannot be read: a status and what is wrong with it${c.rejectWith ? `, made by \`${c.rejectWith}\`` : ""}.
fn reject(status: AxStatusCode, message: &'static str) -> AxResponse {
${c.rejectWith ? `    ${c.rejectWith}(status, message).into_response()` : "    (status, message).into_response()"}
}

fn query_within_bounds(uri: &axum::http::Uri) -> Result<(), &'static str> {
    let query = uri.query().unwrap_or("");
    if query.len() > MAX_QUERY_BYTES || query.split('&').count() > MAX_QUERY_PAIRS {
        return Err("the query is longer than this API accepts");
    }
    Ok(())
}

/// One path segment as the text it names: percent-decoded, and refused when that is not UTF-8, as axum's \`Path\` refuses it. A segment
/// with nothing to decode is not copied by the decoding, only into the \`String\` the input keeps.
fn decode_segment(segment: &str) -> Result<String, &'static str> {
    percent_encoding::percent_decode_str(segment)
        .decode_utf8()
        .map(std::borrow::Cow::into_owned)
        .map_err(|_| "a path parameter is not valid UTF-8")
}

/// A response header's value, or the answer that says the handler produced one HTTP cannot carry (a newline in the text, say): a
/// fault of the handler, answered 500, never a panic.
fn header_value(text: &str) -> Result<AxHeaderValue, AxResponse> {
    AxHeaderValue::from_str(text).map_err(|_| AxStatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// The value of the cookie \`name\`: the first cookie of that name in the request's \`Cookie\` headers, without the quotes it may be wrapped in.
fn cookie_value(headers: &AxHeaderMap, name: &str) -> Option<String> {
    // A header value is bytes: text that is not ASCII is read as UTF-8, not dropped.
    for value in headers.get_all(axum::http::header::COOKIE) {
        let text = String::from_utf8_lossy(value.as_bytes());
        for pair in text.split(';') {
            if let Some((key, value)) = pair.trim().split_once('=') {
                if key == name {
                    return Some(value.trim().trim_matches('"').to_owned());
                }
            }
        }
    }
    None
}

/// Whether the request says its body is JSON (\`application/json\`, or any \`+json\` type).
fn json_content_type(headers: &AxHeaderMap) -> bool {
    let Some(content_type) = headers.get(axum::http::header::CONTENT_TYPE).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let essence = content_type.split(';').next().unwrap_or("").trim();
    essence.eq_ignore_ascii_case("application/json")
        || (essence.len() >= 5 && essence.as_bytes()[essence.len() - 5..].eq_ignore_ascii_case(b"+json"))
}

/// A query value as text, \`+\` being a space and \`%XX\` a byte, as \`form_urlencoded\` reads it. For a value the query holds several of, one pair
/// with commas between them (\`ids=a,b\`): split on the commas before they are decoded, so an item can hold an encoded one (\`a%2Cb\`).
fn form_decode(text: &str) -> String {
    percent_encoding::percent_decode_str(&text.replace('+', " ")).decode_utf8_lossy().into_owned()
}

/// Whether JSON nests no deeper than \`limit\` (\`{\` and \`[\` outside strings), judged before it is parsed: a union of structs can be made to
/// cost time that doubles with each level of depth.
fn json_depth_within(bytes: &[u8], limit: usize) -> bool {
    let (mut depth, mut in_string, mut escaped) = (0_usize, false, false);
    for &byte in bytes {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                if depth > limit {
                    return false;
                }
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    true
}

/// A path parameter the route names was not in the request path, so the route is mounted under a path other than the one it was
/// generated for. The router only runs a route for a path of its shape, so this is a wiring fault: answered 500, never a panic.
fn missing_segment() -> AxResponse {
    AxStatusCode::INTERNAL_SERVER_ERROR.into_response()
}

${c.document === "none" ? "" : `/// What utoipa cannot say, applied to the document it built: OpenAPI 3.2, no license, and the stream item schemas written in place
/// of their placeholder components.
fn finish(document: &mut serde_json::Value, items: &[(&str, serde_json::Value)], operations: &[(&str, &[&str], bool, Option<bool>)], exact: &[(&str, &str)], shapes: &[(&str, &str, &str, &str)], exact_properties: &[(&str, &str, &str)], computed: &[(&str, serde_json::Value)], bodies: &[(&str, &str)]) {
    document["openapi"] = json!("3.2.0");
    if let Some(info) = document.get_mut("info").and_then(serde_json::Value::as_object_mut) {
        info.remove("license");
    }
    // utoipa tags an operation with its module; the contract's tags are the operation's own, and the document lists each once.
    let mut tags: Vec<&str> = Vec::new();
    for (_, path) in document.get_mut("paths").and_then(serde_json::Value::as_object_mut).into_iter().flatten() {
        for (_, operation) in path.as_object_mut().into_iter().flatten() {
            let Some(operation) = operation.as_object_mut() else { continue };
            operation.remove("tags");
            let id = operation.get("operationId").and_then(serde_json::Value::as_str).map(str::to_owned);
            if let Some((_, own, deprecated, body_required)) = operations.iter().find(|(name, _, _, _)| Some(*name) == id.as_deref()) {
                if let Some(body) = operation.get_mut("requestBody").and_then(serde_json::Value::as_object_mut) {
                    match body_required {
                        Some(true) => { body.insert("required".to_owned(), json!(true)); }
                        _ => { body.remove("required"); }
                    }
                }
                if !own.is_empty() {
                    operation.insert("tags".to_owned(), json!(own));
                    tags.extend(own.iter().copied());
                }
                if *deprecated {
                    operation.insert("deprecated".to_owned(), json!(true));
                }
            }
        }
    }
    tags.sort_unstable();
    tags.dedup();
    document["tags"] = json!(tags.iter().map(|name| json!({"name": name})).collect::<Vec<_>>());
    for (name, item) in items {
        let reference = json!({"$ref": format!("#/components/schemas/{name}")});
        let paths = document.get_mut("paths").and_then(serde_json::Value::as_object_mut).into_iter().flatten();
        for (_, path) in paths {
            for (_, operation) in path.as_object_mut().into_iter().flatten() {
                let responses = operation.get_mut("responses").and_then(serde_json::Value::as_object_mut).into_iter().flatten();
                for (_, response) in responses {
                    let content = response.get_mut("content").and_then(serde_json::Value::as_object_mut).into_iter().flatten();
                    for (_, media) in content {
                        if media.get("itemSchema") == Some(&reference) {
                            media["itemSchema"] = item.clone();
                        }
                    }
                }
            }
        }
        if let Some(schemas) = document.pointer_mut("/components/schemas").and_then(serde_json::Value::as_object_mut) {
            schemas.remove(*name);
        }
    }
    // What utoipa cannot hold is written into the document as it is: a type of the application's whose schema is the contract's, and a property with a keyword beside anyOf or a reference.
    for (name, schema) in computed {
        if let Some(held) = document.pointer_mut("/components/schemas").and_then(serde_json::Value::as_object_mut).and_then(|schemas| schemas.get_mut(*name)) {
            *held = schema.clone();
        }
    }
    for (component, property, schema) in exact_properties {
        if let Some(held) = document.pointer_mut("/components/schemas").and_then(|schemas| schemas.get_mut(*component)).and_then(|schema| schema.get_mut("properties")).and_then(|properties| properties.get_mut(*property)) {
            *held = serde_json::from_str(schema).expect("the exact property schema is JSON");
        }
    }
    // The body of an operation that takes a file or a form is written as the TypeSpec document writes it: utoipa has no contentMediaType and no encoding.
    for (operation_id, body) in bodies {
        let paths = document.get_mut("paths").and_then(serde_json::Value::as_object_mut).into_iter().flatten();
        for (_, path) in paths {
            for (_, operation) in path.as_object_mut().into_iter().flatten() {
                if operation.get("operationId").and_then(serde_json::Value::as_str) == Some(operation_id) {
                    operation["requestBody"] = serde_json::from_str(body).expect("the request body is JSON");
                }
            }
        }
    }
    // What utoipa cannot hold (a const) is written into the document as it is.
    for (name, schema) in exact {
        if let Some(held) = document.pointer_mut("/components/schemas").and_then(serde_json::Value::as_object_mut).and_then(|schemas| schemas.get_mut(*name)) {
            *held = serde_json::from_str(schema).expect("the exact schema is JSON");
        }
    }
    // What utoipa writes otherwise than the TypeSpec document does: the exact format of a parameter (uint32), and whether a response header is required or a list.
    for (operation_id, place, name, shape) in shapes {
        let paths = document.get_mut("paths").and_then(serde_json::Value::as_object_mut).into_iter().flatten();
        for (_, path) in paths {
            for (_, operation) in path.as_object_mut().into_iter().flatten() {
                if operation.get("operationId").and_then(serde_json::Value::as_str) != Some(operation_id) {
                    continue;
                }
                if *place == "parameter" || *place == "parameter-items" {
                    // name is where the parameter is and what it is called: query:id.
                    let (location, called) = name.split_once(':').unwrap_or(("", name));
                    for parameter in operation.get_mut("parameters").and_then(serde_json::Value::as_array_mut).into_iter().flatten() {
                        if parameter.get("name").and_then(serde_json::Value::as_str) == Some(called) && parameter.get("in").and_then(serde_json::Value::as_str) == Some(location) {
                            if *place == "parameter" {
                                parameter["schema"]["format"] = json!(shape);
                            } else {
                                parameter["schema"]["items"]["format"] = json!(shape);
                            }
                        }
                    }
                } else {
                    // place is the status of the response: shape is required, optional, required-list or optional-list.
                    let header = operation.pointer_mut(&format!("/responses/{place}/headers/{name}"));
                    if let Some(header) = header.and_then(serde_json::Value::as_object_mut) {
                        header.insert("required".to_owned(), json!(!shape.starts_with("optional")));
                        if shape.ends_with("-list") {
                            header.insert("schema".to_owned(), json!({"type": "array", "items": {"type": "string"}}));
                        }
                    }
                }
            }
        }
    }
${c.document === "typespec" ? `    // An operation with no parameters has an empty list of them in the TypeSpec document; utoipa leaves the key out.
    for (_, path) in document.get_mut("paths").and_then(serde_json::Value::as_object_mut).into_iter().flatten() {
        for (_, operation) in path.as_object_mut().into_iter().flatten() {
            if let Some(operation) = operation.as_object_mut() {
                operation.entry("parameters").or_insert_with(|| json!([]));
            }
        }
    }
` : ""}${c.document === "typespec" ? `    // A parameter that may be null: the TypeSpec document writes anyOf of the type and null, where utoipa writes a list of types.
    let paths = document.get_mut("paths").and_then(serde_json::Value::as_object_mut).into_iter().flatten();
    for (_, path) in paths {
        for (_, operation) in path.as_object_mut().into_iter().flatten() {
            for parameter in operation.get_mut("parameters").and_then(serde_json::Value::as_array_mut).into_iter().flatten() {
                let Some(schema) = parameter.get_mut("schema").and_then(serde_json::Value::as_object_mut) else { continue };
                let Some(kinds) = schema.get("type").and_then(serde_json::Value::as_array).cloned() else { continue };
                if kinds.len() != 2 || !kinds.contains(&json!("null")) {
                    continue;
                }
                let kind = kinds.iter().find(|k| **k != json!("null")).cloned().unwrap_or(json!("null"));
                let mut member = serde_json::Map::new();
                member.insert("type".to_owned(), kind);
                if let Some(format) = schema.remove("format") {
                    member.insert("format".to_owned(), format);
                }
                schema.remove("type");
                schema.insert("anyOf".to_owned(), json!([member, {"type": "null"}]));
            }
        }
    }
` : ""}${c.document === "typespec" ? `    strip_property_names(document);
` : ""}    if let Some(schemas) = document.pointer_mut("/components/schemas") {
        examples_as_list(schemas);
    }
}

${c.document === "typespec" ? `/// utoipa says the names of a map are strings, which the TypeSpec document leaves unsaid.
fn strip_property_names(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            if map.get("propertyNames") == Some(&json!({"type": "string"})) {
                map.remove("propertyNames");
            }
            // A closed model: the TypeSpec document says no property is left unevaluated, where utoipa says no property is additional.
            if map.get("additionalProperties") == Some(&json!(false)) {
                map.remove("additionalProperties");
                map.insert("unevaluatedProperties".to_owned(), json!({"not": {}}));
            }
            // An example, a default or a constant is a value of the contract, not a schema: it is left as it is.
            for (key, held) in map.iter_mut() {
                if !matches!(key.as_str(), "example" | "examples" | "default" | "const" | "enum") {
                    strip_property_names(held);
                }
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(strip_property_names),
        _ => {}
    }
}

` : ""}/// A schema's \`example\` is the list \`examples\` in the TypeSpec document (and in OpenAPI 3.1 and later).
fn examples_as_list(schema: &mut serde_json::Value) {
    match schema {
        serde_json::Value::Object(map) => {
            if let Some(example) = map.remove("example") {
                map.insert("examples".to_owned(), json!([example]));
            }
            map.values_mut().for_each(examples_as_list);
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(examples_as_list),
        _ => {}
    }
}
`}`;

const inputType = (p: Op["params"][number]) =>
  p.kind === "path" ? "String" : p.repeated && (p.kind === "query" || p.kind === "header") ? "Vec<String>" : "Option<String>";

/** The expression that reads one header parameter out of the request (path and query parameters are read in one pass each). */
const headerValue = (p: Op["params"][number]) => p.repeated
  ? `{ let mut values = Vec::new(); for value in parts.headers.get_all(${q(p.name)}) { values.extend(String::from_utf8_lossy(value.as_bytes()).split(',').map(|value| value.trim().to_owned())); } values }`
  : `parts.headers.get(${q(p.name)}).map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())`;

/** The name of the constant that says where a path parameter sits in the route: `ACCOUNT_SEGMENT`. */
const segmentConst = (p: Op["params"][number]) => `${p.field.replace(/^r#/, "").toUpperCase()}_SEGMENT`;

const segmentConsts = (o: Op) => lines(o.params.filter((p) => p.kind === "path").map((p) => `
    /// Where \`${p.name}\` sits in \`${o.path}\`: its index among the path's \`/\`-separated texts, the empty text before the first \`/\` being 0.
    const ${segmentConst(p)}: usize = ${p.segment};`));

/** The local that holds a path parameter while the path is read. Numbered, so no parameter's name can shadow a local of `run`. */
const pathLocal = (paths: Op["params"], p: Op["params"][number]) => `path_param${paths.indexOf(p)}`;

/**
 * Reads the path once, as an iterator over borrowed segments, taking each path parameter from its place in the route: the router
 * matched this path against the route's pattern, so the segment is there. Nothing is allocated for the pass itself.
 */
/** The status a request that cannot be read is refused with: the one the operation lists for it (400, 422, 401), else 400. */
const refusalStatus = (o: Op) => ({ 400: "BAD_REQUEST", 401: "UNAUTHORIZED", 422: "UNPROCESSABLE_ENTITY" } as Record<number, string>)[o.inputRefusal ?? 400];

const pathPass = (o: Op) => {
  const paths = o.params.filter((p) => p.kind === "path");
  if (!paths.length) return "";
  return `
${lines(paths.map((p) => `        let mut ${pathLocal(paths, p)}: Option<String> = None;`))}
        for (index, segment) in parts.uri.path().split('/').enumerate() {
            match index {
${lines(paths.map((p) => `                ${segmentConst(p)} => ${pathLocal(paths, p)} = Some(match decode_segment(segment) { Ok(text) => text, Err(message) => return reject(AxStatusCode::${refusalStatus(o)}, message) }),`))}
                _ => {}
            }
        }
${lines(paths.map((p) => `        let Some(${pathLocal(paths, p)}) = ${pathLocal(paths, p)} else { return missing_segment() };`))}`;
};

/** The local that holds a query parameter while the query is read. Numbered, so no parameter's name can shadow a local of `run`. */
const queryLocal = (queries: Op["params"], p: Op["params"][number]) => `param${queries.indexOf(p)}`;

/**
 * Reads the query once, as an iterator over borrowed pairs: a value is copied only for a parameter the contract lists (the last
 * occurrence wins, or every one for a repeated parameter), and any other key is only counted.
 */
const queryPass = (o: Op) => {
  const queries = o.params.filter((p) => p.kind === "query");
  const pairs = `form_urlencoded::parse(parts.uri.query().unwrap_or("").as_bytes())`;
  if (!queries.length) return `        let unknown = ${pairs}.count();`;
  return `        let mut unknown = 0_usize;
${lines(queries.map((p) => `        let mut ${queryLocal(queries, p)}${p.repeated ? ": Vec<String> = Vec::new()" : ": Option<String> = None"};`))}
        for pair in parts.uri.query().unwrap_or("").split('&') {
            let Some((key, value)) = form_urlencoded::parse(pair.as_bytes()).next() else { continue };
            match &*key {
${lines(queries.map((p) => `                ${q(p.name)} => ${queryLocal(queries, p)}${
  p.repeated ? (p.explode ? ".push(value.into_owned())" : ".extend(pair.split_once('=').map_or(\"\", |(_, raw)| raw).split(',').map(form_decode))") : " = Some(value.into_owned())"},`))}
                _ => unknown += 1,
            }
        }`;
};

const answerBody = (a: Answer) => (a.headers.length ? "answer.body" : "answer");

const answerResponse = (a: Answer) => {
  const body = answerBody(a);
  const response = a.media === "application/json" ? `AxJson(${body}).into_response()`
    : a.media === "text/event-stream" ? `AxSse::new(${body}).keep_alive(AxKeepAlive::default()).into_response()`
    : a.media === "text/plain" ? (a.ty === "String" ? `${body}.into_response()` : `${body}.to_string().into_response()`)
    : "().into_response()";
  const set = (h: Answer["headers"][number], text: string, how: "insert" | "append") =>
    `match header_value(&${text}) { Ok(value) => { response.headers_mut().${how}(${q(h.name)}, value); } Err(refused) => return refused }`;
  const headers = a.headers.map((h) => h.repeated ? `for text in answer.${h.field} { ${set(h, "text", "append")} }`
    : h.optional ? `if let Some(text) = answer.${h.field} { ${set(h, "text", "insert")} }`
    : set(h, `answer.${h.field}`, "insert"));
  return `
            let mut response = ${response};
            *response.status_mut() = AxStatusCode::from_u16(${a.status}).expect("contract status");${headers.map((h) => `\n            ${h}`).join("")}
            response`;
};

const answerTypes = (o: Op) => {
  const multiple = o.answers.length > 1;
  const withHeaders = o.answers.filter((a) => a.headers.length);
  const variant = (a: Answer) => (a.headers.length ? `${a.variant}(${a.variant}),` : a.ty ? `${a.variant}(${a.ty}),` : `${a.variant},`);
  return `
${lines(withHeaders.map((a) => `    pub struct ${multiple ? a.variant : "Answer"} {
${a.ty ? `        pub body: ${a.ty},` : ""}
${lines(a.headers.map((h) => `        pub ${h.field}: ${h.repeated ? "Vec<String>" : h.optional ? "Option<String>" : "String"},`))}
    }`))}
${multiple
    ? `    pub enum Answer {\n${lines(o.answers.map((a) => "        " + variant(a)))}\n    }`
    : !o.answers[0].headers.length ? `    pub type Answer = ${o.answers[0].ty ?? "()"};` : ""}`;
};

const respondFn = (o: Op) => {
  const arms = o.answers.map((a) => `            Answer::${a.variant}${a.ty || a.headers.length ? "(answer)" : ""} => {${answerResponse(a)}
            },`);
  return `
    fn respond(answer: Answer) -> AxResponse {
${o.answers.length > 1 ? `        match answer {\n${lines(arms)}\n        }` : answerResponse(o.answers[0])}
    }`;
};

const bodyExtraction = (o: Op, config: Config) => {
  if (o.upload) {
    // A form that is not one: refused as a body that does not decode is, or axum's own answer when the operation lists no such status.
    return uploadExtraction(o, (native) => (o.inputRefusal === undefined ? native : `reject(AxStatusCode::${refusalStatus(o)}, "the request body does not match the API contract")`));
  }
  if (!o.body) return "";
  // An operation that lists no status for it keeps axum's own answer to a body that does not decode, with or without `reject-with`.
  const rejection = o.inputRefusal === undefined ? "error.into_response()"
    : `reject(AxStatusCode::${refusalStatus(o)}, "the request body does not match the API contract")`;
  return `
        let mut body_request = AxRequest::new(body);
        *body_request.extensions_mut() = parts.extensions.clone();
        let bytes = match AxBytes::from_request(body_request, &()).await {
            Ok(bytes) => bytes,
            // A body that cannot be read (too large, say) is axum's own answer, whatever the application refuses with.
            Err(error) => return error.into_response(),
        };
        if !json_depth_within(&bytes, MAX_JSON_DEPTH) {
            return reject(AxStatusCode::${refusalStatus(o)}, "the request body nests deeper than this API accepts");
        }
${config.requireJson ? `        if ${o.bodyOptional ? "!bytes.is_empty() && " : ""}!json_content_type(&parts.headers) {
            return reject(AxStatusCode::UNSUPPORTED_MEDIA_TYPE, "the request body must be JSON");
        }
` : ""}${o.bodyOptional ? `        let body = if bytes.is_empty() {
            None
        } else {
            match AxJson::<${o.body}>::from_bytes(&bytes) {
                Ok(AxJson(body)) => Some(body),
                Err(error) => return ${rejection},
            }
        };` : `        let AxJson(body) = match AxJson::<${o.body}>::from_bytes(&bytes) {
            Ok(body) => body,
            Err(error) => return ${rejection},
        };`}`;
};

const runFn = (o: Op, config: Config) => {
  const queries = o.params.filter((p) => p.kind === "query");
  const paths = o.params.filter((p) => p.kind === "path");
  const value = (p: Op["params"][number]) =>
    p.kind === "query" ? queryLocal(queries, p)
      : p.kind === "path" ? pathLocal(paths, p)
      : p.kind === "cookie" ? `cookie_value(&parts.headers, ${q(p.name)})`
      : headerValue(p);
  return `
    pub(crate) async fn run(AxState(call): AxState<Call>, request: AxRequest) -> AxResponse {
        let (mut parts, body) = request.into_parts();
        if let Err(message) = query_within_bounds(&parts.uri) {
            return reject(AxStatusCode::${refusalStatus(o)}, message);
        }${pathPass(o)}
${queryPass(o)}${bodyExtraction(o, config)}
        let input = Input {
            unknown,
${lines(o.params.map((p) => `            ${p.field}: ${value(p)},`))}
${o.body || o.upload ? "            body," : ""}
        };
        match call(parts, input).await {
            Ok(answer) => respond(answer),
            Err(refused) => refused.into_response(),
        }
    }`;
};

/** Envelope bodies are written out in place in the TypeSpec documents, so they are inlined here too. */
const refOrInline = (ty: string, config: Config): string => {
  // The type of a body that may be left out is its type: an `Option` or a `Box` of an instance is the instance.
  let bare = ty;
  for (let wrapped = bare.match(/^(?:Option|Box)<(.*)>$/); wrapped; wrapped = bare.match(/^(?:Option|Box)<(.*)>$/)) bare = wrapped[1];
  if (bare !== ty && schemaTypes(config.inlined).has(bare)) return refOrInline(bare, config);
  // An instance of a template is written in place, as the TypeSpec document does.
  const instance = schemaTypes(config.inlined).get(ty);
  if (instance?.inline) return `inline(${config.typesPath}::${instance.struct})`;
  // A type of `schema: contract` is told to utoipa by the type of the generated code that says its schema.
  const text = forSchema(ty, config.inlined, `${config.typesPath}::`);
  return text === "serde_json::Value" ? "inline(Object)"
    : isInline(text, config.inlined) || /^(String|bool|[iuf]\d+|Vec<.*>)$/.test(text) ? `inline(${text})` : text;
};

/** What a request body is, for utoipa: its type. Whether it may be left out is `finish`'s to say: an `Option` would also make it nullable. */
const requestContent = (o: Op, config: Config) => refOrInline(o.body!, config);

/** The `#[utoipa::path]` of an operation: everything the TypeSpec operation states, so the document cannot drift from the route. */
const utoipaPath = (o: Op, config: Config) => {
  const kinds: Record<string, string> = { path: "Path", query: "Query", header: "Header", cookie: "Cookie" };
  // A parameter of a type of `inline: true` is written in place: utoipa would ask it for `ToSchema`. (An optional one is refused by `generate`.)
  const explicit = new Set([...config.typeMap.values()].filter(onlyPartial).map((e) => e.path));
  const params = o.docParams.map((p) => {
    const inline = p.ty !== undefined && explicit.has(p.ty);
    const ty = inline ? `inline(${p.ty})` : forSchema(p.ty, config.inlined, `${config.typesPath}::`);
    return `(${q(p.name)} = ${ty}, ${kinds[p.kind]}${p.description ? `, description = ${q(p.description)}` : ""}${p.attrs.map((a) => `, ${a}`).join("")}${p.explode === false ? ", explode = false" : ""})`;
  });
  const responses = o.docResponses.map((r) => {
    const content = r.contents.length === 1
      ? r.contents[0].item
        ? `, content_type = ${q(r.contents[0].media)}, item_schema = ${r.contents[0].item}`
        : `, body = ${refOrInline(r.contents[0].ty!, config)}, content_type = ${q(r.contents[0].media)}`
      : r.contents.length > 1
        ? `, content(${r.contents.map((c) => (c.item ? `(String = ${q(c.media)})` : `(${refOrInline(c.ty!, config)} = ${q(c.media)})`)).join(", ")})`
        : "";
    const headers = r.headers.length ? `, headers(${r.headers.map((h) => `(${q(h)} = String)`).join(", ")})` : "";
    return `(status = ${r.status}, description = ${q(r.description)}${content}${headers})`;
  });
  const args = [
    o.method,
    `path = ${q(o.path)}`,
    `operation_id = ${q(o.operationId)}`,
    o.summary && `summary = ${q(o.summary)}`,
    o.description && `description = ${q(o.description)}`,
    params.length && `params(${params.join(", ")})`,
    o.body && !o.upload && `request_body(content = ${requestContent(o, config)}, content_type = ${q(o.bodyMedia ?? "application/json")})`,
    `responses(${responses.join(", ")})`,
    o.extensions.length && `extensions(${o.extensions.map((e) => `(${q(e.name)} = json!(${rustJson(e.json)}))`).join(", ")})`,
  ].filter(Boolean);
  // rustfmt does not lay out an attribute's arguments, so they are written at the depth the attribute ends up at (inside two modules).
  return `
        #[utoipa::path(
${lines(args.map((a) => `            ${a},`))}
        )]`;
};

export const operationTrait = (o: Op) => `
pub trait ${o.trait}: Send + Sync {
    /// The handler of this operation, or \`None\` when this node cannot serve it, so the router does not mount the route. The handler
    /// takes only what it needs from the node (\`${o.id}::call\` boxes a function of the request).
    fn ${handlerName(o)}(&self) -> Option<${o.id}::Call>;
}`;

/** What the application's macro makes of each configured extension this operation states, as a const of its module. */
export const extensionConsts = (o: Op, config: Config) => [...config.extensionExpr].flatMap(([name, x]) => {
  const e = o.extensions.find((e) => e.name === name);
  return e ? [`    pub const ${x.const}: ${x.type} = ${x.macro}!(${rustJson(e.json)});`] : [];
});

export const operationModule = (o: Op, config: Config) => `
${operationTrait(o)}

pub mod ${o.id} {
    use super::*;
    use axum::extract::FromRequest as _;
    use axum::response::IntoResponse as _;
${segmentConsts(o)}
${lines([...o.consts, ...o.docParams.flatMap((p) => p.consts)].map((c) => `    pub const ${c.name}: ${c.ty} = ${c.value};`))}
${lines(extensionConsts(o, config))}

    #[derive(Debug)]
    pub struct Input {
        /// How many query pairs name a parameter this operation does not list.
        pub unknown: usize,
${lines(o.params.map((p) => `        pub ${p.field}: ${inputType(p)},`))}
${o.body ? `        pub body: ${o.bodyOptional ? `Option<${o.body}>` : o.body},` : ""}${uploadInput(o)}
    }${o.upload?.kind === "form" ? formTypes(o, config) : ""}
${answerTypes(o)}
${respondFn(o)}

    pub type Call = std::sync::Arc<
        dyn std::ops::Fn(AxParts, Input) -> std::pin::Pin<
            std::boxed::Box<dyn std::future::Future<Output = Result<Answer, super::super::Refused>> + Send>,
        > + Send + Sync,
    >;

    /// A handler made of a function of the request: boxes the function's future.
    pub fn call<F, Fut>(handler: F) -> Call
    where
        F: Fn(AxParts, Input) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<Answer, super::super::Refused>> + Send + 'static,
    {
        std::sync::Arc::new(move |parts, input| std::boxed::Box::pin(handler(parts, input)))
    }

    /// A handler made of a function of a state and the request, such as \`State::${o.id}\` for an \`async fn ${o.id}(self: Arc<Self>, ..)\`:
    /// each request gets a clone of the \`Arc\`.
    pub fn call_with_state<T, F, Fut>(state: std::sync::Arc<T>, handler: F) -> Call
    where
        T: Send + Sync + 'static,
        F: Fn(std::sync::Arc<T>, AxParts, Input) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<Answer, super::super::Refused>> + Send + 'static,
    {
        std::sync::Arc::new(move |parts, input| std::boxed::Box::pin(handler(state.clone(), parts, input)))
    }

    /// Mounts this operation's route on \`router\` when the node has a handler for it, and leaves \`router\` as it is when not.
    pub fn mount<S: ${o.trait}>(router: AxRouter, api: &S) -> AxRouter {
        match api.${handlerName(o)}() {
            Some(call) => router.route(Operation::${operationConst(o)}.as_ref().path, axum::routing::${o.method}(run).with_state(call)${o.upload && config.maxUploadBytes !== undefined ? `.layer(axum::extract::DefaultBodyLimit::max(${config.maxUploadBytes}))` : ""}),
            None => router,
        }
    }
${config.document === "none" ? "" : utoipaPath(o, config)}${runFn(o, config)}
}`;

/** The `Input::body` of an operation that takes a file (its bytes) or a form. */
const uploadInput = (o: Op) => {
  if (!o.upload) return "";
  const ty = o.upload.kind === "form" ? "Form" : o.bodyOptional ? "Option<AxBytes>" : "AxBytes";
  return `\n        pub body: ${ty},`;
};

/** The events of a stream: the union the handler's `Events` carry, and how each is sent. */
export const eventsEnum = (e: Events) => `
pub enum ${e.name} {
${lines(e.variants.map((v) => `    ${v.variant}(${v.ty}),`))}
}

${constantsImpl(e.name, e.consts)}
impl From<${e.name}> for AxEvent {
    fn from(event: ${e.name}) -> Self {
        match event {
${lines(e.variants.map((v) => `            ${e.name}::${v.variant}(data) => AxEvent::default().event(${q(v.name)}).data(${v.plain ? "data.to_string()" : 'serde_json::to_string(&data).expect("a wire shape serializes")'}),`))}
        }
    }
}`;

/** The exact `itemSchema` of a stream, which utoipa cannot hold: `finish` writes it where the placeholder component is referenced. */
export const eventItem = (fn: string, item: string) => `
fn ${fn}() -> serde_json::Value {
    ${item}
}`;

export const router = (ops: Op[]) => `
/// Mounts every route of this contract that \`api\` can serve on \`router\`, which the caller starts as it likes.
pub fn mount<S>(router: AxRouter, api: &S) -> AxRouter
where
    S: Sized${ops.map((o) => ` + ${o.trait}`).join("")},
{
${lines(ops.map((o) => `    let router = ${o.id}::mount(router, api);`))}
    router
}`;

export const contractModule = (c: {
  module: string;
  /** Whether the module has a document (`ApiDoc` and `document()`). */
  documented: boolean;
  /** The extensions lowered to constants: their settings, and which operations state each. */
  extensions: { expr: ExtensionExpr; has: Set<string> }[];
  ops: Op[];
  info: string[];
  paths: string[];
  components: string[];
  items: string[];
  /** The components written into the finished document as they are, as `(name, json)`. */
  exact: string[];
  /** What utoipa writes otherwise than the TypeSpec document: `(operationId, place, name, shape)` of a parameter format or a response header. */
  shapes: string[];
  /** `(component, property, json)` of the properties written into the finished document as they are. */
  exactProperties: string[];
  /** `(name, schema)` of the components whose exact schema a type of the generated code gives. */
  computed: string[];
  /** `(operationId, &[tags], deprecated, whether the body is required)` of each operation. */
  operations: string[];
  /** `(operationId, json)` of the request body of each operation that takes a file or a form. */
  bodies: string[];
  body: string[];
}) => `
pub mod ${c.module} {
    use super::*;

    /// An operation of this contract, carrying what the contract states of it (\`Route\`). The values are written once, on the
    /// constants below (\`Operation::${c.ops[0] ? operationConst(c.ops[0]) : "NONE"}\`, ...).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Operation {
${lines(c.ops.map((o) => `        ${o.trait}(super::Route),`))}
    }

    impl Operation {
${lines(c.ops.map((o) => `        pub const ${operationConst(o)}: Operation = Operation::${o.trait}(super::Route {
            method: AxMethod::${o.method.toUpperCase()},
            path: ${q(o.path)},
            extensions: &[${o.extensions.map((e) => `super::Extension { name: ${q(e.name)}, json: ${q(JSON.stringify(e.json))} }`).join(", ")}],
        });`))}

        pub const ALL: [Operation; ${c.ops.length}] = [
${lines(c.ops.map((o) => `            Self::${operationConst(o)},`))}
        ];
${c.ops.length ? lines(c.extensions.map(({ expr, has }) => `
        /// The \`${expr.name}\` extension of this operation, as the application's macro made it.
        pub const fn ${expr.accessor}(&self) -> ${expr.required ? `&'static ${expr.type}` : `Option<&'static ${expr.type}>`} {
            match self {
${lines(c.ops.map((o) => `                Self::${o.trait}(_) => ${has.has(o.id) ? (expr.required ? `&${o.id}::${expr.const}` : `Some(&${o.id}::${expr.const})`) : "None"},`))}
            }
        }`)) : ""}
    }

    impl AsRef<super::Route> for Operation {
        fn as_ref(&self) -> &super::Route {
            match ${c.ops.length ? "self" : "*self"} {
                ${c.ops.length ? `${c.ops.map((o) => `Self::${o.trait}(route)`).join("\n                | ")} => route,` : ""}
            }
        }
    }

${lines(c.body)}
${router(c.ops)}
${c.documented ? `
    #[derive(utoipa::OpenApi)]
    #[openapi(
        info(${c.info.join(", ")}),
        paths(${c.paths.join(", ")}),
        components(schemas(${c.components.join(", ")})),
    )]
    pub struct ApiDoc;

    /// The OpenAPI document of this contract, as the TypeSpec emitter writes it.
    pub fn document() -> serde_json::Value {
        let mut document = serde_json::to_value(<ApiDoc as utoipa::OpenApi>::openapi()).expect("the document serializes");
        finish(&mut document, &[${c.items.join(", ")}], &[${c.operations.join(", ")}], &[${c.exact.join(", ")}], &[${c.shapes.join(", ")}], &[${c.exactProperties.join(", ")}], &[${c.computed.join(", ")}], &[${c.bodies.join(", ")}]);
        document
    }` : ""}
}`;
