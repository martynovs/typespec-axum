/** Runs the writers over the services of a contract and returns the files: `axum.rs`, and `client.rs` and `irpc.rs` when asked. */
import { getDoc, getNamespaceFullName, getService, type Namespace, type Program, type Type } from "@typespec/compiler";
import { isMetadata, type HttpService } from "@typespec/http";
import { resolveInfo } from "@typespec/openapi";
import { type Events, type Op, type Types, readOp } from "./contract.js";
import { type Config, Refusal } from "./config.js";
import { contractSchemaName, namesPath, onlyPartial, schemaDeps, schemaExpr, withoutPaths } from "./schema.js";
import { generatedNotice, isKeyword, q } from "./rust.js";
import { manualSchema } from "./types/templates.js";
import { axumHeader, contractModule, eventItem, eventsEnum, operationModule } from "./server/templates.js";
import { CLIENT_CRATES, CLIENT_METHODS, checkClientNames, clientHeader, clientModule } from "./client/templates.js";
import { irpcHeader, irpcModule } from "./irpc/templates.js";
import { snake } from "./contract.js";





/**
 * The exact `itemSchema` of a stream, as the TypeSpec emitter writes it, and a placeholder component for utoipa to reference
 * (`finish` swaps one for the other).
 */
function eventSchema(e: Events, { inlined, typesPath }: Config) {
  const variants = e.variants.map((v) => {
    const data = v.plain
      ? '{"contentMediaType": "text/plain", "contentSchema": {"type": "string"}}'
      : `{"contentMediaType": "application/json", "contentSchema": ${schemaExpr(v.ty, inlined, `${typesPath}::`)}}`;
    return `{"properties": {"data": ${data}, "event": {"const": ${q(v.name)}}}}`;
  });
  const item = `json!({
        "type": "object",
        "properties": {"event": {"type": "string"}, "data": {"type": "string"}},
        "required": ["event"],
        "oneOf": [${variants.join(", ")}]
    })`;
  const fn = `${snake(e.name)}_item`;
  const placeholder = manualSchema(e.name, 'json!({"type": "object"})', e.variants.flatMap((v) => schemaDeps(v.ty, inlined, `${typesPath}::`)), e.name + "Item");
  return { fn, code: `${eventItem(fn, item)}\n${placeholder}` };
}

/** Names an operation's trait may not take: items the module or the code in it uses. */
const TRAITS = new Set([
  "Fn", "FnMut", "FnOnce", "AsRef", "AsMut", "Into", "From", "Drop", "Iterator", "IntoIterator", "Eq", "PartialEq", "Ord", "PartialOrd", "Hash",
  "Copy", "Sized", "ToOwned", "ToString", "TryFrom", "TryInto", "Extend", "FromIterator",
  "Operation", "ApiDoc", "Input", "Answer", "Call", "Result", "Option", "Vec", "Box", "Send", "Sync", "Some", "None", "Ok", "Err", "Default",
  "Clone", "Debug", "Self", "String", "AxBytes", "AxState", "AxRequest", "AxResponse", "AxJson", "AxStatusCode", "AxParts", "AxRouter",
  "AxMethod", "AxSse", "AxKeepAlive", "AxEvent", "AxHeaderMap", "AxHeaderValue", "AxIntoResponse",
]);

/** Crates the generated code names in paths: a module of one of these names would take the path. */
const CRATES = new Set(["std", "core", "alloc", "axum", "utoipa", "serde", "serde_json", "form_urlencoded", "percent_encoding", "tokio_stream"]);

/**
 * The Rust names of the schemas a namespace declares. Templates are written out where they are used, and a model that holds a
 * status code or a header is the shape of a response, not of a body: neither is a schema.
 */
