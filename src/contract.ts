/** The contract as the writers see it: an operation, what it takes and what it answers, before any Rust is written. */
import { getDoc, getSummary, getTags, isDeprecated, type Namespace, type Program, type Union, type Type } from "@typespec/compiler";
import { type HttpOperation } from "@typespec/http";
import { getExtensions, getOperationId } from "@typespec/openapi";
import { getStreamOf } from "@typespec/streams";
import { getContentType } from "@typespec/events";

import { type Config, Refusal } from "./config.js";
import { constraints, facts } from "./constraints.js";
import { constPrefix, isKeyword, pascalIdent, rustField as field, uniqueNames } from "./rust.js";

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
  /** The status a body that does not decode is refused with (400, 422 or 401), when the contract lists one as JSON; a plain-text refusal is axum's own. */
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

/** The `Answer` variant of each success or redirect status. A status of 400 or more is a refusal, which no variant holds. */
const VARIANTS: Record<number, string> = {
  200: "Ok", 201: "Created", 202: "Accepted", 203: "NonAuthoritative", 204: "NoContent", 205: "ResetContent", 206: "PartialContent", 207: "MultiStatus",
  300: "MultipleChoices", 301: "MovedPermanently", 302: "Found", 303: "SeeOther", 304: "NotModified", 307: "TemporaryRedirect", 308: "PermanentRedirect",
};

export const pascal = (id: string) => id.split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : "")).join("");
export const snake = (id: string) => id.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** What `generate` takes from the type writer: the Rust type of a TypeSpec type, and where a Rust type holds an untyped value. */
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
  /** The mapped types that are components which the given defined types hold in their fields. */
  mappedHeld: (names: Iterable<string>) => string[];
  /** Whether a type is a generic struct, which derives no schema and so is no component. */
  generic: (name: string) => boolean;
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

export function readOp(program: Program, config: Config, { rust, untyped, displayable }: Types, problems: string[], service: Namespace, op: HttpOperation): Op {
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
        // A refusal with no body declares a status, not a JSON answer: it is not one `reject-with` may produce.
        if (status < 400) answers.push({ status, variant: variantOf(), media: "", headers });
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
      // A plain-text refusal is axum's own answer to a body it cannot read (400, 413): it is not the status a body that does not decode is refused with.
      if (status >= 400) { if (media === "application/json") refused.add(status); continue; }
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
    // A body that does not decode is refused with the status the operation lists for it as a JSON answer: a refusal with no body or a plain-text one is not.
    inputRefusal: [400, 422, 401].find((status) => refused.has(status)),
    answers, events,
    summary, description,
    docParams, docResponses,
    tags: tagsOf(program, op.operation),
    deprecated: isDeprecated(program, op.operation),
    consts: facts(program, op.operation, ""),
  };
}
