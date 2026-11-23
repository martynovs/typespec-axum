/** The options of the emitter: what they are, how they are written in `tspconfig.yaml`, and the check that turns them into a `Config`. */
import type { JSONSchemaType } from "@typespec/compiler";
import type { Config, ExtensionExpr, TypeMapEntry } from "./config.js";
import { inlineSchema } from "./schema.js";
import { isKeyword } from "./rust.js";

export interface EmitterOptions {
  /** Rust path of the module that holds `types.rs`. Default `crate::types`. */
  "types-path"?: string;
  /** Rust path of the type handlers refuse with (`IntoResponse`, `From<StatusCode>`). Default: one `axum.rs` defines. */
  "refusal-type"?: string;
  /** Rust path of the function that refuses a request that cannot be read: `fn(StatusCode, &'static str) -> Refused`. Default: a text answer. */
  "reject-with"?: string;
  /** Whether `axum.rs` is written: the endpoints. Default `true`; `false` needs `document: none` (the document is the server's). */
  server?: boolean;
  /** Whether `client.rs` is written: a client of the contract, over a `Transport` the application implements. Default `false`. */
  client?: boolean;
  /** The most of a response body the client reads (and of one line of an event stream); a longer one is an error. Default 16777216. */
  "client-max-body-bytes"?: number;
  /** Whether `client.rs` also has a `Reqwest` transport (needs `client`). Default `false`. */
  "client-reqwest"?: boolean;
  /** Rust path of the module that holds `client.rs`, from the crate (`crate::...`). Default `crate::client`. */
  "client-path"?: string;
  /** Whether `irpc.rs` is written: the contract as an irpc protocol over the client's `Api` (needs `client`). Default `false`. */
  irpc?: boolean;
  /** Whether a type derives `Eq` when every part of it is `Eq` (no float, and each type of the `type-map` says it is). Default `false`. */
  "derive-eq"?: boolean;
  /** The longest query string a generated handler parses. Default 4096. */
  "max-query-bytes"?: number;
  /** How deep a JSON request body may nest (`{` and `[`) before it is parsed. Default 32. */
  "max-json-depth"?: number;
  "max-upload-bytes"?: number;
  "max-form-field-bytes"?: number;
  "max-form-parts"?: number;
  /** The most `&`-separated pairs a generated handler parses. Default 64. */
  "max-query-pairs"?: number;
  /** `forbid` (default) fails the emit for a response with no named shape; `allow` types it `serde_json::Value`. */
  "untyped-responses"?: "forbid" | "allow";
  /** `derived` (default): the document utoipa's derives write. `typespec`: schemas written by hand to match `@typespec/openapi3` exactly. `none`: no document, and the generated code does not use utoipa. */
  document?: "derived" | "typespec" | "none";
  /** With `document: typespec`, how an enum is written, as the option of `@typespec/openapi3` of this name: `default` (one `enum`), or `annotated` (a `oneOf` of `const` members, with their `@summary` and `@doc`). */
  "enum-strategy"?: "default" | "annotated";
  /** Whether a JSON body is read only from a request whose `Content-Type` is JSON. Default `true`. */
  "require-json-content-type"?: boolean;
  /**
   * Types the contract names that the application writes itself: the contract's name (`Name`, or `Namespace::Name` when types of that name are in
   * more than one namespace) to the Rust path, or `{ path, eq, partial-eq, inline, schema }`. The emitter writes no type for it; every reference names the path.
   */
  "type-map"?: Record<string, string | { path: string; eq?: boolean; "partial-eq"?: boolean; inline?: boolean; schema?: "contract" }>;
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
  description: "Types the application writes itself: the contract's name to a Rust path, or to { path, eq, partial-eq, inline, schema }.",
  additionalProperties: {
    anyOf: [
      { type: "string" },
      { type: "object", properties: { path: { type: "string" }, eq: { type: "boolean", nullable: true }, "partial-eq": { type: "boolean", nullable: true }, inline: { type: "boolean", nullable: true }, schema: { type: "string", enum: ["contract", null as never], nullable: true } }, required: ["path"], additionalProperties: false },
    ],
  },
};

