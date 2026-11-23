/**
 * A request body that is a file or a form of parts: what the contract says of it (the parts, their types and media) and the exact
 * `requestBody` of the document, written as `@typespec/openapi3` writes it (utoipa cannot say `contentMediaType` or an `encoding`).
 */
import type { Type } from "@typespec/compiler";
import { Refusal } from "./config.js";
import { rustField as field } from "./rust.js";

/** One part of a `multipart/form-data` body. */
export interface FormPart {
  /** The name of the part on the wire. */
  name: string;
  /** The Rust field of the generated `Form`. */
  field: string;
  /** `text` is a `String`, `scalar` text parsed as the Rust type, `json` a JSON part decoded as the Rust type, `file` an `UploadFile`. */
  kind: "text" | "scalar" | "json" | "file";
  /** The Rust type of one value (`UploadFile` for a file): the field is an `Option` of it when optional, a `Vec` when `multi`. */
  ty: string;
  optional: boolean;
  multi: boolean;
  /** The media types the contract lists for a file part (`*` `/` `*` is any). */
  media: string[];
}

/** A body that is read as bytes, or as a form of parts. */
export interface Upload {
  kind: "bytes" | "form";
  /** The media types the contract lists for the body. */
  media: string[];
  parts: FormPart[];
  /** The `requestBody` of the document, as JSON text. */
  requestBody: string;
}

const NUMBERS: Record<string, string> = {
  int8: "i8", int16: "i16", int32: "i32", int64: "i64", uint8: "u8", uint16: "u16", uint32: "u32", uint64: "u64", float32: "f32", float64: "f64",
  safeint: "i64", integer: "i64", float: "f64",
};
const FORMATS: Record<string, string> = { int8: "int8", int16: "int16", int32: "int32", int64: "int64", uint8: "uint8", uint16: "uint16", uint32: "uint32", uint64: "uint64", float32: "float", float64: "double", safeint: "int64", float: "double" };

/** The standard scalar a type is (`model Id is string` is `string`), when it is one. */
function standard(t: Type): string | undefined {
  for (let s: any = t; s; s = s.baseScalar) if (s.kind === "Scalar" && s.namespace?.name === "TypeSpec" && !s.namespace.namespace?.name) return s.name;
  return undefined;
}

/** The JSON schema of a scalar written as text, and the Rust type it is read as. */
function scalar(t: Type): { ty: string; schema: object } | undefined {
  const name = standard(t);
  if (name === "string") return { ty: "String", schema: { type: "string" } };
  if (name === "boolean") return { ty: "bool", schema: { type: "boolean" } };
  if (name && NUMBERS[name]) {
    const integer = NUMBERS[name].startsWith("f") ? false : true;
    return { ty: NUMBERS[name], schema: { type: integer ? "integer" : "number", ...(FORMATS[name] ? { format: FORMATS[name] } : {}) } };
  }
  return undefined;
}

/** A model that is a list (`string[]`, `Item[]`), not a named model. */
const listOf = (t: Type): Type | undefined => (t.kind === "Model" && t.name === "Array" && t.indexer ? t.indexer.value : undefined);

/** The JSON a JSON part is, as a schema of the document and the Rust type it is decoded as. */
function json(t: Type, rust: (t: Type) => string, known: (name: string) => boolean, where: string): { ty: string; schema: object } {
  const item = listOf(t);
  if (item) {
    const inner = scalar(item) ?? json(item, rust, known, where);
    return { ty: `Vec<${inner.ty}>`, schema: { type: "array", items: inner.schema } };
  }
  const direct = scalar(t);
  if (direct) return direct;
  if (t.kind === "Model" || t.kind === "Enum" || t.kind === "Union") {
    // `rust` writes the type by its path: the document names it by the last of it.
    const ty = rust(t);
    const name = ty.slice(ty.lastIndexOf(":") + 1);
    if (/^[A-Z]\w*$/.test(name) && known(name)) return { ty, schema: { $ref: `#/components/schemas/${name}` } };
  }
  throw new Refusal(`${where}: this type has no schema to read a JSON part as: name it as a model of the contract`);
}

/** Whether a media list is `application/octet-stream` alone: what `@typespec/openapi3` takes a binary part to be without saying so. */
const octet = (media: string[]) => media.length === 1 && media[0] === "application/octet-stream";