function declared(program: Program, ns: Namespace, rust: (t: Type) => string, out: Set<string>) {
  if (getNamespaceFullName(ns).split(".")[0] === "TypeSpec") return; // the compiler's own, and its libraries'
  const plain = (t: any) => t.name && !t.templateMapper && !t.node?.templateParameters?.length;
  const add = (t: Type) => { const n = rust(t); if (/^[A-Z]\w*$/.test(n) || n.includes("::")) out.add(n); };
  for (const m of ns.models.values()) if (plain(m) && ![...m.properties.values()].some((p) => isMetadata(program, p))) add(m);
  for (const e of ns.enums.values()) add(e);
  for (const u of ns.unions.values()) if (plain(u)) add(u);
  for (const s of ns.scalars.values()) if (plain(s)) add(s);
  for (const c of ns.namespaces.values()) declared(program, c, rust, out);
}

export function generate(program: Program, config: Config, types: Types, services: HttpService[]): { axum: string; client?: string; irpc?: string } {
  // The file refers to the contract's types by path, so none of them can be shadowed by (or shadow) a name the file defines.
  const qualify = (ty: string) => ty.replace(/(?<![\w:])[A-Z]\w*/g, (name) => (types.known(name) ? `${config.typesPath}::${name}` : name));
  const bare = types.rust;
  const rust = (t: Type) => qualify(bare(t));
  types = { ...types, rust };
  const out = [generatedNotice(config.generator), axumHeader(config)];
  const clientOut: string[] = config.client ? [clientHeader(config)] : [];
  const irpcOut: string[] = config.irpc ? [irpcHeader(config)] : [];
  const problems: string[] = [];
  const seen = new Map<string, { module: string; key: string; id: string }>();
  const modules = new Set<string>();
  const extensionsUsed = new Set<string>();
  for (const svc of services) {
    if (!getService(program, svc.namespace)) throw new Refusal("the contract has no @service: put its operations in a namespace marked @service");
    // The Rust module is the whole name of the namespace (`Pets.V1` is `pets_v1`), so two services can end in the same word.
    const leaf = (svc.namespace.name || "api").toLowerCase();
    const whole = (getNamespaceFullName(svc.namespace) || "api").toLowerCase().replace(/\./g, "_");
    if (!/^[a-z_][a-z0-9_]*$/.test(whole) || whole === "_") throw new Refusal(`${getNamespaceFullName(svc.namespace)}: the namespace is not a Rust module name (letters, digits and \`_\`, not starting with a digit): rename it in the contract`);
    const module = isKeyword(whole) ? `${whole}_` : whole;
    if (CRATES.has(module)) throw new Refusal(`${whole}: the namespace is named like a crate the generated code uses: rename it in the contract`);
    if (modules.has(module)) throw new Refusal(`${whole}: two services are both the Rust module ${module}: rename one in the contract`);
    modules.add(module);
    const all = svc.operations.map((op) => readOp(program, config, types, problems, svc.namespace, op));
    const routes = new Map<string, string>();
    for (const o of all) {
      if (routes.has(`${o.method} ${o.path}`)) throw new Refusal(`${module}: two operations are both ${o.method.toUpperCase()} ${o.path} (@sharedRoute): a router has one handler for a route`);
      // The router tells routes apart by their shape: `/pets/{id}` and `/pets/{petId}` are one place, and it refuses to hold both.
      const shape = o.path.replace(/\{[^}]*\}/g, "{}");
      const named = routes.get(shape);
      if (named !== undefined && named !== o.path) throw new Refusal(`${module}: ${named} and ${o.path} are one route to the router: name the parameter alike`);
      routes.set(shape, o.path);
      routes.set(`${o.method} ${o.path}`, o.path);
    }
    // An operation both contracts hold is written once, in the first; the others document it from there. They must be the same operation.
    // A route both services declare is written once, in the first, and the second's document lists it from there: so it must be the same
    // operation, to the name and tags the document gives it.
    const wire = (o: Op) =>
      JSON.stringify([o.operationId, o.tags, o.deprecated, o.summary, o.description, o.params, o.docParams, o.body, o.bodyOptional, o.inputRefusal, o.answers, o.docResponses, o.extensions]);
    for (const o of all) {
      const first = seen.get(`${o.method} ${o.path}`);
      if (first !== undefined && first.key !== wire(o)) throw new Refusal(`${module}: ${o.method.toUpperCase()} ${o.path} is also served by ${first.module}, and the two differ: the route is written once`);
    }
    const ops = all
      .filter((o) => !seen.has(`${o.method} ${o.path}`))
      .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    const sharedOps = all.filter((o) => seen.has(`${o.method} ${o.path}`));
    const shared = sharedOps.map((o) => {
      const first = seen.get(`${o.method} ${o.path}`)!;
      return `super::${first.module}::${first.id}::run`;
    });
    ops.forEach((o) => seen.set(`${o.method} ${o.path}`, { module, key: wire(o), id: o.id }));

    const schemas = new Set<string>();
    declared(program, svc.namespace, bare, schemas);
    // `schemas` holds the types the emitter writes; one the application writes is a component by its own path, which utoipa reaches only through a type that holds it.
    const componentPaths = new Set([...config.typeMap.values()].filter((e) => !e.inline).map((e) => e.path));
    const mapped = [...schemas].filter((name) => componentPaths.has(name));
    for (const name of [...schemas]) if (!types.known(name) && (name.includes("::") || name === "String")) schemas.delete(name);
    const ids = new Set<string>();
    const traits = new Set<string>();
    const mentionedNames = new Set<string>();
    // A type a parameter, body, answer or event names is a schema of the document even when the namespace does not declare it. The
    // operations a service shares from another are in its document too.
    const mention = (o: Op) => {
      for (const p of config.document === "none" ? [] : o.docParams) {
        for (const entry of config.typeMap.values()) {
          if (onlyPartial(entry) && p.ty !== undefined && p.ty !== entry.path && namesPath(p.ty, entry.path)) throw new Refusal(`${module}: ${o.id} has the parameter ${p.name} of ${p.ty}, which holds ${entry.path}, a type-map entry with inline: true: utoipa takes whether a parameter is optional, and the element of a list, from ToSchema, so only a required parameter of the type itself is written`);
        }
      }
      for (const variant of config.document === "none" ? [] : o.events?.variants ?? []) {
        for (const entry of config.typeMap.values()) {
          if (entry.contract && namesPath(variant.ty, entry.path)) throw new Refusal(`${module}: the event ${variant.name} of ${o.id} holds ${entry.path}, a type-map entry with schema: contract: the schema of an event is not written from the contract, so put it in a model`);
        }
      }
      // utoipa asks for `ToSchema` of a body or an answer (a list's element too), which a type of `inline: true` has not: it is for fields and parameters.
      for (const ty of config.document === "none" ? [] : [o.body, ...o.answers.map((a) => a.ty), ...o.docResponses.flatMap((r) => r.contents.map((c) => c.ty)), ...(o.events?.variants.map((v) => v.ty) ?? [])]) {
        for (const entry of config.typeMap.values()) {
          if (onlyPartial(entry) && ty !== undefined && namesPath(ty, entry.path)) throw new Refusal(`${module}: ${o.id} has ${ty} as a body or an answer, which holds ${entry.path}, a type-map entry with inline: true: utoipa takes the schema of a body or an answer from ToSchema, so put it in a model`);
        }
      }
      const mentioned = [o.body, ...o.answers.map((a) => a.ty), ...o.docParams.map((p) => p.ty), ...o.docResponses.flatMap((r) => r.contents.map((c) => c.ty)), ...(o.events?.variants.map((v) => v.ty) ?? [])];
      for (const ty of mentioned) {
        for (const [, name] of withoutPaths(ty ?? "", [...config.typeMap.values()].map((e) => e.path)).matchAll(/(?:\w+::)*([A-Z]\w*)/g)) {
          if (types.known(name)) mentionedNames.add(name);
          if (types.known(name) && !config.inlined.has(name) && !types.generic(name)) schemas.add(name);
        }
        // A type the application writes that an operation names (a parameter, say, which utoipa does not collect) is a component too.
        for (const entry of config.typeMap.values()) {
          if (!entry.inline && namesPath(ty ?? "", entry.path) && !mapped.includes(entry.path)) mapped.push(entry.path);
        }
      }
    };
    for (const o of ops) {
      if (ids.has(o.id)) throw new Refusal(`${module}: two operations are both ${o.id}: rename one in the contract`);
      ids.add(o.id);
      // The variant of one operation (\`AB\` for \`a_b\`) is the constant of another (\`ab\`): the two would be one name of \`Operation\`.
      const clash = ops.find((other) => other !== o && other.trait === o.id.toUpperCase());
      if (clash) throw new Refusal(`${module}: the operations ${clash.id} and ${o.id} would both be ${clash.trait} in \`Operation\` (the variant of one, the constant of the other): rename one in the contract`);
      if (o.id.toUpperCase() === o.trait) throw new Refusal(`${module}: the operation ${o.id} is one word of one letter, so its variant and its constant of \`Operation\` would both be ${o.trait}: rename it in the contract`);
      if (CRATES.has(o.id)) throw new Refusal(`${module}: the operation ${o.id} is named like a crate the generated code uses: rename it in the contract`);
      if (TRAITS.has(o.trait) || o.id === "all") throw new Refusal(`${module}: the operation ${o.id} takes a name the generated code uses (${o.id === "all" ? "ALL" : o.trait}): rename it in the contract`);
      if (traits.has(o.trait)) throw new Refusal(`${module}: two operations are both the trait ${o.trait}: rename one in the contract`);
      traits.add(o.trait);
      mention(o);
    }
    sharedOps.forEach(mention);
    // The document of a service holds its operations' ids once each, those it shares from another service included.
    const operationIds = new Set<string>();
    for (const o of [...ops, ...sharedOps]) {
      if (operationIds.has(o.operationId)) throw new Refusal(`${module}: two operations are both the operationId ${o.operationId}: rename one in the contract`);
      operationIds.add(o.operationId);
    }
    // A type only a field that utoipa is told not to follow refers to would be missing from the document.
    const reached = types.closure([...schemas, ...mentionedNames]);
    for (const name of types.hidden()) if (reached.has(name)) schemas.add(name);
    // A type the application writes that only a field of a type of this document holds is in it too.
    for (const path of types.mappedHeld(reached)) if (!mapped.includes(path)) mapped.push(path);
    const unions = new Map<string, Events>();
    for (const o of ops) if (o.events) unions.set(o.events.name, o.events);
    for (const name of unions.keys()) {
      if (traits.has(name) || TRAITS.has(name)) throw new Refusal(`${module}: the stream ${name} takes the name of an operation's trait or of a type the generated code uses: rename one in the contract`);
    }
    // A document names a schema by the Rust ident, so a type the application writes (`type-map`) that this document holds may not share one
    // with a type of it the emitter writes (a type of the contract, an event union, its item placeholder) or with another mapped type: one
    // would replace the other in the components. A mapped type is listed once, whichever way its path starts (`::crate::x::L`, `crate::x::L`).
    const listed = new Set<string>();
    const components = mapped.filter((path) => !listed.has(path.replace(/^::/, "")) && listed.add(path.replace(/^::/, "")));
    if (config.document !== "none") {
      const held = new Set([...[...reached, ...schemas].filter((name) => types.known(name)), ...unions.keys(), ...[...unions.keys()].map((name) => `${name}Item`), ...[...config.inlined].filter((name) => !name.startsWith("=") && !name.startsWith("@"))]);
      const owners = new Map<string, string>();
      for (const path of components) {
        const ident = path.slice(path.lastIndexOf(":") + 1);
        const other = owners.get(ident);
        if (other !== undefined) throw new Refusal(`type-map: ${other} and ${path} are both named ${ident}: the document holds one schema for a name, so rename one of them`);
        owners.set(ident, path);
        if (held.has(ident)) throw new Refusal(`type-map: ${path} is named ${ident}, which is also a type the emitter writes into the same document: it holds one schema for a name, so rename one of them`);
      }
    }
    const extensions = [...config.extensionExpr.values()].map((expr) => {
      const has = new Set(ops.filter((o) => o.extensions.some((e) => e.name === expr.name)).map((o) => o.id));
      const lacking = ops.filter((o) => !has.has(o.id)).map((o) => o.operationId);
      if (expr.required && lacking.length) throw new Refusal(`${module}: extension-expr says ${expr.name} is required, and ${lacking.join(", ")} state none`);
      if (has.size) extensionsUsed.add(expr.name);
      return { expr, has };
    });
    if (config.client) {
      const bad = all.find((o) => CLIENT_METHODS.has(o.id));
      const crate = all.find((o) => CLIENT_CRATES.has(o.id));
      if (crate) throw new Refusal(`${module}: the operation ${crate.id} is named like a crate the client uses: rename it in the contract`);
      if (CLIENT_CRATES.has(module)) throw new Refusal(`${module}: the namespace is named like a crate the client uses: rename it in the contract`);
      checkClientNames(module, all);
      if (bad) throw new Refusal(`${module}: the operation ${bad.id} takes the name of a method of the client (${[...CLIENT_METHODS].join(", ")}): rename it in the contract`);
      const sortedOps = [...all].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
      clientOut.push(clientModule(module, sortedOps, config));
      // The protocol's variants are the operations by id: the order does not depend on which file declares what, or on the order of the imports.
      if (config.irpc) irpcOut.push(irpcModule(module, [...all].sort((a, b) => a.id.localeCompare(b.id)), config));
    }
    const documented = config.document !== "none";
    const schemaOf = new Map(documented ? [...unions.values()].map((e) => [e.name, eventSchema(e, config)] as const) : []);

    // The document's info is what `@service`, `@summary` and `@info` say; `@info` entries this generator has no attribute for fail here.
    const about = resolveInfo(program, svc.namespace) ?? {};
    const unsupported = Object.entries(about).filter(([key, value]) => value !== undefined && !["title", "description", "version"].includes(key));
    if (unsupported.length) throw new Refusal(`${module}: @info ${unsupported.map(([key]) => key).join(", ")} is not generated`);
    const description = about.description ?? getDoc(program, svc.namespace);
    const info = [`title = ${q(about.title ?? leaf)}`, `version = ${q(about.version ?? "0.0.0")}`];
    if (description) info.push(`description = ${q(description)}`);

    out.push(contractModule({
      module,
      documented,
      extensions,
      ops,
      info,
      paths: [...ops.map((o) => `${o.id}::run`), ...shared],
      // Every type the namespace declares is a schema, reachable or not (`omit-unreachable-types: false`), and so is each event item.
      components: [...[...schemas].map((s) => `${config.typesPath}::${s}`), ...components.map((path) => ([...config.typeMap.values()].some((e) => e.path === path && e.contract) ? `${config.typesPath}::${contractSchemaName(path)}` : path)), ...unions.keys()],
      items: [...schemaOf].map(([name, s]) => `(${q(name + "Item")}, ${s.fn}())`),
      operations: [...ops, ...sharedOps].map((o) => `(${q(o.operationId)}, &[${o.tags.map(q).join(", ")}], ${o.deprecated}, ${o.body ? `Some(${!o.bodyOptional})` : "None"})`),
      body: [
        ...ops.map((o) => {
          const code = operationModule(o, config);
          for (const { expr, has } of extensions) {
            // The constant takes a name of the operation's module: one the module already defines would be defined twice.
            if (has.has(o.id) && code.split(`pub const ${expr.const}:`).length !== 2) throw new Refusal(`${module}: extension-expr names the constant ${expr.const}, which the module of the operation ${o.id} defines already: name another`);
          }
          return code;
        }),
        ...[...unions.values()].flatMap((e) => [eventsEnum(e), ...(documented ? [schemaOf.get(e.name)!.code] : [])]),
      ],
    }));
  }
  const unusedExtensions = [...config.extensionExpr.keys()].filter((name) => !extensionsUsed.has(name));
  if (unusedExtensions.length) throw new Refusal(`extension-expr: no operation states ${unusedExtensions.join(", ")}`);
  if (problems.length) throw new Refusal(`untyped responses are not generated; name their shape in the contract:\n  ${problems.join("\n  ")}`);
  return { axum: out.join("\n"), client: config.client ? clientOut.join("\n") : undefined, irpc: config.irpc ? irpcOut.join("\n") : undefined };
}
