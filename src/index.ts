/** The emitter's entry point: its library (name and options) and `$onEmit`, which writes `types.rs` and `axum.rs`. */
import { createTypeSpecLibrary, emitFile, resolvePath, type EmitContext, type JSONSchemaType } from "@typespec/compiler";
import { getAllHttpServices } from "@typespec/http";
import pkg from "../package.json" with { type: "json" };
import { emitAxum } from "./axum.js";
import type { Config } from "./common.js";
import { Emitter } from "./emitter.js";
import { generatedNotice, typesHeader } from "./templates.js";

export interface EmitterOptions {
  /** Rust path of the module that holds `types.rs`. Default `crate::types`. */
  "types-path"?: string;
  /** Rust path of the type handlers refuse with (`IntoResponse`, `From<StatusCode>`). Default: one `axum.rs` defines. */
  "refusal-type"?: string;
  /** The longest query string a generated handler parses. Default 4096. */
  "max-query-bytes"?: number;
  /** The most `&`-separated pairs a generated handler parses. Default 64. */
  "max-query-pairs"?: number;
  /** `forbid` (default) fails the emit for a response with no named shape; `allow` types it `serde_json::Value`. */
  "untyped-responses"?: "forbid" | "allow";
}

const options: JSONSchemaType<EmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    "types-path": { type: "string", nullable: true, description: "Rust path of the module that holds `types.rs`.", default: "crate::types" },
    "refusal-type": { type: "string", nullable: true, description: "Rust path of the type handlers refuse with." },
    "max-query-bytes": { type: "integer", nullable: true, minimum: 1, description: "The longest query string a generated handler parses.", default: 4096 },
    "max-query-pairs": { type: "integer", nullable: true, minimum: 1, description: "The most pairs a generated handler parses.", default: 64 },
    "untyped-responses": { type: "string", enum: ["forbid", "allow"], nullable: true, description: "Whether a response may carry an untyped value.", default: "forbid" },
  },
  required: [],
};

/** The emitter is named by its package, which is also what the generated files say wrote them. */
export const $lib = createTypeSpecLibrary({ name: pkg.name, diagnostics: {}, emitter: { options } });

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const o = context.options;
  const config: Config = {
    generator: $lib.name,
    typesPath: o["types-path"] ?? "crate::types",
    refusalType: o["refusal-type"],
    maxQueryBytes: o["max-query-bytes"] ?? 4096,
    maxQueryPairs: o["max-query-pairs"] ?? 64,
    allowUntyped: o["untyped-responses"] === "allow",
    inlined: new Set(),
  };
  const [services] = getAllHttpServices(program);
  const em = new Emitter(program, config);
  const axum = emitAxum(program, config, { rust: (t) => em.rust(t), untyped: (ty) => em.untyped(ty) }, services);
  const types = `${generatedNotice(config.generator)}\n${typesHeader}\n${[...em.defs.values()].join("\n\n")}\n`;
  await emitFile(program, { path: resolvePath(context.emitterOutputDir, "types.rs"), content: types });
  await emitFile(program, { path: resolvePath(context.emitterOutputDir, "axum.rs"), content: axum });
}
