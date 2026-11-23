/** The JSON Schema of a Rust wire type, for the schemas a derive cannot write. */
import { lastSegment, q } from "./rust.js";

/** The OpenAPI `format` of a Rust number type, as the TypeSpec emitter writes it. */
const FORMATS: Record<string, string> = {
  i8: "int8", i16: "int16", i32: "int32", i64: "int64", u8: "uint8", u16: "uint16", u32: "uint32", u64: "uint64", f32: "float", f64: "double",
};

/** A Rust type that is a named type of the contract, written bare (`Pet`) or by path (`crate::types::Pet`). */
export const isNamed = (ty: string) => /^(?:::)?(?:[a-z_]\w*::)*[A-Z]\w*$/.test(ty);

/**
 * Whether a type the application maps names no schema of the document (a primitive, a `std` type, a generic one): its schema is written in place,
 * from its own `PartialSchema`. Any other mapped path is a component of the document, and implements `ToSchema`.
 */
export const inlineSchema = (path: string) => !isNamed(path) || path === "String" || path === "serde_json::Value" || /^(?:::)?(?:std|core|alloc)::/.test(path);

/** The mark in `inlined` of a mapped path whose schema is written in place. */
export const inlineKey = (path: string) => `=${path}`;

/** A type the derive of `utoipa` already reads without `ToSchema`: a string, a primitive, a list, a map, an `Option`, a `Box`. */
const nativeToDerive = (path: string) => /^(?:::)?(?:std::string::)?String$|^(?:bool|char|[iuf](?:8|16|32|64|128|size))$|^serde_json::Value$|^(?:Vec|Option|Box)<|^(?:std|alloc)::(?:collections|vec|boxed|option)::/.test(path);

/** Whether an entry of the `type-map` is read from its own `PartialSchema` where utoipa would ask `ToSchema`: `inline`, and not a type the derive reads itself. */
export const onlyPartial = (entry: { path: string; inline: boolean }) => entry.inline && !nativeToDerive(entry.path);

/** The text without the given paths: a mapped path `crate::wire::Limits` is not a mention of a type of the contract named `Limits`. */
export const withoutPaths = (text: string, paths: Iterable<string>) => { let out = text; for (const path of paths) out = out.replace(new RegExp(`(?<![\\w:])${path.replace(/[$()*+.?[\\\\\]^{|}]/g, "\\$&")}(?!\\w)`, "g"), ""); return out; };

/** Whether a Rust type names `path`, as a whole path and not as the start of a longer one. */
export const namesPath = (ty: string, path: string) => new RegExp(`(?<![\\w:])${path.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")}(?!\\w)`).test(ty);

/** Whether a type is written in place: an instance of a template, or a mapped path that names no schema. */
export const isInline = (ty: string, inlined: ReadonlySet<string>) => inlined.has(lastSegment(ty)) || inlined.has(inlineKey(ty));


/**
 * A Rust expression (a `serde_json::Value`) holding the JSON Schema of a Rust wire type, as the TypeSpec document writes it.
 * A type in `inlined` is written out in place, as the TypeSpec emitter writes an instance of a template; any other is a `$ref`.
 */
export function schemaExpr(ty: string, inlined: ReadonlySet<string>): string {
  if (ty === "String") return 'json!({"type": "string"})';
  if (ty === "bool") return 'json!({"type": "boolean"})';
  if (ty === "()") return 'json!({"type": "null"})';
  if (ty === "Decimal") return 'json!({"type": "number", "format": "decimal"})';
  if (FORMATS[ty]) return `json!({"type": "${ty.startsWith("f") ? "number" : "integer"}", "format": "${FORMATS[ty]}"})`;
  let m = ty.match(/^Vec<(.*)>$/);
  if (m) return `json!({"type": "array", "items": ${schemaExpr(m[1], inlined)}})`;
  m = ty.match(/^Option<(.*)>$/);
  if (m) return `json!({"anyOf": [${schemaExpr(m[1], inlined)}, {"type": "null"}]})`;
  m = ty.match(/^std::collections::BTreeMap<String, (.*)>$/);
  if (m) return `json!({"type": "object", "additionalProperties": ${schemaExpr(m[1], inlined)}})`;
  // Any JSON has no schema to refer to, and utoipa cannot read an empty one: an object, as everywhere else it is written.
  if (ty === "serde_json::Value") return 'json!({"type": "object"})';
  if (isInline(ty, inlined)) return `serde_json::to_value(<${ty} as utoipa::PartialSchema>::schema()).expect("a schema serializes")`;
  if (isNamed(ty)) return `json!({"$ref": ${q("#/components/schemas/" + lastSegment(ty))}})`;
  return 'json!({"type": "object"})';
}

/**
 * The named types a schema expression refers to by `$ref`, which a manual schema must register. One written in place (an instance of a
 * template) is marked `~`: it is not registered, but what it refers to in turn is.
 */
export function schemaDeps(ty: string, inlined: ReadonlySet<string>): string[] {
  const m = ty.match(/^(?:Vec|Option)<(.*)>$/) ?? ty.match(/^std::collections::BTreeMap<String, (.*)>$/);
  if (m) return schemaDeps(m[1], inlined);
  if (!isNamed(ty) || ty === "String" || inlined.has(inlineKey(ty))) return [];
  return inlined.has(lastSegment(ty)) ? [`~${ty}`] : [ty];
}