export function uploadOf(body: any, route: string, rust: (t: Type) => string, known: (name: string) => boolean, optional: boolean): Upload | undefined {
  const media: string[] = (body.contentTypes ?? []).map((m: string) => m.split(";")[0].trim().toLowerCase());
  if (body.bodyKind === "multipart") {
    if (optional) throw new Refusal(`${route}: a multipart body is required: a form is not left out`);
    if (body.multipartKind !== "model" || media.some((m) => m !== "multipart/form-data")) {
      throw new Refusal(`${route}: a ${media.join(", ")} request body is not generated: only multipart/form-data, whose parts have names to read them by`);
    }
    // `@typespec/openapi3` writes a named body model as a component of its own, which is not written here.
    if (body.type.kind === "Model" && body.type.name) throw new Refusal(`${route}: the multipart body is the named model ${body.type.name}: write its parts in the operation, as an anonymous model`);
    const parts: FormPart[] = [];
    const properties: Record<string, object> = {};
    const encoding: Record<string, object> = {};
    const required: string[] = [];
    const fields = new Set<string>();
    for (const part of body.parts as any[]) {
      const name: string | undefined = part.name;
      if (!name) throw new Refusal(`${route}: a part of the multipart body has no name`);
      const where = `${route}: the part ${name}`;
      if (part.headers.length) throw new Refusal(`${where} has headers (${part.headers.map((h: any) => h.options.name).join(", ")}), which a handler cannot be given: declare the part without them`);
      const b = part.body;
      const types = ((b.contentTypes ?? []) as string[]).map((m) => m.split(";")[0].trim().toLowerCase());
      let kind: FormPart["kind"];
      let ty: string;
      let schema: object;
      let partMedia = types;
      if (b.bodyKind === "file" || (b.bodyKind === "single" && standard(b.type) === "bytes")) {
        if (b.bodyKind === "file" && b.isText) throw new Refusal(`${where} is a File with text contents, which is not generated: use bytes`);
        kind = "file"; ty = "UploadFile"; schema = {};
        if (!partMedia.length) partMedia = ["application/octet-stream"];
      } else if (b.bodyKind === "single") {
        const type = b.type as Type;
        const direct = scalar(type);
        if (direct && types.every((m) => m === "text/plain")) {
          kind = direct.ty === "String" ? "text" : "scalar"; ty = direct.ty; schema = direct.schema;
        } else {
          const held = json(type, rust, known, where);
          kind = "json"; ty = held.ty; schema = held.schema;
          if (types.some((m) => m !== "application/json" && !m.endsWith("+json"))) throw new Refusal(`${where} is of the media type ${types.join(", ")}: a part is text, JSON or a file`);
        }
      } else {
        throw new Refusal(`${where} is a ${b.bodyKind} body, which is not generated`);
      }
      const f = field(name);
      if (fields.has(f)) throw new Refusal(`${where} is the Rust field ${f}, which another part is too: rename one in the contract`);
      fields.add(f);
      parts.push({ name, field: f, kind, ty, optional: !!part.optional, multi: !!part.multi, media: partMedia });
      properties[name] = part.multi ? { type: "array", items: schema } : schema;
      if (!part.optional) required.push(name);
      // The encoding is written unless it is the one the schema implies: text/plain for a string (a number says it), octet-stream for a file; a JSON part (a reference, a list) always says it.
      const joined = partMedia.join(", ");
      const implied = kind === "file" ? octet(partMedia) : kind === "text";
      if (!implied) encoding[name] = { contentType: joined || (kind === "json" ? "application/json" : "text/plain") };
    }
    const content: any = { schema: { type: "object", properties, ...(required.length ? { required } : {}) } };
    if (Object.keys(encoding).length) content.encoding = encoding;
    return { kind: "form", media, parts, requestBody: JSON.stringify({ required: !optional, content: { "multipart/form-data": content } }) };
  }
  const bytes = body.bodyKind === "file" ? !body.isText : body.bodyKind === "single" && standard(body.type) === "bytes" && media.every((m) => !/^(application\/(json|[\w.+-]+\+json)|text\/plain)$/.test(m));
  if (body.bodyKind === "file" && body.isText) throw new Refusal(`${route}: a File with text contents is not generated as a request body: use bytes`);
  if (!bytes) return undefined;
  const content = Object.fromEntries(media.map((m) => [m, { schema: { contentMediaType: m } }]));
  return { kind: "bytes", media, parts: [], requestBody: JSON.stringify({ required: !optional, content }) };
}
