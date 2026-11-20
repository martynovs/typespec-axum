/** Reads the HTTP operations of a TypeSpec program into `Op`s and assembles the endpoints file from `templates.ts`. */
import { getDoc, getSummary, type Namespace, type Program, type Union, type Type } from "@typespec/compiler";
import { isMetadata, type HttpOperation, type HttpService } from "@typespec/http";
import { getExtensions, resolveInfo } from "@typespec/openapi";
import { getStreamOf } from "@typespec/streams";
import { getContentType } from "@typespec/events";
import { constPrefix, constraints, facts, q, rustField as field, schemaDeps, schemaExpr, type Config, type DocResponse, type Events, type Op } from "./common.js";
import { axumHeader, contractModule, eventItem, eventsEnum, generatedNotice, manualSchema, operationModule } from "./templates.js";

/** The `Answer` variant of each success or redirect status. A status of 400 or more is a refusal, which no variant holds. */
const VARIANTS: Record<number, string> = {
  200: "Ok", 201: "Created", 202: "Accepted", 203: "NonAuthoritative", 204: "NoContent", 205: "ResetContent", 206: "PartialContent",
  300: "MultipleChoices", 301: "MovedPermanently", 302: "Found", 303: "SeeOther", 304: "NotModified", 307: "TemporaryRedirect", 308: "PermanentRedirect",
};

export const pascal = (id: string) => id.split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : "")).join("");
const snake = (id: string) => id.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** What `emitAxum` takes from the type emitter: the Rust type of a TypeSpec type, and where a Rust type holds an untyped value. */
export interface Types {
  rust: (t: Type) => string;
  untyped: (ty: string) => string | undefined;
}

