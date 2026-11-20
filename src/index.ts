/** The emitter's entry point: its library (name and options) and `$onEmit`, which writes `types.rs` and `axum.rs`. */
import { createTypeSpecLibrary, emitFile, NoTarget, paramMessage, resolvePath, type EmitContext, type JSONSchemaType } from "@typespec/compiler";
import { getAllHttpServices } from "@typespec/http";
import pkg from "../package.json" with { type: "json" };
import { emitAxum } from "./axum.js";
import { Refusal, type Config } from "./common.js";
import { Emitter } from "./emitter.js";
import { generatedNotice, typesHeader } from "./templates.js";

export interface EmitterOptions {
  /** Rust path of the module that holds `types.rs`. Default `crate::types`. */
  "types-path"?: string;
  /** Rust path of the type handlers refuse with (`IntoResponse`, `From<StatusCode>`). Default: one `axum.rs` defines. */
  "refusal-type"?: string;
  /** The longest query string a generated handler parses. Default 4096. */
  "max-query-bytes"?: number;
  /** How deep a JSON request body may nest (`{` and `[`) before it is parsed. Default 32. */
  "max-json-depth"?: number;
  /** The most `&`-separated pairs a generated handler parses. Default 64. */
  "max-query-pairs"?: number;
  /** `forbid` (default) fails the emit for a response with no named shape; `allow` types it `serde_json::Value`. */
  "untyped-responses"?: "forbid" | "allow";
  /** `derived` (default): the document utoipa's derives write. `typespec`: schemas written by hand to match `@typespec/openapi3` exactly. */
  document?: "derived" | "typespec";
  /** Whether a JSON body is read only from a request whose `Content-Type` is JSON. Default `true`. */
  "require-json-content-type"?: boolean;
}

const options: JSONSchemaType<EmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    "types-path": { type: "string", nullable: true, description: "Rust path of the module that holds `types.rs`.", default: "crate::types" },
    "refusal-type": { type: "string", nullable: true, description: "Rust path of the type handlers refuse with." },
    "max-query-bytes": { type: "integer", nullable: true, minimum: 1, maximum: 4294967295, description: "The longest query string a generated handler parses (at most what a 32-bit `usize` holds).", default: 4096 },
    "max-json-depth": { type: "integer", nullable: true, minimum: 1, maximum: 128, description: "How deep a JSON request body may nest before it is parsed (serde_json itself stops at 128).", default: 32 },
    "max-query-pairs": { type: "integer", nullable: true, minimum: 1, maximum: 4294967295, description: "The most pairs a generated handler parses (at most what a 32-bit `usize` holds).", default: 64 },
    document: { type: "string", enum: ["derived", "typespec"], nullable: true, description: "How exact to `@typespec/openapi3` the document is.", default: "derived" },
    "require-json-content-type": { type: "boolean", nullable: true, description: "Whether a JSON body needs a JSON Content-Type.", default: true },
    "untyped-responses": { type: "string", enum: ["forbid", "allow"], nullable: true, description: "Whether a response may carry an untyped value.", default: "forbid" },
  },
  required: [],
};

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
  const config: Config = {
    generator: $lib.name,
    typesPath,
    refusalType: o["refusal-type"],
    maxQueryBytes: o["max-query-bytes"] ?? 4096,
    maxQueryPairs: o["max-query-pairs"] ?? 64,
    maxJsonDepth: o["max-json-depth"] ?? 32,
    allowUntyped: o["untyped-responses"] === "allow",
    document: o.document ?? "derived",
    requireJson: o["require-json-content-type"] ?? true,
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
  const types = `${generatedNotice(config.generator)}\n${typesHeader}\n${[...em.defs.values()].join("\n\n")}\n`;
  await emitFile(program, { path: resolvePath(context.emitterOutputDir, "types.rs"), content: types });
  await emitFile(program, { path: resolvePath(context.emitterOutputDir, "axum.rs"), content: axum });
}
