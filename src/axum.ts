/** Reads the HTTP operations of a TypeSpec program into `Op`s and assembles the endpoints file from `templates.ts`. */
import { getDoc, getNamespaceFullName, getService, getSummary, getTags, isDeprecated, type Namespace, type Program, type Union, type Type } from "@typespec/compiler";
import { isMetadata, type HttpOperation, type HttpService } from "@typespec/http";
import { getExtensions, getOperationId, resolveInfo } from "@typespec/openapi";
import { getStreamOf } from "@typespec/streams";
import { getContentType } from "@typespec/events";
import { pascalIdent, uniqueNames } from "./emitter.js";
import { Refusal, constPrefix, constraints, facts, isKeyword, q, rustField as field, schemaDeps, schemaExpr, type Config, type DocResponse, type Events, type Op } from "./common.js";
import { axumHeader, contractModule, eventItem, eventsEnum, generatedNotice, manualSchema, operationModule } from "./templates.js";

/** The `Answer` variant of each success or redirect status. A status of 400 or more is a refusal, which no variant holds. */
const VARIANTS: Record<number, string> = {
  200: "Ok", 201: "Created", 202: "Accepted", 203: "NonAuthoritative", 204: "NoContent", 205: "ResetContent", 206: "PartialContent", 207: "MultiStatus",
  300: "MultipleChoices", 301: "MovedPermanently", 302: "Found", 303: "SeeOther", 304: "NotModified", 307: "TemporaryRedirect", 308: "PermanentRedirect",
};

export const pascal = (id: string) => id.split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : "")).join("");
const snake = (id: string) => id.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** What `emitAxum` takes from the type emitter: the Rust type of a TypeSpec type, and where a Rust type holds an untyped value. */
export interface Types {
  rust: (t: Type) => string;
  untyped: (ty: string) => string | undefined;
  /** Whether a Rust type of this name is defined. */
  known: (name: string) => boolean;
  /** Whether a Rust type can be a `text/plain` body: it is written as text. */
  displayable: (ty: string) => boolean;
  /** Types some field refers to without utoipa following it. */
  hidden: () => ReadonlySet<string>;
  /** Every type `roots` are made of. */
  closure: (roots: Iterable<string>) => Set<string>;
}

/** The tags of an operation: those of the interfaces and namespaces it sits in, outermost first, and its own. */
function tagsOf(program: Program, operation: HttpOperation["operation"]): string[] {
  const containers: any[] = [];
  for (let c: any = operation.interface ?? operation.namespace; c; c = c.namespace) containers.unshift(c);
  return [...new Set([...containers.flatMap((c) => getTags(program, c)), ...getTags(program, operation)])];
}

/** Whether a TypeSpec type is an array, or an array or null (`string[] | null`). */
function isArray(t: Type): boolean {
  if (t.kind === "Union") {
    const rest = [...t.variants.values()].map((v) => v.type).filter((v) => !(v.kind === "Intrinsic" && v.name === "null"));
    return rest.length === 1 && isArray(rest[0]);
  }
  // An array, or a model that is one (`model Ids is string[]`).
  return t.kind === "Model" && (t.name === "Array" || (!!t.indexer && t.indexer.key.name === "integer" && t.properties.size === 0));
}

/** A media type without its parameters (`application/json; charset=utf-8` is `application/json`). */
const mediaOf = (type: string) => type.split(";")[0].trim().toLowerCase();