export const options: JSONSchemaType<EmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    "types-path": { type: "string", nullable: true, description: "Rust path of the module that holds `types.rs`.", default: "crate::types" },
    "refusal-type": { type: "string", nullable: true, description: "Rust path of the type handlers refuse with." },
    "reject-with": { type: "string", nullable: true, description: "Rust path of the function that makes the refusal of a request that cannot be read." },
    server: { type: "boolean", nullable: true, description: "Whether axum.rs is written.", default: true },
    client: { type: "boolean", nullable: true, description: "Whether client.rs is written.", default: false },
    "client-max-body-bytes": { type: "integer", nullable: true, minimum: 1, maximum: 4294967295, description: "The most of a response body the client reads.", default: 16777216 },
    "client-reqwest": { type: "boolean", nullable: true, description: "Whether client.rs also has a transport over reqwest.", default: false },
    "client-path": { type: "string", nullable: true, description: "Rust path of the module that holds client.rs.", default: "crate::client" },
    irpc: { type: "boolean", nullable: true, description: "Whether irpc.rs is written.", default: false },
    "derive-eq": { type: "boolean", nullable: true, description: "Whether a type derives Eq when every part of it is Eq.", default: false },
    "max-query-bytes": { type: "integer", nullable: true, minimum: 1, maximum: 4294967295, description: "The longest query string a generated handler parses (at most what a 32-bit `usize` holds).", default: 4096 },
    "max-upload-bytes": { type: "integer", nullable: true, minimum: 1, maximum: 4294967295, description: "The most a request body may hold on an operation that takes a file or a form: set on its route as axum's `DefaultBodyLimit`, in place of the 2 MiB axum (or the application's layer) allows. Unset, axum's own limit applies." },
    "max-form-field-bytes": { type: "integer", nullable: true, minimum: 1, maximum: 4294967295, description: "The most one part of a form that is text or JSON may hold (a file part is bounded by the body's limit).", default: 65536 },
    "max-form-parts": { type: "integer", nullable: true, minimum: 1, maximum: 65535, description: "The most parts a form may have.", default: 128 },
    "max-json-depth": { type: "integer", nullable: true, minimum: 1, maximum: 128, description: "How deep a JSON request body may nest before it is parsed (serde_json itself stops at 128).", default: 32 },
    "max-query-pairs": { type: "integer", nullable: true, minimum: 1, maximum: 4294967295, description: "The most pairs a generated handler parses (at most what a 32-bit `usize` holds).", default: 64 },
    "enum-strategy": { type: "string", enum: ["default", "annotated"], nullable: true, description: "With `document: typespec`, how an enum is written, as `@typespec/openapi3`'s option of this name.", default: "default" },
    document: { type: "string", enum: ["derived", "typespec", "none"], nullable: true, description: "How exact to `@typespec/openapi3` the document is, or `none` for no document and no utoipa. With a `type-map`, each mapped type must implement `utoipa::ToSchema` (a type that has only a `PartialSchema`, such as `uuid::Uuid`: `inline: true` in its entry), which rustc checks, not the emitter.", default: "derived" },
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
    if (!/^[A-Z][A-Z0-9_]*$/.test(v.const)) return { map, error: `${where}: const ${JSON.stringify(v.const)} is not an UPPER_CASE name (a constant of an operation's module: a lower-case one could be a function of it)` };
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
    // With a document, a path that names no schema (a primitive, `String`, a `std` or generic type) is written in place; `inline` says so of any other (`uuid::Uuid`).
    const said = typeof value === "object" ? value.inline : undefined;
    if (said === false && inlineSchema(path)) return { map, error: `type-map: ${name} is mapped to ${JSON.stringify(path)}, which names no schema of the document (a primitive, String, a std or generic type): it is written in place, so it takes no inline: false` };
    const inline = said ?? inlineSchema(path);
    const contract = (typeof value === "object" ? value.schema : undefined) === "contract";
    // `schema: contract` on a primitive (`Instant: String`) keeps the primitive as the type and gives the document the scalar's own component.
    const scalar = contract && inlineSchema(path);
    if (contract && said !== undefined) return { map, error: `type-map: ${name} says both schema: contract and inline: the schema is the contract's, or the type's own PartialSchema, not both` };
    const entry = { path, eq, inline: scalar ? true : contract ? false : inline, contract: contract && !scalar, scalar, partialEq: (typeof value === "object" ? value["partial-eq"] : undefined) ?? true };
    if (!RUST_PATH.test(entry.path) || /^(super|self)\b/.test(entry.path)) {
      return { map, error: `type-map: ${name} is mapped to ${JSON.stringify(entry.path)}, which is not a Rust path from the crate (\`crate::...\`, \`std::...\` or a dependency's); \`super::\` and \`self::\` are refused, the modules sit at different depths` };
    }
    map.set(name, entry);
  }
  return { map };
}

