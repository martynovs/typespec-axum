/** The emitter's entry point: its library (name and options) and `$onEmit`, which writes `types.rs` and `axum.rs`. */
import { createTypeSpecLibrary, emitFile, NoTarget, paramMessage, resolvePath, type EmitContext, type JSONSchemaType } from "@typespec/compiler";
import { getAllHttpServices } from "@typespec/http";
import pkg from "../package.json" with { type: "json" };
import { emitAxum } from "./axum.js";
import { Refusal, isKeyword, type Config, type ExtensionExpr, type TypeMapEntry } from "./common.js";
import { Emitter } from "./emitter.js";
import { generatedNotice, typesHeader } from "./templates.js";

export interface EmitterOptions {
  /** Rust path of the module that holds `types.rs`. Default `crate::types`. */
  "types-path"?: string;
  /** Rust path of the type handlers refuse with (`IntoResponse`, `From<StatusCode>`). Default: one `axum.rs` defines. */
  "refusal-type"?: string;
  /** Rust path of the function that refuses a request that cannot be read: `fn(StatusCode, &'static str) -> Refused`. Default: a text answer. */
  "reject-with"?: string;
  /** Whether a type derives `Eq` when every part of it is `Eq` (no float, and each type of the `type-map` says it is). Default `false`. */
  "derive-eq"?: boolean;
  /** The longest query string a generated handler parses. Default 4096. */
  "max-query-bytes"?: number;
  /** How deep a JSON request body may nest (`{` and `[`) before it is parsed. Default 32. */
  "max-json-depth"?: number;
  /** The most `&`-separated pairs a generated handler parses. Default 64. */
  "max-query-pairs"?: number;
  /** `forbid` (default) fails the emit for a response with no named shape; `allow` types it `serde_json::Value`. */
  "untyped-responses"?: "forbid" | "allow";
  /** `derived` (default): the document utoipa's derives write. `typespec`: schemas written by hand to match `@typespec/openapi3` exactly. `none`: no document, and the generated code does not use utoipa. */
  document?: "derived" | "typespec" | "none";
  /** Whether a JSON body is read only from a request whose `Content-Type` is JSON. Default `true`. */
  "require-json-content-type"?: boolean;
  /**
   * Types the contract names that the application writes itself: the contract's name (`Name`, or `Namespace::Name` when types of that name are in
   * more than one namespace) to the Rust path, or `{ path, eq }`. The emitter writes no type for it; every reference names the path.
   */
  "type-map"?: Record<string, string | { path: string; eq?: boolean }>;
  /**
   * Extensions of an operation the application reads at compile time: an extension's name (`x-guard`) to the macro that makes a value
   * of its JSON (`macro!({"scope": "read"})`), the type of that value, the name of the constant each operation's module holds it
   * in, and the name of the method of `Operation` that returns it.
   */
  "extension-expr"?: Record<string, { macro: string; type: string; const: string; accessor: string; required?: boolean }>;
}

const extensionExprSchema = {
  type: "object",
  nullable: true,
  description: "Extensions of an operation the application reads at compile time: the extension's name to { macro, type, const, accessor, required }.",
  additionalProperties: {
    type: "object",
    properties: {
      macro: { type: "string" },
      type: { type: "string" },
      const: { type: "string" },
      accessor: { type: "string" },
      required: { type: "boolean", nullable: true },
    },
    required: ["macro", "type", "const", "accessor"],
    additionalProperties: false,
  },
};

const typeMapSchema = {
  type: "object",
  nullable: true,
  description: "Types the application writes itself: the contract's name to a Rust path, or to { path, eq }.",
  additionalProperties: {
    anyOf: [
      { type: "string" },
      { type: "object", properties: { path: { type: "string" }, eq: { type: "boolean", nullable: true } }, required: ["path"], additionalProperties: false },
    ],
  },
};