function readOp(program: Program, config: Config, { rust, untyped, displayable }: Types, problems: string[], service: Namespace, op: HttpOperation): Op {
  // An operation of an interface or a namespace of its own is `Container_operation` in the document, as `@typespec/openapi3` names it;
  // an `@operationId` is the name.
  const container = op.operation.interface ?? op.operation.namespace;
  const plain = !container || container === service || !container.name;
  const operationId = getOperationId(program, op.operation) ?? (plain ? op.operation.name : `${container.name}_${op.operation.name}`);
  // The Rust name of the operation is the id made into an identifier (`get-pet` is `get_pet`); the document keeps the id as written.
  const lowered = snake(operationId).replace(/[^a-z0-9_]/g, "_");
  const identifier = /^[0-9]/.test(lowered) ? `op_${lowered}` : lowered;
  if (!/[a-z0-9]/.test(identifier)) throw new Refusal(`the operation id ${JSON.stringify(operationId)} has no ASCII letter or digit to make a Rust name of: rename it in the contract`);
  const id = isKeyword(identifier) ? `${identifier}_` : identifier;
  const route = `${op.verb.toUpperCase()} ${op.path}`;
  // A path parameter is read from the request path by position, so it must be a whole segment of the route (`/{name}/`).
  const segments = op.path.split("/");
  for (const s of segments) {
    if (s.includes("{") && !/^\{\w+\}$/.test(s)) throw new Refusal(`${route}: only whole-segment path parameters are generated, not ${s}`);
  }
  const params = op.parameters.parameters.map((p) => {
    if (p.type === "cookie" && isArray(p.param.type)) throw new Refusal(`${route}: the cookie ${p.name} is an array, which is not generated: a cookie holds one value`);
    const segment = segments.indexOf(`{${p.name}}`);
    const operator = p.type === "path" ? (p as any) : undefined;
    if (operator && (operator.style !== "simple" || operator.allowReserved || operator.explode)) {
      throw new Refusal(`${route}: the path parameter ${p.name} is written with an operator (\`{+name}\`, \`{;name}\`, \`{name*}\`, ...); only a plain \`{name}\` segment is generated`);
    }
    if (p.type === "path" && (segment < 0 || segments.lastIndexOf(`{${p.name}}`) !== segment)) {
      throw new Refusal(`${route}: path parameter ${p.name} must appear once in the route`);
    }
    return {
      name: p.name, field: field(p.name), kind: p.type,
      repeated: isArray(p.param.type),
      explode: p.type === "query" ? !!(p as any).explode : undefined,
      segment: p.type === "path" ? segment : undefined,
    };
  });
  const fields = new Set<string>();
  for (const p of params) {
    if (fields.has(p.field)) throw new Refusal(`${route}: duplicate parameter field ${p.name}`);
    if (p.field === "body" || p.field === "unknown") throw new Refusal(`${route}: parameter ${p.name} collides with a generated field`);
    fields.add(p.field);
  }
  const docParams = op.parameters.parameters.filter((p) => !(p.type === "header" && p.name.toLowerCase() === "content-type")).map((p) => {
    const ty = rust(p.param.type);
    // `T | null` on a parameter is a nullable schema, which an `Option<T>` alone does not say.
    const t = p.param.type;
    const nullable = t.kind === "Union" && [...t.variants.values()].some((v) => v.type.kind === "Intrinsic" && v.type.name === "null");
    return {
      name: p.name, kind: p.type,
      // An `Option` is how utoipa tells a parameter is optional: a required one that may be null is its type, and `nullable`.
      ty: p.param.optional ? (ty.startsWith("Option<") ? ty : `Option<${ty}>`) : ty.replace(/^Option<(.*)>$/, "$1"),
      description: getDoc(program, p.param),
      attrs: [...constraints(program, p.param), ...(nullable ? ["nullable"] : [])],
      consts: facts(program, p.param, ty, constPrefix(field(p.name))),
      explode: p.type === "query" && p.param.type.kind === "Model" && p.param.type.name === "Array" ? !!(p as any).explode : undefined,
    };
  });
  const docResponses: DocResponse[] = [];
  const answers: Op["answers"] = [];
  const refused = new Set<number>();
  let events: Events | undefined;
  for (const r of op.responses) {
    if (typeof r.statusCodes !== "number") throw new Refusal(`${route}: a response needs a numeric status`);
    const status = r.statusCodes;
    const bodies = r.responses.length ? r.responses : [{ body: undefined, headers: undefined } as any];
    for (const c of bodies) {
      const headers = Object.entries((c.headers ?? {}) as Record<string, any>).map(([name, h]) => ({
        name, field: field(name), repeated: isArray(h.type), optional: !!h.optional,
      }));
      const headerFields = new Set<string>();
      for (const h of headers) {
        if (headerFields.has(h.field)) throw new Refusal(`${route} ${status}: two response headers are both the Rust field ${h.field}: rename one in the contract`);
        headerFields.add(h.field);
      }
      if (headers.some((h) => h.field === "body")) throw new Refusal(`${route} ${status}: a response header named body collides with the generated body field`);
      const variantOf = () => VARIANTS[status] ?? `Status${status}`;

      const note = (content?: DocResponse["contents"][number]) => {
        let d = docResponses.find((d) => d.status === status);
        if (!d) docResponses.push((d = { status, description: r.description ?? "", headers: headers.map((h) => h.name), contents: [] }));
        // Two bodies of one media under one status (two errors) are one entry of the document: the first.
        if (content && !d.contents.some((x) => x.media === content.media)) d.contents.push(content);
      };
      if (!c.body) {
        note();
        if (status >= 400) refused.add(status);
        else answers.push({ status, variant: variantOf(), media: "", headers });
        continue;
      }
      const media = mediaOf(c.body.contentTypes[0] ?? "application/json");
      if (!["application/json", "text/event-stream", "text/plain"].includes(media)) throw new Refusal(`${route}: unsupported response media type ${media}`);
      let ty: string;
      if (media === "text/event-stream") {
        const stream = getStreamOf(program, (r as any).type);
        if (!stream || stream.kind !== "Union") throw new Refusal(`${route}: a stream needs an @events union`);
        const u = stream as Union;
        const variantName = uniqueNames();
        events = {
          name: u.name!,
          consts: [...facts(program, u, ""), ...[...u.variants.entries()].flatMap(([k, v]) => facts(program, v, "", constPrefix(field(String(k)))))],
          variants: [...u.variants.entries()].map(([k, v]) => {
            const ty = rust(v.type);
            const plain = getContentType(program, v) === "text/plain";
            if (plain && !displayable(ty)) throw new Refusal(`${route}: the event ${String(k)} is text/plain, so a string, a number, a boolean or a scalar, not ${ty}`);
            const loose = config.allowUntyped ? undefined : untyped(ty);
            if (loose) problems.push(`${route} ${status}: the event ${String(k)} carries an untyped value (${loose})`);
            return { name: String(k), variant: variantName(pascalIdent(String(k)) || "Event"), ty, plain };
          }),
        };
        ty = "super::super::Events";
        note({ media, item: events.name });
      } else {
        ty = rust(c.body.type);
        if (media === "text/plain" && !displayable(ty)) throw new Refusal(`${route} ${status}: a text/plain body is a string, a number, a boolean or a scalar, not ${ty}`);
        // A response says what it carries: a `serde_json::Value` anywhere in it is a shape the contract left out.
        const loose = config.allowUntyped ? undefined : untyped(ty);
        if (loose) problems.push(`${route} ${status}: the response carries an untyped value (${loose})`);
        note({ media, ty });
      }
      if (status >= 400) { refused.add(status); continue; }
      if (answers.some((a) => a.status === status)) throw new Refusal(`${route}: multiple non-refusal response media for status ${status}`);
      answers.push({ status, variant: variantOf(), ty, media, headers });
    }
  }
  if (!answers.length) throw new Refusal(`${route}: operation ${id} has no answer`);
  const b = op.parameters.body;
  if (b) {
    const media = (b as any).contentTypes as string[] | undefined;
    const json = (type: string) => mediaOf(type) === "application/json" || mediaOf(type).endsWith("+json");
    if ((b as any).bodyKind === "multipart" || (media ?? []).some((type) => !json(type))) {
      throw new Refusal(`${route}: a request body is JSON; this one is ${(b as any).bodyKind === "multipart" ? "multipart" : (media ?? []).join(", ")}`);
    }
  }
  const summary = getSummary(program, op.operation);
  const description = getDoc(program, op.operation);
  return {
    id, operationId, trait: pascal(id), path: op.path, method: op.verb,
    extensions: [...getExtensions(program, op.operation)].map(([name, json]) => ({ name, json })),
    params, body: b ? rust(b.type) : undefined, bodyOptional: !!b?.property?.optional,
    bodyMedia: b && (b as any).contentTypes?.[0] ? mediaOf((b as any).contentTypes[0]) : undefined,
    // A body that does not decode is refused with the status the operation lists for it.
    inputRefusal: [400, 422].find((status) => refused.has(status)),
    answers, events,
    summary, description,
    docParams, docResponses,
    tags: tagsOf(program, op.operation),
    deprecated: isDeprecated(program, op.operation),
    consts: facts(program, op.operation, ""),
  };
}

