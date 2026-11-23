/** The emitter's entry point: its library (name and options) and `$onEmit`, which writes `types.rs`, and `axum.rs`, `client.rs` and `irpc.rs` when asked. */
import { createTypeSpecLibrary, emitFile, NoTarget, paramMessage, resolvePath, type EmitContext } from "@typespec/compiler";
import { getAllHttpServices } from "@typespec/http";
import pkg from "../package.json" with { type: "json" };
import { Refusal } from "./config.js";
import { generate } from "./generate.js";
import { options, resolveConfig, type EmitterOptions } from "./options.js";
import { generatedNotice } from "./rust.js";
import { typesHeader } from "./types/templates.js";
import { TypeWriter } from "./types/writer.js";

export type { EmitterOptions } from "./options.js";

/** The emitter is named by its package, which is also what the generated files say wrote them. */
export const $lib = createTypeSpecLibrary({
  name: pkg.name,
  diagnostics: { unsupported: { severity: "error", messages: { default: paramMessage`${"message"}` } } },
  emitter: { options },
});

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const refuse = (message: string) => $lib.reportDiagnostic(program, { code: "unsupported", format: { message }, target: NoTarget });
  const resolved = resolveConfig(context.options, $lib.name);
  if ("error" in resolved) return refuse(resolved.error);
  const { config } = resolved;
  const [services] = getAllHttpServices(program);
  const types = new TypeWriter(program, config);
  let files: ReturnType<typeof generate>;
  try {
    files = generate(program, config, { rust: (t) => types.rust(t), untyped: (ty) => types.untyped(ty), known: (name) => types.defs.has(name), displayable: (ty) => types.displayable(ty), hidden: () => types.hidden, closure: (roots) => types.closure(roots), mappedHeld: (names) => types.mappedHeld(names), generic: (name) => types.genericStructs.has(name), contractScalars: () => types.contractScalarStructs() }, services);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return refuse(error.message);
  }
  const unused = [...config.typeMap.keys()].filter((name) => !types.mappedKeys.has(name));
  if (unused.length) return refuse(`type-map: ${unused.join(", ")} name no model, enum or scalar of the contract (a template is not mapped; a union cannot be)`);
  const write = (name: string, content: string) => emitFile(program, { path: resolvePath(context.emitterOutputDir, name), content });
  await write("types.rs", `${generatedNotice(config.generator)}\n${typesHeader}\n${types.resolveEq([...types.defs.values()].join("\n\n"))}\n`);
  if (config.server) await write("axum.rs", files.axum);
  if (files.client !== undefined) await write("client.rs", files.client);
  if (files.irpc !== undefined) await write("irpc.rs", files.irpc);
}
