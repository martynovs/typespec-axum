/** What the emitter's files share: the operation data, JSON Schema helpers and TypeSpec constraints. */
import { getDoc, getExamples, getSummary, getMaxLength, getMaxValue, getMinLength, getMinValue, getPattern, serializeValueAsJson, type Program, type Type } from "@typespec/compiler";

// ---------------------------------------------------------------------------------------------------------------------
// What the emitter reads from an operation, before any Rust is written
// ---------------------------------------------------------------------------------------------------------------------

/** What the emitter was asked for (`EmitterOptions`), and what it learned of the contract while writing types. */
export interface Config {
  /** The generated files' name for themselves, in their first line. */
  generator: string;
  /** Rust path of the module that holds `types.rs`. */
  typesPath: string;
  /** Rust path of the type a handler refuses with, or undefined for the one `axum.rs` defines. */
  refusalType?: string;
  maxQueryBytes: number;
  maxQueryPairs: number;
  /** Whether a response may carry an untyped `serde_json::Value`. */
  allowUntyped: boolean;
  /** Rust names of the types TypeSpec writes out in place wherever they are used (instances of a template). */
  inlined: Set<string>;
}

export interface Header { name: string; field: string; repeated: boolean }

/** An `x-*` extension of an operation: its name and its JSON, which the operation's `Route` carries and its document repeats. */
export interface Extension { name: string; json: unknown }

export interface Answer {
  status: number;
  /** The `Answer` enum variant (`Ok`, `Accepted`, ...). */
  variant: string;
  /** The Rust type of the body, when there is one. */
  ty?: string;
  media: string;
  headers: Header[];
}

export interface EventVariant { name: string; ty: string; plain: boolean }
export interface Events { name: string; variants: EventVariant[]; consts: Const[] }

export interface Param {
  name: string;
  field: string;
  kind: string;
  repeated: boolean;
  /** A path parameter's place in the route: its index among the path's `/`-separated texts (the empty text before the first `/` is 0). */
  segment?: number;
}

/** An associated constant (or, in an operation's module, a constant) that holds a fact the contract states: `ty` and a Rust expression. */
export interface Const { name: string; ty: string; value: string }

export interface DocParam { name: string; kind: string; ty: string; description?: string; attrs: string[]; consts: Const[] }
export interface DocContent { media: string; ty?: string; item?: string }
export interface DocResponse { status: number; description: string; headers: string[]; contents: DocContent[] }

export interface Op {
  id: string;
  trait: string;
  path: string;
  method: string;
  extensions: Extension[];
  params: Param[];
  body?: string;
  /** The status a body that does not decode is refused with (400 or 422), when the contract lists one. */
  inputRefusal?: number;
  answers: Answer[];
  events?: Events;
  summary?: string;
  description?: string;
  docParams: DocParam[];
  /** The operation's `SUMMARY` and `DESCRIPTION`. */
  consts: Const[];
  docResponses: DocResponse[];
}

// ---------------------------------------------------------------------------------------------------------------------
// The JSON Schema of a Rust wire type, for the schemas a derive cannot write
// ---------------------------------------------------------------------------------------------------------------------

export const q = (s: string) => JSON.stringify(s);

/** A Rust raw string literal for any text (a pattern's backslashes and quotes stay as written). */
export function rustStr(s: string): string {
  let hashes = "#";
  while (s.includes(`"${hashes}`)) hashes += "#";
  return `r${hashes}"${s}"${hashes}`;
}

const KEYWORDS = new Set(["as", "break", "const", "continue", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "static", "struct", "trait", "true", "type", "unsafe", "use", "where", "while", "async", "await", "dyn", "abstract", "become", "box", "do", "final", "macro", "override", "priv", "typeof", "unsized", "virtual", "yield", "try"]);

/** The Rust field for a wire name: snake_case, and a raw identifier (`r#type`) for a keyword. The wire name stays in `serde(rename)`. */
export function rustField(name: string): string {
  const id = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();
  return KEYWORDS.has(id) ? `r#${id}` : /^[0-9]/.test(id) ? `_${id}` : id;
}

/** The OpenAPI `format` of a Rust number type, as the TypeSpec emitter writes it. */
const FORMATS: Record<string, string> = {
  i8: "int8", i16: "int16", i32: "int32", i64: "int64", u8: "uint8", u16: "uint16", u32: "uint32", u64: "uint64", f32: "float", f64: "double",
};

const isNamed = (ty: string) => /^[A-Z]\w*$/.test(ty);

/**
 * A Rust expression (a `serde_json::Value`) holding the JSON Schema of a Rust wire type, as the TypeSpec document writes it.
 * A type in `inlined` is written out in place, as the TypeSpec emitter writes an instance of a template; any other is a `$ref`.
 */