/**
 * The exact `itemSchema` of a stream, as the TypeSpec emitter writes it, and a placeholder component for utoipa to reference
 * (`finish` swaps one for the other).
 */
function eventSchema(e: Events, { inlined }: Config) {
  const variants = e.variants.map((v) => {
    const data = v.plain
      ? '{"contentMediaType": "text/plain", "contentSchema": {"type": "string"}}'
      : `{"contentMediaType": "application/json", "contentSchema": ${schemaExpr(v.ty, inlined)}}`;
    return `{"properties": {"data": ${data}, "event": {"const": ${q(v.name)}}}}`;
  });
  const item = `json!({
        "type": "object",
        "properties": {"event": {"type": "string"}, "data": {"type": "string"}},
        "required": ["event"],
        "oneOf": [${variants.join(", ")}]
    })`;
  const fn = `${snake(e.name)}_item`;
  const placeholder = manualSchema(e.name, 'json!({"type": "object"})', e.variants.flatMap((v) => schemaDeps(v.ty, inlined)), e.name + "Item");
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
  const add = (t: Type) => { const n = rust(t); if (/^[A-Z]\w*$/.test(n)) out.add(n); };
  for (const m of ns.models.values()) if (plain(m) && ![...m.properties.values()].some((p) => isMetadata(program, p))) add(m);
  for (const e of ns.enums.values()) add(e);
  for (const u of ns.unions.values()) if (plain(u)) add(u);
  for (const s of ns.scalars.values()) if (plain(s)) add(s);
  for (const c of ns.namespaces.values()) declared(program, c, rust, out);
}