function readOp(program: Program, config: Config, { rust, untyped }: Types, problems: string[], op: HttpOperation): Op {
  const id = snake(op.operation.name);
  const route = `${op.verb.toUpperCase()} ${op.path}`;
  // A path parameter is read from the request path by position, so it must be a whole segment of the route (`/{name}/`).
  const segments = op.path.split("/");
  for (const s of segments) {
    if (s.includes("{") && !/^\{\w+\}$/.test(s)) throw new Error(`${route}: only whole-segment path parameters are generated, not ${s}`);
  }
  const params = op.parameters.parameters.map((p) => {
    const segment = segments.indexOf(`{${p.name}}`);
    if (p.type === "path" && (segment < 0 || segments.lastIndexOf(`{${p.name}}`) !== segment)) {
      throw new Error(`${route}: path parameter ${p.name} must appear once in the route`);
    }
    return {
      name: p.name, field: field(p.name), kind: p.type,
      repeated: p.param.type.kind === "Model" && p.param.type.name === "Array",
      segment: p.type === "path" ? segment : undefined,
    };
  });
  const fields = new Set<string>();
  for (const p of params) {
    if (fields.has(p.field)) throw new Error(`${route}: duplicate parameter field ${p.name}`);
    if (p.field === "body" || p.field === "unknown") throw new Error(`${route}: parameter ${p.name} collides with a generated field`);
    fields.add(p.field);
  }
  const docParams = op.parameters.parameters.map((p) => {
    const ty = rust(p.param.type);
    // `T | null` on a parameter is a nullable schema, which an `Option<T>` alone does not say.
    const t = p.param.type;
    const nullable = t.kind === "Union" && [...t.variants.values()].some((v) => v.type.kind === "Intrinsic" && v.type.name === "null");
    return {
      name: p.name, kind: p.type, ty: p.param.optional && !ty.startsWith("Option<") ? `Option<${ty}>` : ty,
      description: getDoc(program, p.param), attrs: [...constraints(program, p.param), ...(nullable ? ["nullable"] : [])],
      consts: facts(program, p.param, ty, constPrefix(field(p.name))),
    };
  });
  const docResponses: DocResponse[] = [];
  const answers: Op["answers"] = [];
  const refused = new Set<number>();
  let events: Events | undefined;
  for (const r of op.responses) {
    if (typeof r.statusCodes !== "number") throw new Error(`${route}: a response needs a numeric status`);
    const status = r.statusCodes;
    const bodies = r.responses.length ? r.responses : [{ body: undefined, headers: undefined } as any];
    for (const c of bodies) {
      const headers = Object.entries((c.headers ?? {}) as Record<string, any>).map(([name, h]) => ({
        name, field: field(name), repeated: h.type.kind === "Model" && h.type.name === "Array",
      }));
      const variantOf = () => { const v = VARIANTS[status]; if (!v) throw new Error(`${route}: unsupported answer status ${status}`); return v; };

      const note = (content?: DocResponse["contents"][number]) => {
        let d = docResponses.find((d) => d.status === status);
        if (!d) docResponses.push((d = { status, description: r.description ?? "", headers: headers.map((h) => h.name), contents: [] }));
        if (content) d.contents.push(content);
      };
      if (!c.body) {
        note();
        if (status >= 400) refused.add(status);
        else answers.push({ status, variant: variantOf(), media: "", headers });
        continue;
      }
      const media = c.body.contentTypes[0] ?? "application/json";
      if (!["application/json", "text/event-stream", "text/plain"].includes(media)) throw new Error(`${route}: unsupported response media type ${media}`);
      let ty: string;
      if (media === "text/event-stream") {
        const stream = getStreamOf(program, (r as any).type);
        if (!stream || stream.kind !== "Union") throw new Error(`${route}: a stream needs an @events union`);
        const u = stream as Union;
        events = {
          name: u.name!,
          consts: [...facts(program, u, ""), ...[...u.variants.entries()].flatMap(([k, v]) => facts(program, v, "", constPrefix(field(String(k)))))],
          variants: [...u.variants.entries()].map(([k, v]) => ({
            name: String(k), ty: rust(v.type),
            plain: getContentType(program, v) === "text/plain",
          })),
        };
        ty = "Events";
        note({ media, item: events.name });
      } else {
        ty = rust(c.body.type);
        // A response says what it carries: a `serde_json::Value` anywhere in it is a shape the contract left out.
        const loose = config.allowUntyped ? undefined : untyped(ty);
        if (loose) problems.push(`${route} ${status}: the response carries an untyped value (${loose})`);
        note({ media, ty });
      }
      if (status >= 400) { refused.add(status); continue; }
      if (answers.some((a) => a.status === status)) throw new Error(`${route}: multiple non-refusal response media for status ${status}`);
      answers.push({ status, variant: variantOf(), ty, media, headers });
    }
  }
  if (!answers.length) throw new Error(`${route}: operation ${id} has no answer`);
  const b = op.parameters.body;
  const summary = getSummary(program, op.operation);
  const description = getDoc(program, op.operation);
  return {
    id, trait: pascal(id), path: op.path, method: op.verb,
    extensions: [...getExtensions(program, op.operation)].map(([name, json]) => ({ name, json })),
    params, body: b ? rust(b.type) : undefined,
    // A body that does not decode is refused with the status the operation lists for it.
    inputRefusal: [400, 422].find((status) => refused.has(status)),
    answers, events,
    summary, description,
    docParams, docResponses,
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

/**
 * The Rust names of the schemas a namespace declares. Templates are written out where they are used, and a model that holds a
 * status code or a header is the shape of a response, not of a body: neither is a schema.
 */
function declared(program: Program, ns: Namespace, rust: (t: Type) => string, out: Set<string>) {
  const plain = (t: any) => t.name && !t.templateMapper && !t.node?.templateParameters?.length;
  const add = (t: Type) => { const n = rust(t); if (/^[A-Z]\w*$/.test(n)) out.add(n); };
  for (const m of ns.models.values()) if (plain(m) && ![...m.properties.values()].some((p) => isMetadata(program, p))) add(m);
  for (const e of ns.enums.values()) add(e);
  for (const u of ns.unions.values()) if (plain(u)) add(u);
  for (const s of ns.scalars.values()) if (plain(s)) add(s);
  for (const c of ns.namespaces.values()) declared(program, c, rust, out);
}

export function emitAxum(program: Program, config: Config, types: Types, services: HttpService[]): string {
  const { rust } = types;
  const out = [generatedNotice(config.generator), axumHeader(config)];
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const svc of services) {
    const module = (svc.namespace.name || "api").toLowerCase();
    const all = svc.operations.map((op) => readOp(program, config, types, problems, op));
    // An operation both contracts hold is written once, in the first; the others document it from there.
    const ops = all
      .filter((o) => !seen.has(`${o.method} ${o.path}`))
      .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    const shared = all.filter((o) => seen.has(`${o.method} ${o.path}`)).map((o) => `super::${seen.get(`${o.method} ${o.path}`)}::${o.id}::run`);
    ops.forEach((o) => seen.set(`${o.method} ${o.path}`, module));

    const schemas = new Set<string>();
    declared(program, svc.namespace, rust, schemas);
    const unions = new Map<string, Events>();
    for (const o of ops) if (o.events) unions.set(o.events.name, o.events);
    const schemaOf = new Map([...unions.values()].map((e) => [e.name, eventSchema(e, config)]));

    // The document's info is what `@service`, `@summary` and `@info` say; `@info` entries this generator has no attribute for fail here.
    const about = resolveInfo(program, svc.namespace) ?? {};
    const unsupported = Object.entries(about).filter(([key, value]) => value !== undefined && !["title", "description", "version"].includes(key));
    if (unsupported.length) throw new Error(`${module}: @info ${unsupported.map(([key]) => key).join(", ")} is not generated`);
    const description = about.description ?? getDoc(program, svc.namespace);
    const info = [`title = ${q(about.title ?? module)}`, `version = ${q(about.version ?? "0.0.0")}`];
    if (description) info.push(`description = ${q(description)}`);

    out.push(contractModule({
      module,
      ops,
      info,
      paths: [...ops.map((o) => `${o.id}::run`), ...shared],
      // Every type the namespace declares is a schema, reachable or not (`omit-unreachable-types: false`), and so is each event item.
      components: [...[...schemas].map((s) => `${config.typesPath}::${s}`), ...unions.keys()],
      items: [...schemaOf].map(([name, s]) => `(${q(name + "Item")}, ${s.fn}())`),
      body: [
        ...ops.map((o) => operationModule(o, config)),
        ...[...unions.values()].flatMap((e) => [eventsEnum(e, pascal), schemaOf.get(e.name)!.code]),
      ],
    }));
  }
  if (problems.length) throw new Error(`untyped responses are not generated; name their shape in the contract:\n  ${problems.join("\n  ")}`);
  return out.join("\n");
}