const options: JSONSchemaType<EmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    "types-path": { type: "string", nullable: true, description: "Rust path of the module that holds `types.rs`.", default: "crate::types" },
    "refusal-type": { type: "string", nullable: true, description: "Rust path of the type handlers refuse with." },
    "reject-with": { type: "string", nullable: true, description: "Rust path of the function that makes the refusal of a request that cannot be read." },
    "derive-eq": { type: "boolean", nullable: true, description: "Whether a type derives Eq when every part of it is Eq.", default: false },
    "max-query-bytes": { type: "integer", nullable: true, minimum: 1, maximum: 4294967295, description: "The longest query string a generated handler parses (at most what a 32-bit `usize` holds).", default: 4096 },
    "max-json-depth": { type: "integer", nullable: true, minimum: 1, maximum: 128, description: "How deep a JSON request body may nest before it is parsed (serde_json itself stops at 128).", default: 32 },
    "max-query-pairs": { type: "integer", nullable: true, minimum: 1, maximum: 4294967295, description: "The most pairs a generated handler parses (at most what a 32-bit `usize` holds).", default: 64 },
    document: { type: "string", enum: ["derived", "typespec", "none"], nullable: true, description: "How exact to `@typespec/openapi3` the document is, or `none` for no document and no utoipa.", default: "derived" },
    "require-json-content-type": { type: "boolean", nullable: true, description: "Whether a JSON body needs a JSON Content-Type.", default: true },
    "type-map": typeMapSchema as never,
    "extension-expr": extensionExprSchema as never,
    "untyped-responses": { type: "string", enum: ["forbid", "allow"], nullable: true, description: "Whether a response may carry an untyped value.", default: "forbid" },
  },
  required: [],
};

const RUST_IDENT = /^[A-Za-z_]\w*$/;
const RUST_PATH = /^(::)?[A-Za-z_]\w*(::[A-Za-z_]\w*)*$/;
/** A function or a macro is named by a path of a module: a bare name would be the generated function itself. */
const IN_A_MODULE = /::/;

/** The `extension-expr` option as the emitter reads it, or the message of the entry that cannot be. */
function readExtensionExpr(raw: EmitterOptions["extension-expr"]): { map: Map<string, ExtensionExpr>; error?: string } {
  const map = new Map<string, ExtensionExpr>();
  const taken = new Set<string>();
  for (const [name, v] of Object.entries(raw ?? {})) {
    const where = `extension-expr: ${name}`;
    if (!/^x-[\w.-]+$/.test(name)) return { map, error: `${where} is not the name of an extension (it starts with x-)` };
    for (const [what, path] of [["macro", v.macro], ["type", v.type]]) {
      if (!RUST_PATH.test(path) || (what === "macro" && !IN_A_MODULE.test(path)) || /^(super|self)\b/.test(path)) return { map, error: `${where}: ${what} ${JSON.stringify(path)} is not a Rust path from the crate (\`crate::...\`): \`super::\` and \`self::\` are refused` };
    }
    for (const [what, ident] of [["const", v.const], ["accessor", v.accessor]]) {
      if (!RUST_IDENT.test(ident) || isKeyword(ident)) return { map, error: `${where}: ${what} ${JSON.stringify(ident)} is not a name Rust accepts` };
      if (taken.has(ident)) return { map, error: `${where}: ${ident} is the name of another extension's ${what} or constant` };
      taken.add(ident);
    }
    if (v.accessor === "all" || v.accessor === "as_ref") return { map, error: `${where}: accessor ${v.accessor} is a method \`Operation\` has already` };
    map.set(name, { name, macro: v.macro, type: v.type, const: v.const, accessor: v.accessor, required: v.required ?? false });
  }
  return { map };
}

/** The `type-map` option as the emitter reads it, or the message of the entry that cannot be. */
function readTypeMap(raw: EmitterOptions["type-map"]): { map: Map<string, TypeMapEntry>; error?: string } {
  const map = new Map<string, TypeMapEntry>();
  for (const [name, value] of Object.entries(raw ?? {})) {
    const path = typeof value === "string" ? value : value.path;
    // A type of the standard library that is `Eq` needs no word of the entry.
    const eq = (typeof value === "object" ? value.eq : undefined) ?? /^(std::string::)?(String|bool|char|[iu](8|16|32|64|128|size))$/.test(path);
    const entry = { path, eq };
    if (!RUST_PATH.test(entry.path) || /^(super|self)\b/.test(entry.path)) {
      return { map, error: `type-map: ${name} is mapped to ${JSON.stringify(entry.path)}, which is not a Rust path from the crate (\`crate::...\`, \`std::...\` or a dependency's); \`super::\` and \`self::\` are refused, the modules sit at different depths` };
    }
    map.set(name, entry);
  }
  return { map };
}