export function emitAxum(program: Program, config: Config, types: Types, services: HttpService[]): string {
  // The file refers to the contract's types by path, so none of them can be shadowed by (or shadow) a name the file defines.
  const qualify = (ty: string) => ty.replace(/(?<![\w:])[A-Z]\w*/g, (name) => (types.known(name) ? `${config.typesPath}::${name}` : name));
  const bare = types.rust;
  const rust = (t: Type) => qualify(bare(t));
  types = { ...types, rust };
  const out = [generatedNotice(config.generator), axumHeader(config)];
  const problems: string[] = [];
  const seen = new Map<string, { module: string; key: string; id: string }>();
  const modules = new Set<string>();
  for (const svc of services) {
    if (!getService(program, svc.namespace)) throw new Refusal("the contract has no @service: put its operations in a namespace marked @service");
    // The Rust module is the whole name of the namespace (`Pets.V1` is `pets_v1`), so two services can end in the same word.
    const leaf = (svc.namespace.name || "api").toLowerCase();
    const whole = (getNamespaceFullName(svc.namespace) || "api").toLowerCase().replace(/\./g, "_");
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
    const ids = new Set<string>();
    const traits = new Set<string>();
    const mentionedNames = new Set<string>();
    // A type a parameter, body, answer or event names is a schema of the document even when the namespace does not declare it. The
    // operations a service shares from another are in its document too.
    const mention = (o: Op) => {
      const mentioned = [o.body, ...o.answers.map((a) => a.ty), ...o.docParams.map((p) => p.ty), ...o.docResponses.flatMap((r) => r.contents.map((c) => c.ty)), ...(o.events?.variants.map((v) => v.ty) ?? [])];
      for (const ty of mentioned) {
        for (const [, name] of (ty ?? "").matchAll(/(?:\w+::)*([A-Z]\w*)/g)) {
          if (types.known(name)) mentionedNames.add(name);
          if (types.known(name) && !config.inlined.has(name)) schemas.add(name);
        }
      }
    };
    for (const o of ops) {
      if (ids.has(o.id)) throw new Refusal(`${module}: two operations are both ${o.id}: rename one in the contract`);
      ids.add(o.id);
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
    const unions = new Map<string, Events>();
    for (const o of ops) if (o.events) unions.set(o.events.name, o.events);
    for (const name of unions.keys()) {
      if (traits.has(name) || TRAITS.has(name)) throw new Refusal(`${module}: the stream ${name} takes the name of an operation's trait or of a type the generated code uses: rename one in the contract`);
    }
    const schemaOf = new Map([...unions.values()].map((e) => [e.name, eventSchema(e, config)]));

    // The document's info is what `@service`, `@summary` and `@info` say; `@info` entries this generator has no attribute for fail here.
    const about = resolveInfo(program, svc.namespace) ?? {};
    const unsupported = Object.entries(about).filter(([key, value]) => value !== undefined && !["title", "description", "version"].includes(key));
    if (unsupported.length) throw new Refusal(`${module}: @info ${unsupported.map(([key]) => key).join(", ")} is not generated`);
    const description = about.description ?? getDoc(program, svc.namespace);
    const info = [`title = ${q(about.title ?? leaf)}`, `version = ${q(about.version ?? "0.0.0")}`];
    if (description) info.push(`description = ${q(description)}`);

    out.push(contractModule({
      module,
      ops,
      info,
      paths: [...ops.map((o) => `${o.id}::run`), ...shared],
      // Every type the namespace declares is a schema, reachable or not (`omit-unreachable-types: false`), and so is each event item.
      components: [...[...schemas].map((s) => `${config.typesPath}::${s}`), ...unions.keys()],
      items: [...schemaOf].map(([name, s]) => `(${q(name + "Item")}, ${s.fn}())`),
      operations: [...ops, ...sharedOps].map((o) => `(${q(o.operationId)}, &[${o.tags.map(q).join(", ")}], ${o.deprecated}, ${o.body ? `Some(${!o.bodyOptional})` : "None"})`),
      body: [
        ...ops.map((o) => operationModule(o, config)),
        ...[...unions.values()].flatMap((e) => [eventsEnum(e), schemaOf.get(e.name)!.code]),
      ],
    }));
  }
  if (problems.length) throw new Refusal(`untyped responses are not generated; name their shape in the contract:\n  ${problems.join("\n  ")}`);
  return out.join("\n");
}