export function schemaExpr(ty: string, inlined: ReadonlySet<string>): string {
  if (ty === "String") return 'json!({"type": "string"})';
  if (ty === "bool") return 'json!({"type": "boolean"})';
  if (FORMATS[ty]) return `json!({"type": "${ty.startsWith("f") ? "number" : "integer"}", "format": "${FORMATS[ty]}"})`;
  let m = ty.match(/^Vec<(.*)>$/);
  if (m) return `json!({"type": "array", "items": ${schemaExpr(m[1], inlined)}})`;
  m = ty.match(/^Option<(.*)>$/);
  if (m) return `json!({"anyOf": [${schemaExpr(m[1], inlined)}, {"type": "null"}]})`;
  m = ty.match(/^std::collections::BTreeMap<String, (.*)>$/);
  if (m) return `json!({"type": "object", "additionalProperties": ${schemaExpr(m[1], inlined)}})`;
  if (inlined.has(ty)) return `serde_json::to_value(<${ty} as utoipa::PartialSchema>::schema()).expect("a schema serializes")`;
  if (isNamed(ty)) return `json!({"$ref": ${q("#/components/schemas/" + ty)}})`;
  return "json!({})";
}

/** The named types a schema expression refers to by `$ref`, which a manual schema must register. */
export function schemaDeps(ty: string, inlined: ReadonlySet<string>): string[] {
  const m = ty.match(/^(?:Vec|Option)<(.*)>$/) ?? ty.match(/^std::collections::BTreeMap<String, (.*)>$/);
  if (m) return schemaDeps(m[1], inlined);
  return isNamed(ty) && ty !== "String" && !inlined.has(ty) ? [ty] : [];
}

// ---------------------------------------------------------------------------------------------------------------------
// TypeSpec constraints
// ---------------------------------------------------------------------------------------------------------------------

/** The `minimum`, `maximum`, `minLength`, `maxLength` and `pattern` TypeSpec states on a type, under their JSON Schema names. */
export function constraintValues(program: Program, p: Type): Record<string, number | string> {
  const values: Record<string, number | string | undefined> = {
    minimum: getMinValue(program, p),
    maximum: getMaxValue(program, p),
    minLength: getMinLength(program, p),
    maxLength: getMaxLength(program, p),
    pattern: getPattern(program, p),
  };
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Record<string, number | string>;
}

/** The same constraints as `#[schema(..)]` and parameter attributes. */
export function constraints(program: Program, p: Type): string[] {
  const attribute: Record<string, string> = { minimum: "minimum", maximum: "maximum", minLength: "min_length", maxLength: "max_length", pattern: "pattern" };
  return Object.entries(constraintValues(program, p)).map(([name, value]) => `${attribute[name]} = ${typeof value === "string" ? q(value) : value}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Constants: what the contract states of a type, a field or a parameter, as values Rust can read
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The constants for one target: its constraints (`MINIMUM`, `MAXIMUM`, `MIN_LENGTH`, `MAX_LENGTH`, `PATTERN`), its `@summary`
 * (`SUMMARY`), its doc (`DESCRIPTION`) and its first `@example` (`EXAMPLE`, as JSON text), each named `prefix` + that. `ty` is the Rust type of the value the target
 * describes, which a bound takes the type of.
 */
export function facts(program: Program, target: Type, ty: string, prefix = ""): Const[] {
  const out: Const[] = [];
  const stated = constraintValues(program, target);
  const inner = ty.replace(/^(?:Option|Vec)<(.*)>$/, "$1").replace(/^(?:Option|Vec)<(.*)>$/, "$1");
  for (const [rule, name] of [["minimum", "MINIMUM"], ["maximum", "MAXIMUM"]] as const) {
    const value = stated[rule];
    if (typeof value !== "number") continue;
    const numeric = /^[iuf]\d+$/.test(inner) && (Number.isInteger(value) || inner.startsWith("f")) ? inner : Number.isInteger(value) ? "i64" : "f64";
    out.push({ name: prefix + name, ty: numeric, value: numeric.startsWith("f") ? `${value}_${numeric}` : String(value) });
  }
  for (const [rule, name] of [["minLength", "MIN_LENGTH"], ["maxLength", "MAX_LENGTH"]] as const) {
    if (typeof stated[rule] === "number") out.push({ name: prefix + name, ty: "usize", value: String(stated[rule]) });
  }
  if (typeof stated.pattern === "string") out.push({ name: prefix + "PATTERN", ty: "&'static str", value: rustStr(stated.pattern) });
  const summary = getSummary(program, target);
  if (summary) out.push({ name: prefix + "SUMMARY", ty: "&'static str", value: rustStr(summary) });
  const doc = getDoc(program, target);
  if (doc) out.push({ name: prefix + "DESCRIPTION", ty: "&'static str", value: rustStr(doc) });
  const examples = getExamples(program, target as any);
  if (examples.length) {
    out.push({ name: prefix + "EXAMPLE", ty: "&'static str", value: rustStr(JSON.stringify(serializeValueAsJson(program, examples[0].value, target as any))) });
  }
  return out;
}

/** The prefix of the constants of a field or parameter: `age` is `AGE_`. */
export const constPrefix = (field: string) => `${field.replace(/^r#/, "").toUpperCase()}_`;