/** The emitter is named by its package, which is also what the generated files say wrote them. */
export const $lib = createTypeSpecLibrary({
  name: pkg.name,
  diagnostics: { unsupported: { severity: "error", messages: { default: paramMessage`${"message"}` } } },
  emitter: { options },
});

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const o = context.options;
  const typesPath = o["types-path"] ?? "crate::types";
  if (/^(super|self)\b/.test(typesPath)) {
    $lib.reportDiagnostic(program, { code: "unsupported", format: { message: `types-path ${typesPath} is relative; the generated modules sit at different depths, so give it from the crate (\`crate::...\`)` }, target: NoTarget });
    return;
  }
  if (o["reject-with"] !== undefined && (!RUST_PATH.test(o["reject-with"]) || !IN_A_MODULE.test(o["reject-with"]) || /^(super|self)\b/.test(o["reject-with"]))) {
    $lib.reportDiagnostic(program, { code: "unsupported", format: { message: `reject-with ${JSON.stringify(o["reject-with"])} is not a Rust path from the crate (\`crate::...\`): \`super::\` and \`self::\` are refused` }, target: NoTarget });
    return;
  }
  const typeMap = readTypeMap(o["type-map"]);
  if (typeMap.error || (typeMap.map.size > 0 && (o.document ?? "derived") !== "none")) {
    const message = typeMap.error ?? "type-map needs document: none: a type the application writes has no schema for the document";
    $lib.reportDiagnostic(program, { code: "unsupported", format: { message }, target: NoTarget });
    return;
  }
  const expr = readExtensionExpr(o["extension-expr"]);
  if (expr.error) {
    $lib.reportDiagnostic(program, { code: "unsupported", format: { message: expr.error }, target: NoTarget });
    return;
  }
  const config: Config = {
    generator: $lib.name,
    typesPath,
    refusalType: o["refusal-type"],
    rejectWith: o["reject-with"],
    deriveEq: o["derive-eq"] ?? false,
    maxQueryBytes: o["max-query-bytes"] ?? 4096,
    maxQueryPairs: o["max-query-pairs"] ?? 64,
    maxJsonDepth: o["max-json-depth"] ?? 32,
    allowUntyped: o["untyped-responses"] === "allow",
    document: o.document ?? "derived",
    requireJson: o["require-json-content-type"] ?? true,
    typeMap: typeMap.map,
    extensionExpr: expr.map,
    inlined: new Set(),
  };
  const [services] = getAllHttpServices(program);
  const em = new Emitter(program, config);
  let axum: string;
  try {
    axum = emitAxum(program, config, { rust: (t) => em.rust(t), untyped: (ty) => em.untyped(ty), known: (name) => em.defs.has(name), displayable: (ty) => em.displayable(ty), hidden: () => em.hidden, closure: (roots) => em.closure(roots) }, services);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    $lib.reportDiagnostic(program, { code: "unsupported", format: { message: error.message }, target: NoTarget });
    return;
  }
  const unused = [...config.typeMap.keys()].filter((name) => !em.mappedKeys.has(name));
  if (unused.length) {
    $lib.reportDiagnostic(program, { code: "unsupported", format: { message: `type-map: ${unused.join(", ")} name no model, enum or scalar of the contract (a template is not mapped; a union cannot be)` }, target: NoTarget });
    return;
  }
  const types = `${generatedNotice(config.generator)}\n${typesHeader}\n${em.resolveEq([...em.defs.values()].join("\n\n"))}\n`;
  await emitFile(program, { path: resolvePath(context.emitterOutputDir, "types.rs"), content: types });
  await emitFile(program, { path: resolvePath(context.emitterOutputDir, "axum.rs"), content: axum });
}
