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
  /** How deep the JSON of a request body may nest. */
  maxJsonDepth: number;
  /** Whether a response may carry an untyped `serde_json::Value`. */
  allowUntyped: boolean;
  /** `typespec`: schemas written by hand to match `@typespec/openapi3` to the letter; `derived`: whatever utoipa's derive writes. */
  document: "typespec" | "derived";
  /** Whether a JSON body is read only from a request that says it is JSON. */
  requireJson: boolean;
  /** Rust names of the types TypeSpec writes out in place wherever they are used (instances of a template). */
  inlined: Set<string>;
}

/** A contract the emitter cannot write faithfully: reported to the user as an error of the contract, not as a fault of the emitter. */
export class Refusal extends Error {}

export interface Header { name: string; field: string; repeated: boolean; optional: boolean }

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

export interface EventVariant { name: string; /** The variant of the Rust enum. */ variant: string; ty: string; plain: boolean }
export interface Events { name: string; variants: EventVariant[]; consts: Const[] }

export interface Param {
  name: string;
  field: string;
  kind: string;
  repeated: boolean;
  /** Whether a repeated query parameter is one pair per value (`a=1&a=2`); otherwise one pair holds them comma-separated (`a=1,2`). */
  explode?: boolean;
  /** A path parameter's place in the route: its index among the path's `/`-separated texts (the empty text before the first `/` is 0). */
  segment?: number;
}

/** An associated constant (or, in an operation's module, a constant) that holds a fact the contract states: `ty` and a Rust expression. */
export interface Const { name: string; ty: string; value: string }

export interface DocParam { name: string; kind: string; ty: string; description?: string; attrs: string[]; consts: Const[]; explode?: boolean }
export interface DocContent { media: string; ty?: string; item?: string }
export interface DocResponse { status: number; description: string; headers: string[]; contents: DocContent[] }

export interface Op {
  id: string;
  /** The `operationId` of the document. */
  operationId: string;
  trait: string;
  path: string;
  method: string;
  extensions: Extension[];
  params: Param[];
  body?: string;
  /** Whether the request may have no body (`@body body?: T`), `Input::body` then being `Option<T>`. */
  bodyOptional: boolean;
  /** The media type the contract states for the body, when it states one. */
  bodyMedia?: string;
  /** The status a body that does not decode is refused with (400 or 422), when the contract lists one. */
  inputRefusal?: number;
  answers: Answer[];
  events?: Events;
  summary?: string;
  description?: string;
  docParams: DocParam[];
  /** The `@tag`s of the operation. */
  tags: string[];
  deprecated: boolean;
  /** The operation's `SUMMARY` and `DESCRIPTION`. */
  consts: Const[];
  docResponses: DocResponse[];
}

// ---------------------------------------------------------------------------------------------------------------------
// The JSON Schema of a Rust wire type, for the schemas a derive cannot write
// ---------------------------------------------------------------------------------------------------------------------

export const q = (s: string) => JSON.stringify(s);

/**
 * A JSON number as Rust source. A whole number beyond `i32` is suffixed `i64`, or the literal would not fit the type it is inferred as;
 * one beyond `i64` is a float, which is what JSON holds it as.
 */
export function rustNumber(n: number): string {
  if (!Number.isInteger(n) || (n >= -2147483648 && n <= 2147483647)) return String(n);
  if (n >= -9223372036854775808 && n < 9223372036854775808) return `${n}_i64`;
  const text = String(n);
  return /[.e]/i.test(text) ? text : `${text}.0`;
}

/** A JSON value as the Rust source of a `json!` macro argument. */
export function rustJson(value: unknown): string {
  if (typeof value === "number") return rustNumber(value);
  if (Array.isArray(value)) return `[${value.map(rustJson).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${rustJson(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

/** A JSON value as a Rust expression that parses it from text: no macro to expand, so no limit on its size. */
export const jsonText = (value: unknown) => `serde_json::from_str::<serde_json::Value>(${rustStr(JSON.stringify(value))}).expect("valid JSON")`;

/** A Rust raw string literal for any text (a pattern's backslashes and quotes stay as written). */
export function rustStr(s: string): string {
  // A raw string cannot hold a bare carriage return.
  if (s.includes("\r")) return JSON.stringify(s).replace(/\\u([0-9a-f]{4})/g, "\\u{$1}");
  let hashes = "#";
  while (s.includes(`"${hashes}`)) hashes += "#";
  return `r${hashes}"${s}"${hashes}`;
}

const KEYWORDS = new Set(["gen", "as", "break", "const", "continue", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "static", "struct", "trait", "true", "type", "unsafe", "use", "where", "while", "async", "await", "dyn", "abstract", "become", "box", "do", "final", "macro", "override", "priv", "typeof", "unsized", "virtual", "yield", "try"]);

/** Whether a Rust item (a module, a function) cannot be named `id`. */
export const isKeyword = (id: string) => KEYWORDS.has(id) || id === "self" || id === "crate" || id === "super";

/** The Rust field for a wire name: snake_case, and a raw identifier (`r#type`) for a keyword. The wire name stays in `serde(rename)`. */
export function rustField(name: string): string {
  const id = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();
  if (!/[a-z0-9]/.test(id)) throw new Refusal(`${JSON.stringify(name)} has no ASCII letter or digit to make a Rust field of: rename it in the contract`);
  // `self`, `crate` and `super` are keywords that cannot be raw identifiers; the wire name stays in `serde(rename)`.
  return id === "self" || id === "crate" || id === "super" ? `${id}_` : KEYWORDS.has(id) ? `r#${id}` : /^[0-9]/.test(id) ? `_${id}` : id;
}

/** The OpenAPI `format` of a Rust number type, as the TypeSpec emitter writes it. */
const FORMATS: Record<string, string> = {
  i8: "int8", i16: "int16", i32: "int32", i64: "int64", u8: "uint8", u16: "uint16", u32: "uint32", u64: "uint64", f32: "float", f64: "double",
};

/** A Rust type that is a named type of the contract, written bare (`Pet`) or by path (`crate::types::Pet`). */
const isNamed = (ty: string) => /^(?:[a-z_]\w*::)*[A-Z]\w*$/.test(ty);

/** The name of a type of the contract, without the path it is written by. */
export const lastSegment = (ty: string) => ty.slice(ty.lastIndexOf(":") + 1);

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
  // A length is a `usize`, which a suffix would make something else.
  const number = (name: string, value: number) => (name.endsWith("Length") ? String(value) : rustNumber(value));
  return Object.entries(constraintValues(program, p)).map(([name, value]) => `${attribute[name]} = ${typeof value === "string" ? q(value) : number(name, value)}`);
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