/** The settings the writers read, from what the user wrote in `tspconfig.yaml`, or the message of the first thing that cannot be. */
export function resolveConfig(o: EmitterOptions, generator: string): { config: Config } | { error: string } {
  const typesPath = o["types-path"] ?? "crate::types";
  const fromTheCrate = (name: string, path: string, inAModule = false) =>
    !RUST_PATH.test(path) || (inAModule && !IN_A_MODULE.test(path)) || /^(super|self)\b/.test(path)
      ? `${name} ${JSON.stringify(path)} is not a Rust path from the crate (\`crate::...\`): the generated modules sit at different depths, so \`super::\` and \`self::\` are refused`
      : undefined;
  const bad = fromTheCrate("types-path", typesPath)
    ?? (o["reject-with"] !== undefined ? fromTheCrate("reject-with", o["reject-with"], true) : undefined)
    ?? (o["client-path"] !== undefined ? fromTheCrate("client-path", o["client-path"], true) : undefined);
  if (bad) return { error: bad };
  if (o["client-reqwest"] && !o.client) return { error: "client-reqwest needs client: the transport is part of client.rs" };
  if (o.server === false) {
    const needs = [o.document !== undefined && o.document !== "none" ? "document" : "", o["reject-with"] !== undefined ? "reject-with" : "", o["refusal-type"] !== undefined ? "refusal-type" : "", Object.keys(o["extension-expr"] ?? {}).length ? "extension-expr" : ""].filter(Boolean);
    if (needs.length) return { error: `server: false leaves axum.rs out, which ${needs.join(", ")} ${needs.length > 1 ? "are" : "is"} for` };
  }
  if (o.irpc && !o.client) return { error: "irpc needs client: the protocol is served from and called through the client's Api" };
  const document = o.document ?? (o.server === false ? "none" : "derived");
  if (o["enum-strategy"] === "annotated" && document !== "typespec") return { error: "enum-strategy: annotated is for document: typespec, which writes the enums of the document by hand" };
  const typeMap = readTypeMap(o["type-map"]);
  if (typeMap.error) return { error: typeMap.error };
  const expr = readExtensionExpr(o["extension-expr"]);
  if (expr.error) return { error: expr.error };
  return {
    config: {
      generator,
      typesPath,
      refusalType: o["refusal-type"],
      rejectWith: o["reject-with"],
      deriveEq: o["derive-eq"] ?? false,
      server: o.server ?? true,
      client: o.client ?? false,
      clientReqwest: o["client-reqwest"] ?? false,
      clientMaxBodyBytes: o["client-max-body-bytes"] ?? 16777216,
      clientPath: o["client-path"] ?? "crate::client",
      irpc: o.irpc ?? false,
      maxQueryBytes: o["max-query-bytes"] ?? 4096,
      maxQueryPairs: o["max-query-pairs"] ?? 64,
      maxJsonDepth: o["max-json-depth"] ?? 32,
      maxUploadBytes: o["max-upload-bytes"] ?? undefined,
      maxFormFieldBytes: o["max-form-field-bytes"] ?? 65536,
      maxFormParts: o["max-form-parts"] ?? 128,
      allowUntyped: o["untyped-responses"] === "allow",
      document,
      enumStrategy: o["enum-strategy"] ?? "default",
      requireJson: o["require-json-content-type"] ?? true,
      typeMap: typeMap.map,
      extensionExpr: expr.map,
      inlined: new Set(),
      exact: new Map(),
      exactProperties: [],
    },
  };
}
