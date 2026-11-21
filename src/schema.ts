/** The JSON Schema of a Rust wire type, for the schemas a derive cannot write. */
import { lastSegment, q } from "./rust.js";

/** The OpenAPI `format` of a Rust number type, as the TypeSpec emitter writes it. */
const FORMATS: Record<string, string> = {
  i8: "int8", i16: "int16", i32: "int32", i64: "int64", u8: "uint8", u16: "uint16", u32: "uint32", u64: "uint64", f32: "float", f64: "double",
};

/** A Rust type that is a named type of the contract, written bare (`Pet`) or by path (`crate::types::Pet`). */
const isNamed = (ty: string) => /^(?:[a-z_]\w*::)*[A-Z]\w*$/.test(ty);


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
  if (inlined.has(lastSegment(ty))) return `serde_json::to_value(<${ty} as utoipa::PartialSchema>::schema()).expect("a schema serializes")`;
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
  if (!isNamed(ty) || ty === "String") return [];
  return inlined.has(lastSegment(ty)) ? [`~${ty}`] : [ty];
}
