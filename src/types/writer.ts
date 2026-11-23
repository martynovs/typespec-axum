/** Reads TypeSpec types and writes the Rust type each one is: the wire types of `types.rs`. */
import { getDoc, getEncode, getNamespaceFullName, getSummary, getExamples, isDeprecated, serializeValueAsJson, type Type, type Model, type ModelProperty, type Program } from "@typespec/compiler";
import { type Config, Refusal } from "../config.js";
import { constraintValues, constraints, facts } from "../constraints.js";
import { constPrefix, isKeyword, jsonText, lastSegment, q, rustField, rustJson, rustStr } from "../rust.js";
import { type EnumMember, type StructField, constantsImpl, containerNewtype, eqMarker, peqMarker, literalSchemaFn, manualSchema, partialSchemaFn, numericEnum, scalarNewtype, stringEnum, structDef, untaggedUnion } from "./templates.js";
import { asReferences, contractSchemaName, forSchema, inlineKey, lacksToSchema, namesPath, onlyPartial, schemaDeps, schemaExpr, schemaTypeKey, schemaTypes, withoutPaths } from "../schema.js";
import { pascalIdent, uniqueNames } from "../rust.js";







const SCALARS: Record<string, string> = {
  string: "String", boolean: "bool", int8: "i8", int16: "i16", int32: "i32", int64: "i64", safeint: "i64",
  uint8: "u8", uint16: "u16", uint32: "u32", uint64: "u64", float32: "f32", float64: "f64", float: "f64",
  integer: "i64", numeric: "f64", url: "String", bytes: "String",
  utcDateTime: "String", offsetDateTime: "String", plainDate: "String", plainTime: "String", duration: "String",
};

function ident(s: string): string {
  const r = s.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(r) ? "_" + r : r;
}

/** Names `types.rs` uses for the standard library and serde, which a type of the contract may not take: it would shadow them. */
const RESERVED = new Set([
  "Option", "Some", "None", "Result", "Ok", "Err", "Vec", "String", "Box", "Self", "Default", "Send", "Sync", "Clone", "Debug", "Copy",
  "Eq", "PartialEq", "Serialize", "Deserialize", "Value", "Object", "Decimal", "UploadFile",
]);

type Flat = [string | symbol, Type & { kind: "UnionVariant" }][];

/** A union's flat variants, once: a union that more than one union refers to is not read again for each. A ring is never cached. */
const flattened = new WeakMap<Type, Flat>();

/** The variants of a flat list with the named literal unions among them spread too (`Kinds | "x"` is `"a" | "b" | "x"`), once each. */
function deepVariants(flat: Flat): Flat {
  const seen = new Set<Type>();
  const walked = new Set<Type>(); // a union that more than one lists is walked once, or a chain of them would take time doubling with its length
  const out: Flat = [];
  const visit = (list: Flat) => {
    for (const [k, v] of list) {
      if (v.type.kind === "Union") {
        if (walked.has(v.type)) continue;
        walked.add(v.type);
        visit(flattenUnion(v.type));
      } else if (!seen.has(v.type)) {
        seen.add(v.type);
        out.push([k, v]);
      }
    }
  };
  visit(flat);
  return out;
}

/** Whether a flat list of variants is string literals (and `null`) only, named literal unions among them included: a string enum. */
const onlyLiterals = (flat: Flat) => {
  const leaves = deepVariants(flat);
  return leaves.some(([, v]) => v.type.kind === "String") && leaves.every(([, v]) => v.type.kind === "String" || isNull(v.type));
};

/** A named union of string literals (and `null`), however deep they are written: a string enum of its own, which holds the values it may have. */
const isLiteralUnion = (u: Type & { kind: "Union" }) => !!u.name && onlyLiterals(flattenUnion(u));

/**
 * The variants of a union, those of a union that is one of them included: `("s" | "m") | null` is `"s" | "m" | null`, and so is
 * `union Both { Status, int32 }` the variants of `Status` and `int32`. A Rust enum never has a union inside it, so no value is tried
 * by one union only to be tried by another, and two unions cannot read each other for ever. A union that includes itself, however far
 * down, has no end and is refused. A variant that comes twice (the same type from two unions) is one.
 */
function flattenUnion(t: Type & { kind: "Union" }, path: Type[] = [t]): Flat {
  const known = flattened.get(t);
  if (known) return known;
  const out: Flat = [];
  const seen = new Set<Type>();
  // The variants a union writes itself are all kept (`pending: string` and `lagged: string` are two events); one copied in from a union
  // inside it is dropped when this union already has it.
  const add = (k: string | symbol, v: Type & { kind: "UnionVariant" }, copied: boolean) => {
    if (copied && seen.has(v.type)) return;
    seen.add(v.type);
    out.push([k, v]);
  };
  for (const [k, v] of t.variants.entries()) {
    const inner = v.type;
    if (inner.kind !== "Union") {
      add(k, v, false);
      continue;
    }
    if (path.includes(inner)) {
      throw new Refusal(
        inner === t && path.length === 1
          ? `${t.name ?? "a union"} cannot list itself as a variant`
          : `${t.name ?? "a union"} and ${inner.name ?? "another"} are unions that include each other`,
      );
    }
    const sub = flattenUnion(inner, [...path, inner]);
    // A named union of literals stays one variant (its own enum); any other is spread into this one.
    if (inner.name && onlyLiterals(sub)) add(k, v, false);
    else for (const [subKey, subVariant] of sub) add(subKey, subVariant, true);
  }
  flattened.set(t, out);
  return out;
}

/** Whether `target` is part of `t`: a variant, an element, a property, however deep. */
function refersTo(t: Type, target: Type, seen = new Set<Type>()): boolean {
  if (t === target) return true;
  if (seen.has(t)) return false;
  seen.add(t);
  if (t.kind === "Union") return [...t.variants.values()].some((v) => refersTo(v.type, target, seen));
  if (t.kind === "Model") {
    return (!!t.indexer && refersTo(t.indexer.value, target, seen)) || (!!t.baseModel && refersTo(t.baseModel, target, seen))
      || [...t.properties.values()].some((p) => refersTo(p.type, target, seen));
  }
  return false;
}

/** Whether a value of this type can be a JSON array: a list, or a union with a variant that can. A struct reads an array too. */
function acceptsArray(t: Type, seen = new Set<Type>()): boolean {
  if (seen.has(t)) return false;
  seen.add(t);
  if (t.kind === "Union") return flattenUnion(t).some(([, v]) => acceptsArray(v.type, seen));
  return t.kind === "Model" && !!t.indexer && t.indexer.key.name === "integer";
}

/** An id for a type, to tell pairs apart while two recursive types are compared. */
const typeIds = new WeakMap<Type, number>();
let typeCount = 0;
const idOf = (t: Type) => {
  if (!typeIds.has(t)) typeIds.set(t, ++typeCount);
  return typeIds.get(t)!;
};

/**
 * Whether two types are one shape: what a Rust type would be made of, docs set aside. Two models of one name that have the same
 * properties are one type; a recursive pair is taken as equal where it comes round to the pair being compared.
 */
function sameShape(a: Type, b: Type, program: Program, assumed = new Set<string>()): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  const pair = `${idOf(a)}:${idOf(b)}`;
  if (assumed.has(pair)) return true;
  assumed.add(pair);
  const same = (x: Type | undefined, y: Type | undefined) => (x === undefined || y === undefined ? x === y : sameShape(x, y, program, assumed));
  switch (a.kind) {
    case "Model": {
      const m = b as Model;
      if (a.name !== m.name || a.properties.size !== m.properties.size) return false;
      if (!same(a.baseModel, m.baseModel)) return false;
      if (!!a.indexer !== !!m.indexer || (a.indexer && m.indexer && (a.indexer.key.name !== m.indexer.key.name || !same(a.indexer.value, m.indexer.value)))) return false;
      const argsA = ((a as any).templateMapper?.args ?? []) as any[];
      const argsB = ((m as any).templateMapper?.args ?? []) as any[];
      if (argsA.length !== argsB.length || argsA.some((x, i) => (x.entityKind === "Type" && argsB[i].entityKind === "Type" ? !same(x, argsB[i]) : x !== argsB[i]))) return false;
      return [...a.properties.entries()].every(([name, p]) => {
        const other = m.properties.get(name);
        return !!other && p.optional === other.optional && same(p.type, other.type) && JSON.stringify(constraintValues(program, p)) === JSON.stringify(constraintValues(program, other));
      });
    }
    case "Enum": {
      const e = b as Type & { kind: "Enum" };
      return a.name === e.name && a.members.size === e.members.size && [...a.members.values()].every((m, i) => { const o = [...e.members.values()][i]; return m.name === o.name && m.value === o.value; });
    }
    case "Union": {
      const u = b as Type & { kind: "Union" };
      const va = [...a.variants.entries()], vb = [...u.variants.entries()];
      return a.name === u.name && va.length === vb.length && va.every(([k, v], i) => k === vb[i][0] && same(v.type, vb[i][1].type));
    }
    case "Scalar": {
      const c = b as Type & { kind: "Scalar" };
      return a.name === c.name && same(a.baseScalar, c.baseScalar) && JSON.stringify(constraintValues(program, a)) === JSON.stringify(constraintValues(program, c));
    }
    case "String": case "Number": case "Boolean": return (a as any).value === (b as any).value;
    case "Intrinsic": return a.name === (b as Type & { kind: "Intrinsic" }).name;
    case "EnumMember": return a.name === (b as Type & { kind: "EnumMember" }).name && same(a.enum, (b as Type & { kind: "EnumMember" }).enum);
    default: return false;
  }
}

/** Whether `null` is one of the values of a union, through unions that are variants of it. */
function unionIsNullable(t: Type & { kind: "Union" }, seen = new Set<Type>()): boolean {
  if (seen.has(t)) return false;
  seen.add(t);
  return flattenUnion(t).some(([, v]) => isNull(v.type) || (v.type.kind === "Union" && unionIsNullable(v.type, seen)));
}

/** The properties of a model after those of the models it extends, base first. */
/** The element of an `Array` or `Record`: what its indexer says, or in a template's declaration the template's argument. */
function elementOf(t: Model): Type | undefined {
  if (t.indexer) return t.indexer.value;
  // Only the standard `Array` and `Record`: a model of the contract may be named so.
  const arg = (t.name === "Array" || t.name === "Record") && t.namespace?.name === "TypeSpec" && t.templateMapper ? t.templateMapper.args[0] : undefined;
  return arg && arg.entityKind === "Type" ? (arg as Type) : undefined;
}

/** The arguments of a generic type, split at the commas that are not inside another `<..>`. */
function topLevelCommas(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "<") depth++;
    else if (args[i] === ">") depth--;
    else if (args[i] === "," && depth === 0) {
      out.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(args.slice(start).trim());
  return out;
}

function ownAndInherited(t: Model): ModelProperty[] {
  // A property a model declares again (`@override`) replaces the base's, in the base's place.
  const all = new Map<string, ModelProperty>();
  for (const p of [...(t.baseModel ? ownAndInherited(t.baseModel) : []), ...t.properties.values()]) all.set(p.name, p);
  return [...all.values()];
}

const isNull = (t: Type) => t.kind === "Intrinsic" && t.name === "null";
const isNever = (t: Type) => t.kind === "Intrinsic" && t.name === "never";

/** Writes the Rust type each TypeSpec type is, defining it (once) in `defs` when it has a name. */
export class TypeWriter {
  defs = new Map<string, string>();
  private readonly numbered = new Map<Type, string>();
  /** The Rust names of scalars of the contract, which have `Display`. */
  readonly scalars = new Set<string>();
  /** The Rust types each defined type is made of, to find the untyped value a response may hold. */
  private readonly parts = new Map<string, string[]>();
  /** Types a field refers to without utoipa following it (`no_recursion`): the document must be told of them itself. */
  readonly hidden = new Set<string>();
  /** The template parameters of the generic struct being written, which a field's type may be. */
  private templateParams = new Set<string>();
  /** Whether a generic struct is being written: it derives no schema, so its fields take no `#[schema(..)]` and no function for one. */
  private get writingGeneric(): boolean {
    return this.templateParams.size > 0;
  }
  /** Every template parameter name a generic struct has used: no type may take one. */
  private readonly genericNames = new Set<string>();
  /** Union types with a `null` variant: `null` is one of their values, and an `Option` of them would swallow it. */
  private readonly nullables = new Set<string>();

  /** The mapped types (`type-map`) that are components, which the given defined types hold in their fields. */
  mappedHeld(names: Iterable<string>): string[] {
    const out = new Set<string>();
    for (const name of names) {
      for (const part of this.parts.get(name) ?? []) {
        for (const entry of this.config.typeMap.values()) if (!entry.inline && namesPath(part, entry.path)) out.add(entry.path);
      }
    }
    return [...out];
  }

  /** Every defined type `roots` are made of, however deep, and the roots themselves. */
  closure(roots: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const visit = (name: string) => {
      if (out.has(name)) return;
      out.add(name);
      for (const part of this.parts.get(name) ?? []) for (const inner of withoutPaths(part, [...this.config.typeMap.values()].map((e) => e.path)).match(/\b[A-Z]\w*\b/g) ?? []) visit(inner);
      for (const held of this.hiddenHeld.get(name) ?? []) visit(held);
    };
    for (const root of roots) visit(root);
    return out;
  }
  constructor(readonly program: Program, readonly config: Config) {}

  /** The TypeSpec doc comment as Rust `///` lines, which utoipa turns into descriptions. */
  doc(t: Type, indent = ""): string {
    const d = getDoc(this.program, t);
    if (!d) return "";
    // A fenced block in a doc comment is a doctest, and the contract's prose is not Rust: an opening fence with no language says `text`.
    let open = false;
    const lines = d.split("\n").map((l) => {
      const fence = l.match(/^(\s*)(```+|~~~+)/);
      if (!fence) return l;
      open = !open;
      return open ? `${fence[1]}\`\`\`text` : `${fence[1]}\`\`\``;
    });
    return lines.map((l) => `${indent}/// ${l}`.trimEnd()).join("\n") + "\n";
  }

  /** `example = json!(..)` for the first `@example` (a derive takes one; TypeSpec allows several). */
  exampleList(target: any): string[] {
    const examples = getExamples(this.program, target);
    return examples.length ? [`example = json!(${rustJson(serializeValueAsJson(this.program, examples[0].value, target))})`] : [];
  }

  /** The names of the `type-map` the contract used: one it never used is a typo. */
  readonly mappedKeys = new Set<string>();

  /**
   * The Rust path of a type the application writes itself (`type-map`), or undefined for a type the emitter writes. The path is
   * what every reference names; no type is defined for it.
   */
  private mapped(t: Type & { name?: string; namespace?: any }): string | undefined {
    if (this.config.typeMap.size === 0 || !t.name || t.namespace?.name === "TypeSpec") return undefined;
    if (t.kind === "Model" && (this.isInstance(t) || t.name === "Array" || t.name === "Record")) return undefined;
    // A key is the name with its namespace in front (`Shop::Wire::Limits`; a dot cannot be in an option's name) or the name alone.
    const full = t.namespace ? `${getNamespaceFullName(t.namespace).replace(/\./g, "::")}::${t.name}` : t.name;
    const key = this.config.typeMap.has(full) ? full : t.name;
    const entry = this.config.typeMap.get(key);
    if (!entry) return undefined;
    if (key !== full && (this.typeNameCounts().get(ident(t.name)) ?? 0) > 1) {
      throw new Refusal(`type-map: ${t.name} is the name of types in several namespaces: name the one you mean with its namespace in front (${full})`);
    }
    if (t.kind === "Union") throw new Refusal(`type-map: ${full} is a union, which is flattened into the types that use it: map a model, an enum or a scalar`);
    this.mappedKeys.add(key);
    // One that names no schema of the document (`u128`, a `std` type) is written in place in a hand-written schema.
    if (entry.inline) this.config.inlined.add(inlineKey(entry.path));
    // One whose schema is the contract's is told by a type of the generated code that implements what utoipa asks.
    if (entry.scalar && this.documenting) this.contractScalar(t, entry.path);
    if (entry.contract && this.documenting) {
      this.config.inlined.add(schemaTypeKey(entry.path, contractSchemaName(entry.path), lastSegment(entry.path)));
      this.contractSchema(t, entry);
    }
    // A mapped scalar is written as text where one is needed (a `text/plain` body): it is taken to be `Display`.
    if (t.kind === "Scalar") this.scalars.add(entry.path.slice(entry.path.lastIndexOf(":") + 1));
    return entry.path;
  }

  /** The scalars mapped to a primitive with `schema: contract`: the type of the generated code that says the schema of each, and its component. */
  private readonly contractScalars = new Map<Type, { struct: string; name: string }>();

  /** The types that say the schema of the scalars mapped to a primitive with `schema: contract`: each is a component of the document. */
  contractScalarStructs(): string[] {
    return [...this.contractScalars.values()].map((s) => s.struct);
  }

  /** `[component, type]` of each of them, the type written by its path from the types module. */
  contractScalarNames(): [string, string][] {
    return [...this.contractScalars.values()].map((s) => [s.name, `${this.config.typesPath}::${s.struct}`]);
  }

  /** A scalar of the contract the application writes as a primitive (`Instant` as a `String`) keeps its own component in the document, and fields of it refer to it. */
  private contractScalar(t: Type, path: string): void {
    if (t.kind !== "Scalar") throw new Refusal(`type-map: ${path} is mapped with schema: contract, which for a primitive takes a scalar of the contract`);
    if (this.contractScalars.has(t)) return;
    const name = ident(t.name);
    const struct = `${name}Schema`;
    this.contractScalars.set(t, { struct, name });
    const written = this.define(struct, `contract-scalar:${this.identity(t)}`, undefined, (struct) => {
      const { schema, deps } = this.schemaOf(t, path);
      const exact = this.schemaOf(t, path, true).schema;
      return `/// The schema of the scalar \`${name}\` in the document: the application writes it as \`${path}\`.\npub struct ${struct};\nimpl ${struct} {\n    /// The schema as it is written, for the finished document.\n    pub fn exact() -> serde_json::Value {\n        ${exact}\n    }\n}\n${manualSchema(struct, schema, deps, name)}`;
    });
    if (written !== struct) throw new Refusal(`type-map: ${name} is mapped with schema: contract, so its schema type is ${struct}, which is also a type of the contract: rename one in the contract`);
  }

  /**
   * The type of the generated code that says the schema of a mapped type of `schema: contract`: the type is the application's and has no
   * schema of its own, so the document is written from the contract's model, enum or scalar, under the name the mapped path has.
   */
  private contractSchema(t: Type & { name?: string }, entry: { path: string }): void {
    const name = contractSchemaName(entry.path);
    const written = this.define(name, `contract:${entry.path}`, undefined, (name) => {
      const { schema, deps } = this.schemaOf(t, entry.path);
      const exact = this.schemaOf(t, entry.path, true).schema;
      return `/// The schema of \`${entry.path}\` in the document, written from the contract: the type is the application's and has no schema of its own.
pub struct ${name};
impl ${name} {
    /// The schema as it is written, for the finished document: utoipa holds no keyword beside a reference.
    pub fn exact() -> serde_json::Value {
        ${exact}
    }
}
${manualSchema(name, schema, deps, lastSegment(entry.path))}`;
    });
    if (written !== name) throw new Refusal(`type-map: ${entry.path} is mapped with schema: contract, so its schema type is ${name}, which is also a type of the contract: rename one in the contract`);
  }

  /**
   * The schema of a model, an enum or a scalar of the contract, as a Rust expression of a `serde_json::Value`, and the types it refers to:
   * written from the contract, for a type that has no schema of its own (`what` names it in a refusal).
   */
  private schemaOf(t: Type & { name?: string }, what: string, exact = false): { schema: string; deps: string[] } {
    // An instance whose schema is being written and is met again in it (a template that holds an instance of itself) is a reference to its component.
    const inlined = this.instancesInProgress.length ? asReferences(this.config.inlined, new Set(this.instancesInProgress)) : this.config.inlined;
    const deps: string[] = [];
    const extras = (target: Type) => {
      const values: Record<string, unknown> = { ...constraintValues(this.program, target) };
      const doc = getDoc(this.program, target);
      if (doc) values.description = doc;
      const examples = getExamples(this.program, target as any);
      if (examples.length) values.example = serializeValueAsJson(this.program, examples[0].value, target as any);
      if (isDeprecated(this.program, target)) values.deprecated = true;
      if (target.kind === "ModelProperty" && target.defaultValue) values.default = serializeValueAsJson(this.program, target.defaultValue, target.type);
      return values;
    };
    /** A schema with what the contract states of its target beside it (a doc, a limit). */
    const stated = (schema: string, target: Type) => {
      const values = extras(target);
      return Object.keys(values).length
        ? `{ let mut value = ${schema}; ${exact ? "" : `if value.get("$ref").is_some() && ${Object.keys(values).some((k) => k !== "description")} { value = json!({"allOf": [value]}); } `}if let Some(object) = value.as_object_mut() { object.extend(json!(${rustJson(values)}).as_object().cloned().unwrap_or_default()); } value }`
        : schema;
    };
    /** The schema of a literal type, or of a union of literals (and `null`), as the contract states it. */
    const literalJson = (type: Type): string | undefined => {
      if (type.kind === "String") return `json!({"type": "string", "enum": [${q(type.value)}]})`;
      if (type.kind === "Number") return `json!({"type": ${q(Number.isInteger(type.value) ? "integer" : "number")}, "enum": [${type.value}]})`;
      if (type.kind === "Boolean") return `json!({"type": "boolean", "enum": [${type.value}]})`;
      if (type.kind === "Intrinsic" && type.name === "null") return `json!({"type": "null"})`;
      if (type.kind !== "Union") return undefined;
      const variants = [...type.variants.values()].map((v) => v.type);
      const literals = variants.filter((v) => v.kind === "String" || v.kind === "Number");
      const nulls = variants.filter((v) => v.kind === "Intrinsic" && v.name === "null");
      if (literals.length === 0 || literals.length + nulls.length !== variants.length) return undefined;
      const strings = literals.every((v) => v.kind === "String");
      const numbers = literals.every((v) => v.kind === "Number");
      if (!strings && !numbers) return undefined;
      const values = literals.map((v) => (v.kind === "String" ? q(v.value) : String(v.value)));
      const enumeration = `json!({"type": ${q(strings ? "string" : literals.every((v) => v.kind === "Number" && Number.isInteger(v.value)) ? "integer" : "number")}, "enum": [${values.join(", ")}]})`;
      return nulls.length ? `json!({"anyOf": [${enumeration}, {"type": "null"}]})` : enumeration;
    };
    let schema: string;
    if (t.kind === "Model") {
      const lines = [`let ${t.properties.size || t.baseModel ? "mut " : ""}properties = serde_json::Map::new();`];
      const required: string[] = [];
      const all = ownAndInherited(t);
      for (const p of all) {
        const ty = this.rust(p.type);
        deps.push(...schemaDeps(ty, inlined));
        const literal = literalJson(p.type);
        lines.push(`properties.insert(${q(p.name)}.to_owned(), ${stated(literal ?? schemaExpr(ty, inlined), p)});`);
        if (!p.optional) required.push(p.name);
      }
      const extra: string[] = [];
      if (required.length) extra.push(`schema["required"] = json!([${required.map(q).join(", ")}]);`);
      if (t.indexer) {
        if (isNever(t.indexer.value)) {
          // A closed model: the TypeSpec document says no property is left unevaluated.
          extra.push(exact ? `schema["unevaluatedProperties"] = json!({"not": {}});` : `schema["additionalProperties"] = json!(false);`);
        } else {
          deps.push(...schemaDeps(this.rust(t.indexer.value), inlined));
          extra.push(`schema["additionalProperties"] = ${schemaExpr(this.rust(t.indexer.value), inlined)};`);
        }
      }
      schema = stated(`{ ${lines.join(" ")} let ${extra.length ? "mut " : ""}schema = json!({"type": "object", "properties": properties}); ${extra.join(" ")} schema }`, t);
    } else if (t.kind === "Enum") {
      const values = [...t.members.values()].map((m) => m.value ?? m.name);
      const numeric = values.every((v) => typeof v === "number");
      schema = stated(`json!({"type": ${q(numeric ? (values.every((v) => Number.isInteger(v)) ? "integer" : "number") : "string")}, "enum": [${values.map((v) => (typeof v === "number" ? String(v) : q(String(v)))).join(", ")}]})`, t);
    } else if (t.kind === "Scalar") {
      const root = this.rootOf(t);
      deps.push(...schemaDeps(root, inlined));
      schema = stated(schemaExpr(root, inlined), t);
    } else {
      throw new Refusal(`type-map: ${what} is mapped with schema: contract, which takes a model, an enum or a scalar`);
    }
    return { schema, deps };
  }

  /**
   * Writes `Eq` where the types derive it: with `derive-eq` on, on every type whose parts are all `Eq`. A float is not, nor is a type
   * the application writes that its `type-map` entry does not say is, nor a type made of one of those.
   */
  resolveEq(code: string): string {
    const entries = [...this.config.typeMap.values()];
    const names = (part: string, path: string) => namesPath(part, path);
    /** Every defined type that holds a part `direct` says is one, or a type that does, however deep. */
    const holders = (direct: (part: string) => boolean) => {
      const out = new Set<string>();
      for (const [name, parts] of this.parts) if (parts.some(direct)) out.add(name);
      for (let changed = true; changed; ) {
        changed = false;
        for (const [name, parts] of this.parts) {
          const inner = (part: string) => withoutPaths(part, entries.map((e) => e.path)).match(/\b[A-Z]\w*\b/g) ?? [];
          if (!out.has(name) && parts.some((part) => inner(part).some((other) => out.has(other)))) {
            out.add(name);
            changed = true;
          }
        }
      }
      return out;
    };
    // A float is not `Eq`, nor is a type the application writes that its entry does not say is.
    const notEq = holders((part) => /\bf(32|64)\b/.test(part) || entries.some((e) => !e.eq && names(part, e.path)));
    // A type the application writes that its entry says is not `PartialEq` (`partial-eq: false`) makes every type that holds it neither.
    const notPartial = holders((part) => entries.some((e) => !e.partialEq && names(part, e.path)));
    return code
      .replace(/⟦peq:(\w+)⟧/g, (_, name) => (notPartial.has(name) ? "" : ", PartialEq"))
      .replace(/⟦eq:(\w+)⟧/g, (_, name) => (this.config.deriveEq && !notEq.has(name) && !notPartial.has(name) ? ", Eq" : ""));
  }

  /** Whether the types carry a schema: the document is utoipa's. */
  get documenting(): boolean {
    return this.config.document !== "none";
  }

  /** A hand-written `PartialSchema`/`ToSchema`, or nothing when there is no document. */
  private manual(...args: Parameters<typeof manualSchema>): string {
    return this.documenting ? manualSchema(...args) : "";
  }

  /** `#[schema(..)]` for a property: its constraints and example. */
  schemaAttr(p: Type, extra: string[] = []): string {
    if (!this.documenting || this.writingGeneric) return "";
    // A field that takes its schema from a function states its limits and example there, not beside it.
    const own = extra.some((e) => e.startsWith("schema_with = ")) ? [] : [...constraints(this.program, p), ...this.exampleList(p)];
    const c = [...extra, ...own];
    return c.length ? `    #[schema(${c.join(", ")})]\n` : "";
  }

  nameOf(t: Model | { name?: string; templateMapper?: any }): string {
    const base = ident(t.name || "Anon");
    const args = (t as any).templateMapper?.args ?? [];
    return base + args.map((a: any) => "Of" + this.argName(a)).join("");
  }
  argName(a: any): string {
    if (a.entityKind === "Indeterminate") a = a.type; // a literal passed as a template argument may be a type or a value
    if (a.entityKind === "Type") {
      if (a.kind === "Intrinsic") return pascalIdent(a.name);
      // A literal (`Pick<Pet, "id">`) or a type nothing names is told apart from another by what it is, so two instances are two types.
      if (a.kind === "EnumMember") return `${ident(a.enum.name)}${pascalIdent(a.name)}`;
      if (a.kind === "String" || a.kind === "Number" || a.kind === "Boolean") {
        return `${a.kind === "String" ? "Str" : a.kind === "Number" ? "Num" : "Bool"}${pascalIdent(String(a.value).replace(/-/g, "Minus").replace(/\./g, "Dot"))}`;
      }
      if ((a.kind === "Model" || a.kind === "Union") && !a.name && !(a.kind === "Model" && a.indexer)) return this.numberOf(a);
      if (a.kind === "Model" && a.indexer && !a.name?.length) return "Vec" + this.argName(a.indexer.value);
      if ("name" in a && a.name) return this.nameOf(a);
      if (a.kind === "Model" && a.name === "Array") return "Vec";
    }
    return "X";
  }

  /**
   * The named model an inline model (the body of `A & B`, once the compiler has taken the status code out) is a copy of: the one
   * model it was made from, however many unnamed models lie between, that has exactly its properties.
   */
  private copyOf(t: Model): Model | undefined {
    const same = new Set<Model>();
    const walk = (m: Model) => {
      for (const { model } of m.sourceModels) {
        if (!model.name) walk(model);
        else if (model.properties.size === t.properties.size && [...t.properties.keys()].every((k) => model.properties.has(k))) same.add(model);
      }
    };
    walk(t);
    return same.size === 1 ? [...same][0] : undefined;
  }

  /** The name of a model nothing names, by the order it was first met in. */
  private numberOf(t: Type): string {
    if (!this.numbered.has(t)) this.numbered.set(t, `Anon${this.numbered.size + 1}`);
    return this.numbered.get(t)!;
  }

  /**
   * The Rust type of a value of a map. A derive cannot describe a map whose values may be `null` and are a named type, so such a value
   * is a newtype with its schema written by hand.
   */
  private mapValue(value: Type): string {
    const ty = this.rust(value);
    const named = ty.match(/^(?:Option<)+([A-Z]\w*)>+$/);
    if (!named) return ty;
    const inner = named[1];
    const name = `Nullable${inner}`;
    this.define(name, `nullable:${inner}`, undefined, (name) => {
      this.parts.set(name, [inner]);
      return `/// A \`${inner}\` or \`null\`, the value of a map.
#[derive(Debug, Clone${peqMarker(name)}${eqMarker(name)}, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ${name}(pub Option<${inner}>);

${this.manual(name, `json!({"oneOf": [${schemaExpr(inner, this.config.inlined)}, {"type": "null"}]})`, schemaDeps(inner, this.config.inlined))}`;
    });
    return name;
  }

  /** Whether TypeSpec writes this model out in place wherever it is used: an instance of a template. */
  private isInstance(t: Model): boolean {
    return !!t.templateMapper && t.name !== "Array" && t.name !== "Record";
  }

  rust(t: Type): string {
    switch (t.kind) {
      case "Scalar": return this.scalar(t);
      case "Intrinsic": return t.name === "null" ? "()" : "serde_json::Value";
      case "String": case "Boolean": return t.kind === "String" ? "String" : "bool";
      case "Number": return Number.isInteger(t.value) ? "i64" : "f64";
      case "Enum": return this.enumeration(t);
      case "EnumMember": return this.rust(t.enum); // a member as a type: the enum, which holds more than it says
      case "Union": return this.union(t);
      case "Model": return this.model(t);
      case "TemplateParameter": {
        const name = (t as any).node?.id?.sv as string | undefined;
        if (!name || !this.templateParams.has(name)) throw new Refusal(`a template parameter ${name ?? ""} is used outside the template that declares it`);
        return name;
      }
      default: return "serde_json::Value";
    }
  }

  /**
   * `decimal` is a JSON number that may not fit a float: a newtype over `serde_json::Number`, which keeps it exactly when serde_json's
   * `arbitrary_precision` feature is on and as a float when it is not.
   */
  private decimal(): string {
    this.scalars.add("Decimal");
    return this.alias("Decimal", () => `/// A decimal number, a JSON number. \`serde_json\` keeps its digits only with its \`arbitrary_precision\` feature.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Decimal(pub serde_json::Number);

impl std::fmt::Display for Decimal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.0, f)
    }
}

${this.manual("Decimal", 'json!({"type": "number", "format": "decimal"})', [])}`);
  }

  /** The Rust type at the bottom of a chain of scalars (`scalar Price extends Money; scalar Money extends float64`). */
  private rootOf(t: Type & { kind: "Scalar" }): string {
    if (t.namespace?.name === "TypeSpec" && (t.name === "decimal" || t.name === "decimal128")) return this.decimal();
    if (SCALARS[t.name] && t.namespace?.name === "TypeSpec") return SCALARS[t.name];
    return t.baseScalar ? this.rootOf(t.baseScalar) : "String";
  }

  /** A scalar with a name of its own is a newtype, so the document keeps the name (`Instant`). */
  private scalar(t: Type & { kind: "Scalar" }): string {
    const mapped = this.mapped(t);
    if (mapped) return mapped;
    if (t.namespace?.name === "TypeSpec" && (t.name === "decimal" || t.name === "decimal128")) return this.decimal();
    if (SCALARS[t.name] && t.namespace?.name === "TypeSpec") return SCALARS[t.name];
    const name = ident(t.name);
    return this.define(name, this.identity(t), t, (name) => {
      if (getEncode(this.program, t)) throw new Refusal(`${name}: @encode is not generated: the wire type would differ from the Rust type`);
      this.scalars.add(name);
      const base = t.baseScalar ? this.rust(t.baseScalar) : "String";
      if (this.documenting && [...this.config.typeMap.values()].some((e) => lacksToSchema(e) && base === e.path)) throw new Refusal(`${name}: a scalar that extends ${base}, a type-map entry with inline: true or schema: contract, is a newtype that derives ToSchema over it, which it has not: map ${name} too`);
      this.parts.set(name, [base]);
      const root = this.rootOf(t);
      // A derive cannot write a constraint on a newtype's field, so a constrained scalar takes a schema written by hand.
      const stated = constraintValues(this.program, t);
      const constrained = Object.keys(stated).length > 0;
      const code = scalarNewtype({
        doc: this.doc(t),
        name,
        base,
        // A scalar that extends one the application writes is `Eq` as that one is, and its `Hash` is not known.
        derives: base.includes("::") ? `Debug, Clone${peqMarker(name)}${eqMarker(name)}` : root.startsWith("f") ? "Debug, Clone, PartialEq" : "Debug, Clone, PartialEq, Eq, Hash",
        attr: constrained ? "" : this.schemaAttr(t).trim(),
        schema: !constrained && this.documenting,
      });
      const consts = constantsImpl(name, facts(this.program, t, root));
      if (!constrained) return `${code}${consts}`;
      const description = getDoc(this.program, t);
      // The constraints are written on the type at the bottom of the chain: a `$ref` to the scalar it extends could not hold them.
      const sets = Object.entries({ ...stated, ...(description ? { description } : {}) }).map(([key, value]) => `schema[${q(key)}] = json!(${rustJson(value)});`);
      return `${code}${consts}\n${this.manual(name, `{ let mut schema = ${schemaExpr(root, this.config.inlined)}; ${sets.join(" ")} schema }`, [])}`;
    });
  }

  /** Whether a value of this Rust type is written as text (`Display`): what a `text/plain` body can be. */
  displayable(ty: string): boolean {
    return /^(String|bool|[iuf]\d+)$/.test(ty) || this.scalars.has(ty.slice(ty.lastIndexOf(":") + 1));
  }

  /** An enum is a Rust enum of its members; in `typespec` documents each member is written by hand with its title and description. */
  private enumeration(t: Type & { kind: "Enum" }): string {
    const mapped = this.mapped(t);
    if (mapped) return mapped;
    const name = ident(t.name);
    return this.define(name, this.identity(t), t, (name) =>
      this.valueEnum(name, t, [...t.members.values()].map((m) => ({
        label: m.name,
        value: typeof m.value === "number" || typeof m.value === "string" ? m.value : m.name,
        target: m,
      }))));
  }

  /** The enum of a set of values (an `enum`, or a `union` of string literals): string or number, each member its variant. */
  private valueEnum(name: string, t: Type, all: { label: string; value: string | number; target: Type }[]): string {
    // A value written twice (`("a" | "b") | ("b" | "c")`) is one: the first member that has it.
    // Numbers are not merged: two members with one number is a mistake of the contract, which is refused below.
    const members = all.some((m) => typeof m.value === "number") ? all : all.filter((m, i) => all.findIndex((other) => other.value === m.value) === i);
    const numeric = members.some((m) => typeof m.value === "number");
    if (numeric && members.some((m) => typeof m.value !== "number" || !Number.isInteger(m.value))) {
      throw new Refusal(`${name}: a numeric enum takes whole numbers for every member`);
    }
    if (numeric) {
      const values = new Set<number>();
      for (const m of members) {
        const v = m.value as number;
        if (!Number.isSafeInteger(v)) throw new Refusal(`${name}: ${m.label} = ${v} is beyond the whole numbers a contract can state exactly (2^53)`);
        if (values.has(v)) throw new Refusal(`${name}: two members are both ${v}: a Rust enum cannot hold two variants of one number`);
        values.add(v);
      }
    }
    const variants = uniqueNames();
    const data: EnumMember[] = members.map((m) => ({ doc: this.doc(m.target, "    "), variant: variants(pascalIdent(m.label) || "Empty"), wire: m.value }));
    const derived = this.config.document === "derived" && !numeric;
    const code = (numeric ? numericEnum : stringEnum)({ doc: this.doc(t), name, members: data, schema: derived });
    const prefixes = new Set<string>();
    const consts = [...facts(this.program, t, name), ...members.flatMap((m) => {
      const prefix = constPrefix(rustField(m.label));
      if (prefixes.has(prefix)) return []; // `a` and `A` are one prefix: the first has the constants
      prefixes.add(prefix);
      return facts(this.program, m.target, name, prefix);
    })];
    if (derived || !this.documenting) return `${code}${constantsImpl(name, consts)}`;
    // As `@typespec/openapi3` writes an enum: one `enum` (the default), or a `oneOf` of `const` members annotated with their title and doc.
    const schema = { description: getDoc(this.program, t), type: numeric ? "number" : "string", enum: members.map((m) => m.value) };
    const annotated = { description: getDoc(this.program, t), oneOf: members.map((m) => ({ const: m.value, title: getSummary(this.program, m.target), description: getDoc(this.program, m.target) })) };
    // utoipa holds no `const`: the finished document takes the schema as it is written here.
    if (this.config.enumStrategy === "annotated") this.config.exact.set(name, JSON.stringify(annotated));
    return `${code}${constantsImpl(name, consts)}\n${this.manual(name, jsonText(schema), [])}`;
  }

  /** A union of two or more variants is an untagged enum with a hand-written `anyOf` (`oneOf` under `@oneOf`) schema. */
  private union(t: Type & { kind: "Union" }): string {
    this.mapped(t); // refused when named in the type-map
    // `Named | null` is that union, or `null`: an `Option`. Said before the union is flattened, which would copy its variants (and a
    // union that holds itself through a list would be copied for ever).
    const direct = [...t.variants.values()];
    const solo = direct.filter((v) => !isNull(v.type));
    if (direct.length === 2 && solo.length === 1 && solo[0].type.kind === "Union" && solo[0].type.name && !isLiteralUnion(solo[0].type)) {
      return `Option<${this.rust(solo[0].type)}>`;
    }
    const flat = flattenUnion(t);
    // A union of string literals, named ones among them, is read as the literals themselves.
    const variants = onlyLiterals(flat) ? deepVariants(flat) : flat;
    const nonNull = variants.filter(([, v]) => !isNull(v.type));
    // A named union of string literals and `null` is a string enum that may be null: the enum, in an `Option`.
    if (t.name && nonNull.length > 0 && nonNull.length < variants.length && nonNull.every(([, v]) => v.type.kind === "String")) {
      const inner = `${this.nameOf(t)}Value`;
      this.define(inner, `${this.identity(t)}#value`, t, (inner) =>
        this.valueEnum(inner, t, nonNull.map(([, v]) => ({ label: (v.type as any).value, value: (v.type as any).value, target: v }))));
      return `Option<${inner}>`;
    }
    // `X | null` is an `Option` of X, unless X holds this union: then this is an enum, which is what lets the type hold itself.
    if (nonNull.length === 1 && variants.length === 2 && !refersTo(nonNull[0][1].type, t)) return `Option<${this.rust(nonNull[0][1].type)}>`;
    if (!t.name && nonNull.length > 0 && nonNull.every(([, v]) => v.type.kind === "String")) {
      // `"a" | "b"` is a string; its values are the schema's business (`literalSchema`).
      return variants.length > nonNull.length ? "Option<String>" : "String";
    }
    // A union nothing names whose variants are members of one enum is that enum.
    if (!t.name && nonNull.length > 0 && nonNull.every(([, v]) => v.type.kind === "EnumMember" && v.type.enum === (nonNull[0][1].type as any).enum)) {
      const only = this.rust((nonNull[0][1].type as any).enum);
      return variants.length > nonNull.length ? `Option<${only}>` : only;
    }
    // A union nothing names (`string | int32`) is an untagged enum like a named one, numbered like any other nameless type.
    const name = t.name ? this.nameOf(t) : this.numberOf(t);
    // A union of string literals is a string enum.
    if (variants.length > 0 && variants.every(([, v]) => v.type.kind === "String")) {
      return this.define(name, this.identity(t), t, (name) =>
        this.valueEnum(name, t, variants.map(([, v]) => ({ label: (v.type as any).value, value: (v.type as any).value, target: v }))));
    }
    return this.define(name, this.identity(t), t, (name) => {
      // Known before the variants are read: a variant may refer back to this union, and a field of it must know `null` is a value.
      if (unionIsNullable(t)) this.nullables.add(name);
      const types = variants.map(([, v]) => this.rust(v.type));
      const lists = variants.map(([, v]) => acceptsArray(v.type));
      const declared = [...types]; // the document lists the variants as the contract does
      // An untagged enum reads a value as the first variant that takes it, and a struct takes a JSON array too: lists go first.
      const order = types.map((_, i) => i).sort((a, b) => Number(lists[b]) - Number(lists[a]) || a - b);
      variants.splice(0, variants.length, ...order.map((i) => variants[i]));
      types.splice(0, types.length, ...order.map((i) => types[i]));
      // Unions that are variants of each other read nothing as they go: a value that matches neither would be tried by each, for ever.
      this.parts.set(name, types);
      if (types.some((ty) => ty === "()" || ty.startsWith("Option<") || this.nullables.has(ty))) this.nullables.add(name);
      // A variant that is a type being defined holds it directly: boxed, or the union and that type would each contain the other.
      const held = types.map((ty) => this.boxIfDirect(ty));
      const oneOf = (t as any).decorators.some((d: any) => d.definition?.name === "@oneOf");
      const schemas = declared.map((ty) => schemaExpr(ty, this.config.inlined));
      const body = schemas.length === 1 ? schemas[0] : `json!({${oneOf ? '"oneOf"' : '"anyOf"'}: [${schemas.join(", ")}]})`;
      const description = getDoc(this.program, t);
      const schema = description ? `{ let mut schema = ${body}; schema["description"] = json!(${q(description)}); schema }` : body;
      const names = uniqueNames();
      const code = untaggedUnion({
        doc: this.doc(t),
        name,
        variants: variants.map(([k, v], i) => ({
          name: names(typeof k === "string" ? pascalIdent(k) : types[i] === "()" ? "Null" : pascalIdent(types[i].replace(/(?<![\w:])(?:::)?(?!(?:std|core|alloc|serde_json|serde|axum|utoipa)::)[a-z_]\w*::(?:[a-z_]\w*::)*/g, "").replace(/\W+/g, " ")) || "Value"),
          ty: held[i],
        })),
      });
      const prefixes = new Set<string>();
      const consts = [...facts(this.program, t, name), ...variants.flatMap(([k, v]) => {
        if (typeof k !== "string") return [];
        const prefix = constPrefix(rustField(k));
        if (prefixes.has(prefix)) return [];
        prefixes.add(prefix);
        return facts(this.program, v, name, prefix);
      })];
      return `${code}${constantsImpl(name, consts)}\n${this.manual(name, schema, types.flatMap((ty) => schemaDeps(ty, this.config.inlined)))}`;
    });
  }

  private model(t: Type & { kind: "Model" }): string {
    // In a template's declaration `T[]` and `Record<T>` are not resolved: the element is the template's argument.
    if ((t.name === "Array" || t.name === "Record") && !t.indexer) {
      const element = elementOf(t);
      if (element) return t.name === "Array" ? `Vec<${this.rust(element)}>` : `std::collections::BTreeMap<String, ${this.mapValue(element)}>`;
    }
    if (t.name === "Array" && t.indexer) return `Vec<${this.rust(t.indexer.value)}>`;
    if (t.name === "Record" && t.indexer) return `std::collections::BTreeMap<String, ${this.mapValue(t.indexer.value)}>`;
    if (!t.name && t.properties.size === 0 && !t.indexer) return "serde_json::Value"; // `{}`: an open object; a field says so with value_type
    const mapped = this.mapped(t);
    if (mapped) return mapped;
    // An instance of a template, or a model that is a copy of one (`CreatedResponse & Envelope<X>` once the status code is out).
    const instance = this.isInstance(t) ? t : !t.name ? this.copyOf(t) : undefined;
    const generic = instance && this.isInstance(instance) ? this.generic(instance) : undefined;
    if (generic) return generic;
    // An inline model takes the name of the model it copies, and is numbered when it copies none.
    const copied = t.name ? undefined : this.copyOf(t);
    const name = t.name ? this.nameOf(t) : copied ? this.nameOf(copied) : this.numberOf(t);
    if (this.isInstance(t) || (copied && this.isInstance(copied))) this.config.inlined.add(name);
    return this.define(name, t.name || copied ? this.identity(copied ?? t) : name, copied ?? t, (name) => {
      if (t.indexer && t.properties.size > 0 && !isNever(t.indexer.value)) {
        throw new Refusal(`${name}: a model with properties and additional properties (\`...Record<T>\`) is not generated`);
      }
      // `model X is Record<T>` (or `T[]`) has no properties of its own: a newtype over the map (or list).
      if (t.indexer && t.properties.size === 0 && !isNever(t.indexer.value)) {
        const inner = t.indexer.key.name === "integer"
          ? `Vec<${this.rust(t.indexer.value)}>`
          : `std::collections::BTreeMap<String, ${this.mapValue(t.indexer.value)}>`;
        this.parts.set(name, [inner]);
        // A derive cannot be told not to follow the type inside a newtype, so one that holds itself has its schema written by hand.
        // The same for one that holds a type with no `ToSchema` for the derive (an instance of a generic struct, a type of the application's).
        const recursive = this.reachesInProgress(inner) || inner.includes("serde_json::Value") || this.holdsToldType(inner);
        const code = containerNewtype({ doc: this.doc(t), name, inner, schema: !recursive && this.documenting }) + constantsImpl(name, facts(this.program, t, name));
        if (!recursive) return code;
        const description = getDoc(this.program, t);
        const body = schemaExpr(inner, this.config.inlined);
        const schema = description ? `{ let mut schema = ${body}; schema["description"] = json!(${q(description)}); schema }` : body;
        return `${code}\n${this.manual(name, schema, schemaDeps(inner, this.config.inlined))}`;
      }
      const fields = ownAndInherited(t).map((p) => this.field(name, p));
      this.parts.set(name, fields.map((f) => f.ty));
      const seen = new Set<string>();
      for (const f of fields) {
        if (seen.has(f.ident)) throw new Refusal(`${name}: two properties are both the Rust field ${f.ident}: rename one in the contract`);
        seen.add(f.ident);
      }
      // `...Record<never>` closes a model: a property it does not list is refused, not dropped.
      const closed = !!t.indexer && isNever(t.indexer.value);
      return structDef({ doc: this.doc(t), name, example: this.exampleList(t).join(", "), closed, schema: this.documenting, fields, consts: facts(this.program, t, name) });
    });
  }

  /**
   * An instance of a template as the instance of a generic struct: `Envelope<Vec<Held>>` is `Envelope<Vec<Held>>`, one struct for
   * every instance. With a document the struct derives no schema and each instance has a type that says its own. Only for a template whose parameters
   * are the types of its fields (`T`, `T[]`, `Record<T>`) or are not used by one; else undefined, and each instance is a struct of its own.
   */
  private generic(t: Model): string | undefined {
    if (!t.node || !t.templateMapper) return undefined;
    // A literal or an alias passed as an argument may be a type or a value, which `Indeterminate` says.
    const args = t.templateMapper.args.map((a) => (a.entityKind === "Indeterminate" ? (a as any).type : a) as typeof a);
    if (!args.every((a) => a.entityKind === "Type" && ["Model", "Scalar", "Enum", "Union", "Intrinsic"].includes((a as Type).kind))) return undefined;
    const declaration = this.program.checker.getTypeForNode(t.node) as Model;
    const params = ((declaration.node as any)?.templateParameters ?? []).map((p: any) => p.id.sv as string);
    if (declaration.kind !== "Model" || params.length === 0 || params.length !== args.length || declaration.baseModel || declaration.indexer) return undefined;
    // A parameter named like a keyword, like a type the generated code uses or like any type of the contract (defined yet or not) would be shadowed.
    const taken = this.typeNames();
    if (params.some((p: string) => !/^[A-Za-z_]\w*$/.test(p) || isKeyword(p) || RESERVED.has(p) || taken.has(p) || this.defs.has(p) || this.identities.has(p))) return undefined;
    // The compiler runs decorators and spreads on an instance, so an instance whose properties are not the declaration's (`@withOptionalProperties`, `...T`) is its own struct.
    const own = [...declaration.properties.values()];
    if (t.properties.size !== own.length || own.some((p) => t.properties.get(p.name)?.optional !== p.optional)) return undefined;
    // A union of literals passed as an argument is a string in Rust, which does not check the values: that instance is its own struct.
    const literalUnion = (a: Type) => a.kind === "Union" && !a.name && deepVariants(flattenUnion(a)).some(([, v]) => ["String", "Number", "Boolean"].includes(v.type.kind));
    if (args.some((a) => literalUnion(a as Type))) return undefined;
    const used = new Set<string>();
    const simple = (ty: Type): boolean => {
      if (ty.kind === "TemplateParameter") {
        used.add((ty as any).node.id.sv);
        return true;
      }
      if (ty.kind === "Model" && (ty.name === "Array" || ty.name === "Record")) {
        const element = elementOf(ty);
        return element ? simple(element) : true;
      }
      return !this.mentionsParameter(ty);
    };
    if (![...declaration.properties.values()].every((p) => simple(p.type)) || params.some((p: string) => !used.has(p))) return undefined;
    const name = ident(declaration.name);
    // A template named like a type the generated code uses is not one struct, but a struct for each instance (`BoxOfString`).
    if (RESERVED.has(name)) return undefined;
    const typeArgs = args.map((a) => this.rust(a as Type));
    // An argument that may be `null` makes a field of that type one a generic struct would read as absent: that instance is its own struct.
    if (typeArgs.some((a) => a.startsWith("Option<") || this.nullables.has(a))) return undefined;
    const written = this.define(name, `generic:${this.identity(declaration)}`, declaration, (name) => {
      params.forEach((p: string) => this.genericNames.add(p));
      const before = this.templateParams;
      this.templateParams = new Set(params);
      this.genericStructs.add(name);
      try {
        const fields = ownAndInherited(declaration).map((p) => this.field(name, p, t.properties.get(p.name) ?? p));
        this.parts.set(name, fields.map((f) => f.ty));
        const seen = new Set<string>();
        for (const f of fields) {
          if (seen.has(f.ident)) throw new Refusal(`${name}: two properties are both the Rust field ${f.ident}: rename one in the contract`);
          seen.add(f.ident);
        }
        return structDef({ doc: this.doc(t), name, generics: params, closed: false, schema: false, fields, consts: facts(this.program, t, name) });
      } finally {
        this.templateParams = before;
      }
    });
    const text = `${written}<${typeArgs.join(", ")}>`;
    // The generic struct derives no schema: with a document, each instance has a type that says its own, under the name the instance has.
    if (this.documenting) {
      // Two instances that are one Rust type (`Envelope<string>` and `Envelope<utcDateTime>`) cannot have a schema each: the later is a struct of its own.
      const component = this.nameOf(t);
      const prior = this.instanceNames.get(text);
      if (prior !== undefined && prior !== component) return undefined;
      this.instanceNames.set(text, component);
      this.instanceSchema(t, text);
    }
    return text;
  }

  /** The types that say the schema of the instances a type holds in a field the derive is told not to follow. */
  private readonly hiddenHeld = new Map<string, string[]>();

  /** The spellings of the instances whose schema is being written. */
  private readonly instancesInProgress: string[] = [];

  /** The component each spelling of an instance of a generic struct has. */
  private readonly instanceNames = new Map<string, string>();

  /** The generic structs written: no schema is derived for one, so no document lists it. */
  readonly genericStructs = new Set<string>();

  /**
   * The type of the generated code that says the schema of an instance of a template written as a generic struct: the component has the name the
   * instance has as a struct of its own (`EnvelopeOfPet`), so the document is the one it has always been.
   */
  private instanceSchema(t: Model, text: string): void {
    const component = this.nameOf(t);
    const struct = `${component}Schema`;
    // The files that name the types by path (`axum.rs`) spell the instance with that path in front of each type of the contract.
    const qualified = text.replace(/(?<![\w:])[A-Z]\w*/g, (n) => (this.defs.has(n) ? `${this.config.typesPath}::${n}` : n));
    for (const spelled of new Set([text, qualified])) this.config.inlined.add(schemaTypeKey(spelled, struct, component, true));
    const written = this.define(struct, `instance-schema:${text}`, undefined, (struct) => {
      this.instancesInProgress.push(text, qualified);
      let schema: string, deps: string[];
      try {
        ({ schema, deps } = this.schemaOf(t, text));
      } finally {
        this.instancesInProgress.length -= 2;
      }
      return `/// The schema of \`${text}\` in the document: the generic struct derives none, and the instance has the name it has as a struct of its own.\npub struct ${struct};\n${manualSchema(struct, schema, deps, component)}`;
    });
    if (written !== struct) throw new Refusal(`${text}: its schema type would be ${struct}, which is also a type of the contract: rename one in the contract`);
  }

  /** Whether a Rust type holds one whose schema a type of the generated code tells, or a type of the application's with no `ToSchema` for a derive. */
  private holdsToldType(ty: string): boolean {
    return this.documenting && ([...schemaTypes(this.config.inlined).keys()].some((p) => namesPath(ty, p)) || [...this.config.typeMap.values()].some((e) => lacksToSchema(e) && namesPath(ty, e.path)));
  }

  private allTypeNames?: Map<string, number>;

  /** How many models, enums, unions and scalars of each name the contract declares, wherever they are. */
  private typeNameCounts(): Map<string, number> {
    if (!this.allTypeNames) {
      const counts = new Map<string, number>();
      const walk = (ns: any) => {
        for (const kind of ["models", "enums", "unions", "scalars"]) for (const n of ns[kind].keys()) counts.set(ident(n), (counts.get(ident(n)) ?? 0) + 1);
        for (const child of ns.namespaces.values()) if (child.name !== "TypeSpec") walk(child);
      };
      walk(this.program.getGlobalNamespaceType());
      this.allTypeNames = counts;
    }
    return this.allTypeNames;
  }

  private typeNames(): ReadonlySet<string> {
    return new Set(this.typeNameCounts().keys());
  }

  /** Whether a type is made, however deep, of a template parameter. */
  private mentionsParameter(t: Type, seen = new Set<Type>()): boolean {
    if (seen.has(t)) return false;
    seen.add(t);
    switch (t.kind) {
      case "TemplateParameter": return true;
      case "Model":
        return (!!elementOf(t) && this.mentionsParameter(elementOf(t)!, seen))
          || (!!t.templateMapper && t.templateMapper.args.some((a) => a.entityKind === "Type" && this.mentionsParameter(a as Type, seen)))
          || (!t.name && [...t.properties.values()].some((p) => this.mentionsParameter(p.type, seen)));
      case "Union": return [...t.variants.values()].some((v) => this.mentionsParameter(v.type, seen));
      default: return false;
    }
  }

  /**
   * Whether a Rust type is made, however deep, of a type still being defined: following it from here would come back to where it
   * started. `Tree` in `children: Tree[]`, and `Kids` in `kids: Kids` when `union Kids { Node[] }` and `Node` is the one being defined.
   */
  private reachesInProgress(ty: string, seen = new Set<string>()): boolean {
    for (const name of ty.match(/\b[A-Z]\w*\b/g) ?? []) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (this.defs.get(name) === "") return true;
      if ((this.parts.get(name) ?? []).some((part) => this.reachesInProgress(part, seen))) return true;
    }
    return false;
  }

  /** A type held directly (not in a `Vec` or a map) that is still being defined has no size until it is boxed. */
  private boxIfDirect(ty: string): string {
    const option = ty.match(/^Option<(.*)>$/);
    if (option) return `Option<${this.boxIfDirect(option[1])}>`;
    return this.holdsInline(ty) ? `Box<${ty}>` : ty;
  }

  /**
   * Whether a value of this Rust type has a type still being defined inside it, not behind a `Vec`, a map or a `Box`: it would have
   * no size. A generic struct holds its arguments inline, so `Envelope<Node>` inside `Node` is one.
   */
  private holdsInline(ty: string, seen = new Set<string>()): boolean {
    const option = ty.match(/^Option<(.*)>$/);
    if (option) return this.holdsInline(option[1], seen);
    const named = ty.match(/^([A-Z]\w*)(?:<(.*)>)?$/);
    if (!named || named[1] === "Vec" || named[1] === "Box") return false;
    const [, name, args] = named;
    if (this.defs.get(name) === "") return true;
    if (args !== undefined && topLevelCommas(args).some((arg) => this.holdsInline(arg, seen))) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return (this.parts.get(name) ?? []).some((part) => this.holdsInline(part, seen));
  }

  /** `source` is the property whose decorators and doc state the field's facts: in a generic struct, a property of an instance (a declaration's decorators are not run). */
  private field(owner: string, p: ModelProperty, source: ModelProperty = p): StructField {
    if (source.decorators.some((d: any) => d.definition?.name === "@visibility" || d.definition?.name === "@invisible")) {
      throw new Refusal(`${owner}.${p.name}: @visibility is not generated: one struct serves every operation, so the wire shape cannot differ between them`);
    }
    if (getEncode(this.program, source)) throw new Refusal(`${owner}.${p.name}: @encode is not generated: the wire type would differ from the Rust type`);
    const plain = this.rust(p.type);
    // A type that refers back to one being defined (`children: Tree[]`, `parent?: Tree`) is boxed where it would have no size, and its
    // schema is not followed again, or utoipa would never finish collecting it.
    const inProgress = this.reachesInProgress(plain);
    const ty = this.boxIfDirect(plain);
    // A field that may be left out and may be `null` tells the two apart: `Some(None)` is `null`.
    const doubled = p.optional && (ty.startsWith("Option<") || this.nullables.has(plain));
    const optional = doubled && !ty.startsWith("Option<") ? `Option<Option<${ty}>>` : p.optional ? `Option<${ty}>` : ty;
    if (inProgress) for (const name of plain.match(/\b[A-Z]\w*\b/g) ?? []) if (this.defs.has(name) && !this.genericStructs.has(name)) this.hidden.add(name);
    // So is the type that says the schema of an instance such a field holds: the document lists it with the type that holds it.
    if (inProgress) {
      for (const [path, told] of schemaTypes(this.config.inlined)) {
        if (!told.inline || !namesPath(plain, path)) continue;
        this.hidden.add(told.struct);
        this.hiddenHeld.set(owner, [...(this.hiddenHeld.get(owner) ?? []), told.struct]);
      }
    }
    const open = p.type.kind === "Model" && !p.type.name && p.type.properties.size === 0 && !p.type.indexer;
    // Only a `typespec` document is exact to the letter; a `derived` one leaves each field to the derive.
    const literal = this.config.document === "typespec" && !this.writingGeneric ? this.literalSchema(p.type, owner, p) ?? this.formatSchema(owner, p) ?? this.nullSchema(owner, p) : undefined;
    // `Option<T>` is nullable in a schema; an optional field TypeSpec does not make `| null` is neither nullable nor required.
    const plainOptional = p.optional && !ty.startsWith("Option<") && !open && !literal;
    const allowed = this.literalStrings(p.type);
    const deserialize = allowed
      ? this.literalReader(owner, p, allowed, doubled ? "double" : p.optional || ty.startsWith("Option<") ? "option" : "plain")
      : doubled ? "double_option" : !p.optional && ty.startsWith("Option<") ? "required_option" : undefined;
    // The TypeSpec document writes an instance of a template (`Begun<X>`) out in place.
    // So is a union nothing names (`string | int32`), which has a Rust type of its own only because Rust needs one.
    // Not when the field refers back to what it is part of: written in place it would never end.
    const instance = !inProgress && ((p.type.kind === "Model" && this.isInstance(p.type)) || (p.type.kind === "Union" && !p.type.name && /^Anon\d+$/.test(plain)));
    const inlineMapped = [...this.config.typeMap.values()].some((e) => onlyPartial(e) && namesPath(plain, e.path));
    // utoipa asks for `ToSchema` of what a field holds (`value_type`, the element of a `Vec`), which an inline type has not: the field takes its schema from a function.
    if (this.documenting && !this.writingGeneric && inlineMapped && (constraints(this.program, p).length || this.exampleList(p).length)) throw new Refusal(`${owner}.${p.name}: a field of a type-map entry with inline: true takes no constraint or example: they have no way to reach the schema the application writes`);
    const viaFn = this.documenting && !this.writingGeneric && inlineMapped ? this.partialSchemaFn(owner, p, schemaExpr(plain, this.config.inlined)) : undefined;
    const written = [
      ...(inProgress ? ["no_recursion"] : []),
      // A mapped type the entry says is written in place (`inline`), though its path looks like a component (`uuid::Uuid`), is read from its own `PartialSchema`.
      ...(instance ? ["inline"] : []),
      ...(viaFn ? [`schema_with = ${viaFn}`, ...(plainOptional || doubled ? ["required = false"] : [])] : []),
      ...(open ? ["value_type = Object"] : []),
      ...(literal ? [`schema_with = ${literal}`] : []),
      ...(!p.optional && optional.startsWith("Option<") ? ["required = true"] : []),
      ...(plainOptional && !viaFn ? [`value_type = ${plain}`, "required = false"] : []),
      ...(doubled && !viaFn ? [`value_type = ${ty.replace(/Box<([^<>]*)>/g, "$1")}`, "required = false"] : []),
      ...(p.defaultValue ? [`default = json!(${rustJson(serializeValueAsJson(this.program, p.defaultValue, p.type))})`] : []),
    ];
    // utoipa writes a `serde_json::Value` as an empty schema, which it cannot read back: say it is an object, as everywhere else it is written.
    const objectOf = (text: string) => text.replace(/serde_json::Value/g, "Object");
    const extra = written.map((e) => (e.startsWith("value_type = ") ? forSchema(objectOf(e), this.config.inlined) : e));
    if (!written.some((e) => e.startsWith("value_type = ")) && !literal && ty.includes("serde_json::Value")) extra.push(`value_type = ${forSchema(objectOf(ty), this.config.inlined)}`);
    // A type whose schema a type of the generated code tells (the contract's, an instance of a generic struct) has no `ToSchema` for the derive: the field says the type that has.
    if (this.documenting && !extra.some((e) => e.startsWith("value_type = ")) && [...schemaTypes(this.config.inlined).keys()].some((p) => namesPath(plain, p))) extra.push(`value_type = ${forSchema(plain, this.config.inlined)}`);
    return { doc: this.doc(source, "    "), attr: this.schemaAttr(p, extra), serde: p.name, ident: rustField(p.name), ty: optional, optional: p.optional, deserialize, consts: facts(this.program, source, ty, constPrefix(rustField(p.name))) };
  }

  /** The values of a property typed as string literals (`"cat"`, `"a" | "b"`, either with `| null`), or undefined for any other type. */
  private literalStrings(t: Type): string[] | undefined {
    const variants = t.kind === "Union" && !t.name ? deepVariants(flattenUnion(t)).map(([, v]) => v.type) : [t];
    const strings = variants.filter((v) => v.kind === "String").map((v) => (v as any).value as string);
    return strings.length > 0 && strings.length + variants.filter(isNull).length === variants.length ? strings : undefined;
  }

  private readonly fnNames = new Map<string, string>();

  /** A name for a helper function of one property: lower-cased like Rust's, and never another property's (`cD` and `cd` are two). */
  private fnName(kind: string, owner: string, property: ModelProperty): string {
    const key = `${kind}|${owner}|${property.name}`;
    let name = this.fnNames.get(key);
    if (name === undefined) {
      const base = `${kind}_${owner}_${ident(property.name)}`.toLowerCase();
      name = base;
      for (let n = 2; this.defs.has(`fn ${name}`); n++) name = `${base}_${n}`;
      this.fnNames.set(key, name);
    }
    return name;
  }

  /** The function that reads such a field, so a value that is not one of them is refused (an untagged union picks its variant by this). */
  private literalReader(owner: string, property: ModelProperty, allowed: string[], shape: "plain" | "option" | "double"): string {
    const name = this.fnName("literal", owner, property);
    const list = `&[${allowed.map(q).join(", ")}]`;
    const [returns, helper] = shape === "double" ? ["Option<Option<String>>", "double_one_of"] : shape === "option" ? ["Option<String>", "one_of_option"] : ["String", "one_of"];
    this.alias(`fn ${name}`, () => `fn ${name}<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<${returns}, D::Error> {\n    ${helper}(deserializer, ${list})\n}`);
    return name;
  }

  /** The reference to a scalar the application writes as a primitive (`Instant`), or the list of one, or undefined. */
  private refSchema(t: Type): object | undefined {
    const scalar = this.contractScalars.get(t);
    if (scalar) return { $ref: `#/components/schemas/${scalar.name}` };
    if (t.kind === "Model" && t.name === "Array" && t.indexer) {
      const items = this.refSchema(t.indexer.value);
      return items ? { type: "array", items } : undefined;
    }
    return undefined;
  }

  /** The schemas of the members of a union with the literals of one kind written as one `enum`, in the order the kinds first come. */
  private groupLiterals(variants: Type[], schemas: object[]): object[] {
    const grouped = new Map<string, { type: string; enum: unknown[] }>();
    const out: object[] = [];
    variants.forEach((v, i) => {
      if (v.kind !== "String" && v.kind !== "Number" && v.kind !== "Boolean") return void out.push(schemas[i]);
      const kind = v.kind === "String" ? "string" : v.kind === "Boolean" ? "boolean" : Number.isInteger((v as any).value) ? "integer" : "number";
      let group = grouped.get(kind);
      if (!group) {
        group = { type: kind, enum: [] };
        grouped.set(kind, group);
        out.push(group);
      }
      group.enum.push((v as any).value);
    });
    return out;
  }

  /**
   * The schema of a type a property of `T | null` holds, as JSON: a scalar the document writes by itself, a list of one, or a type the
   * emitter writes (a reference to its component). Undefined for any other type (the derive writes it).
   */
  private plainSchema(v: Type, property: ModelProperty): object | undefined {
    const scalar = this.contractScalars.get(v);
    if (scalar) return { $ref: `#/components/schemas/${scalar.name}` };
    // A type the application writes whose schema is the contract's is a component too.
    if (v.kind === "Model" || v.kind === "Enum") {
      const told = schemaTypes(this.config.inlined).get(this.rust(v));
      if (told && !told.inline) return { $ref: `#/components/schemas/${told.name}` };
    }
    const withLimits = (schema: object) => schema; // the limits a property states are the union's, beside its anyOf
    if (v.kind === "Model" && v.name === "Array" && v.indexer) {
      const items = this.plainSchema(v.indexer.value, property);
      return items ? { type: "array", items } : undefined;
    }
    if (v.kind === "Scalar" && v.namespace?.name === "TypeSpec") {
      const rust = this.rust(v);
      if (rust === "String" && v.name === "string") return withLimits({ type: "string" });
      if (rust === "bool") return withLimits({ type: "boolean" });
      const number = /^[iu](8|16|32|64)$/.exec(rust);
      if (number && v.name !== "safeint" && v.name !== "integer") return withLimits({ type: "integer", format: v.name });
      if (/^f(32|64)$/.test(rust) && (v.name === "float32" || v.name === "float64")) return withLimits({ type: "number", format: v.name });
      return undefined;
    }
    if (v.kind === "Model" || v.kind === "Enum" || v.kind === "Union" || v.kind === "Scalar") {
      // An instance of a template is written in place, not a component to refer to.
      if ((v as any).templateMapper) return undefined;
      const ty = this.rust(v);
      if (!/^[A-Z]\w*$/.test(ty) || !this.defs.has(ty) || this.genericStructs.has(ty)) return undefined;
      // The field takes its schema from a function, so the derive does not follow its type: the document must be told of it.
      this.hidden.add(ty);
      return { $ref: `#/components/schemas/${ty}` };
    }
    return undefined;
  }

  /**
   * A property typed `"serving"` or `"a" | "b"` is a string whose values the schema lists; a derive cannot say so, so the field takes
   * its schema from a generated function. Returns the function's name, or undefined for any other type.
   */
  private literalSchema(t: Type, owner: string, property: ModelProperty): string | undefined {
    const one = (v: Type): object | undefined =>
      v.kind === "String" ? { type: "string", enum: [v.value] }
        : v.kind === "Number" ? { type: Number.isInteger(v.value) ? "integer" : "number", enum: [v.value] }
        : v.kind === "Boolean" ? { type: "boolean", enum: [v.value] }
        : isNull(v) ? { type: "null" } : undefined;
    // A scalar the application writes as a primitive, or a list of it, is a reference to the scalar's component.
    const direct = t.kind === "Scalar" || (t.kind === "Model" && t.name === "Array") ? this.refSchema(t) : undefined;
    if (direct) return this.schemaFn(owner, property, direct);
    const variants = t.kind === "Union" && !t.name ? deepVariants(flattenUnion(t)).map(([, v]) => v.type) : [t];
    // `T | null`, with T no literal: `anyOf` of T and `null`, as the TypeSpec document writes it (a derive writes `type: [T, null]`).
    const nullable = variants.length === 2 && variants.some(isNull) && !variants.some((v) => one(v) !== undefined && !isNull(v));
    const schemas = variants.map((v) => one(v) ?? (nullable ? this.plainSchema(v, property) : undefined));
    if (schemas.some((s) => s === undefined) || variants.every(isNull)) return undefined;
    // The literals of one kind are one `enum`, as `@typespec/openapi3` groups them (its annotated strategy writes a `const` each, which utoipa cannot hold).
    const members = this.groupLiterals(variants, schemas as object[]);
    // The limits a property states are beside the `anyOf`, as `@typespec/openapi3` applies them to the whole property.
    const body = (list: object[]) => (list.length === 1 ? list[0]! : { anyOf: list, ...(nullable ? constraintValues(this.program, property) : {}) });
    // The annotated strategy writes each literal as a `const`, which utoipa cannot hold: the finished document has it, the function the plain form.
    const annotated = this.config.enumStrategy === "annotated" && variants.length > 1 && variants.some((v) => v.kind === "String" || v.kind === "Number" || v.kind === "Boolean")
      ? body(schemas.map((s, i) => (variants[i].kind === "String" || variants[i].kind === "Number" || variants[i].kind === "Boolean" ? { const: (variants[i] as any).value } : s) as object))
      : undefined;
    return this.schemaFn(owner, property, body(members), annotated);
  }

  /**
   * A property typed `uint32` (or `uint8`, `int16`, ...) is `format: uint32` in the TypeSpec document, which a derive cannot write:
   * it writes `int32` (with `minimum: 0` for an unsigned one). Returns the name of the function that gives the field its schema,
   * or undefined.
   */
  private formatSchema(owner: string, property: ModelProperty): string | undefined {
    const t = property.type;
    if (t.kind !== "Scalar" || t.namespace?.name !== "TypeSpec" || !/^(uint(8|16|32|64)|int(8|16))$/.test(t.name)) return undefined;
    return this.schemaFn(owner, property, { type: "integer", format: t.name, ...constraintValues(this.program, property) });
  }

  /** A property typed `null` (a `()`) is `type: null` in the TypeSpec document; a derive writes `default: null`. */
  private nullSchema(owner: string, property: ModelProperty): string | undefined {
    return isNull(property.type) ? this.schemaFn(owner, property, { type: "null" }) : undefined;
  }

  /** The function that gives a field the schema of its type's own `PartialSchema`. Returns its name. */
  private partialSchemaFn(owner: string, property: ModelProperty, schema: string): string {
    const name = this.fnName("schema", owner, property);
    this.alias(`fn ${name}`, () => partialSchemaFn(name, schema, getDoc(this.program, property)));
    return name;
  }

  /** The function that gives a field the schema `body`, with the field's own doc as its description. Returns its name. */
  private schemaFn(owner: string, property: ModelProperty, body: object, exactBody?: object): string {
    const name = this.fnName("schema", owner, property);
    this.alias(`fn ${name}`, () => {
      // With `schema_with` the derive no longer adds the field's doc as its description.
      const description = getDoc(this.program, property);
      const fallback = property.defaultValue ? { default: serializeValueAsJson(this.program, property.defaultValue, property.type) } : {};
      const examples = getExamples(this.program, property);
      const example = examples.length ? { example: serializeValueAsJson(this.program, examples[0].value, property) } : {};
      const extras = { description, ...fallback, ...example };
      // utoipa drops a keyword written beside `anyOf` or `$ref`: the finished document takes the property as it is written here.
      if (this.config.document === "typespec") this.config.exactProperties.push([owner, property.name, JSON.stringify({ ...(exactBody ?? body), ...extras })]);
      return literalSchemaFn(name, JSON.stringify({ ...body, ...extras }));
    });
    return name;
  }

  /**
   * Where a Rust type holds an untyped `serde_json::Value`: the type itself, or the chain of defined types down to the one that
   * does. Undefined when all of it is typed.
   */
  untyped(ty: string, seen = new Set<string>()): string | undefined {
    if (/\bserde_json::Value\b/.test(ty)) return ty;
    for (const name of ty.match(/\b[A-Z]\w*\b/g) ?? []) {
      const parts = this.parts.get(name);
      if (parts === undefined || seen.has(name)) continue;
      seen.add(name);
      for (const part of parts) {
        const loose = this.untyped(part, seen);
        if (loose) return `${name} → ${loose}`;
      }
    }
    return undefined;
  }

  /** Who a type is, namespace included: two types of one name in different namespaces are two types. */
  private identity(t: any): string {
    if (t.kind === "String" || t.kind === "Number" || t.kind === "Boolean") return `literal:${t.kind}:${t.value}`;
    if (t.kind === "EnumMember") return `member:${this.identity(t.enum)}.${t.name}`;
    if (!t.name && (t.kind === "Model" || t.kind === "Union")) return `anonymous:${this.numberOf(t)}`;
    const args = (t.templateMapper?.args ?? []).map((a: any) => {
      if (a.entityKind === "Indeterminate") a = a.type;
      return a.entityKind === "Type" ? this.identity(a) : "?";
    });
    return `${t.namespace ? getNamespaceFullName(t.namespace) : ""}.${t.name ?? ""}${args.length ? `<${args.join(",")}>` : ""}`;
  }

  private readonly identities = new Map<string, string>();

  private readonly names = new Map<string, string>();
  private readonly types = new Map<string, Type>();

  /**
   * Defines the Rust type of a type of the contract, and returns the name it has. Two types of one name in different namespaces are one
   * Rust type when they have one shape (a model each service declares for itself); otherwise the later one is named with its
   * namespace in front (`B.Item` is `BItem`). `make` writes the type for the name it is given.
   */
  define(name: string, identity: string, type: Type | undefined, make: (name: string) => string): string {
    const known = this.names.get(identity);
    if (known !== undefined) return known;
    if (this.genericNames.has(name)) throw new Refusal(`the type ${identity} is named ${name}, which is also a template parameter of a generic type: rename one in the contract`);
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) throw new Refusal(`the type ${identity} is named ${name} in Rust: a type's name starts with a capital letter and holds only ASCII letters, digits and \`_\`: rename it in the contract`);
    if (RESERVED.has(name)) throw new Refusal(`the type ${identity} is named ${name}, which the generated code uses: rename it in the contract`);
    const prior = this.identities.get(name);
    let chosen = name;
    if (prior !== undefined) {
      const priorType = this.types.get(prior);
      if (type && priorType && sameShape(type, priorType, this.program)) {
        this.names.set(identity, name);
        return name;
      }
      if (!type) throw new Refusal(`two types would both be ${name}: ${prior} and ${identity}: rename one in the contract`);
      // The namespace the type is in, innermost name first (`Depot`), then the whole path (`ProbeDepot`), then a number.
      const parts = (type as any).namespace ? getNamespaceFullName((type as any).namespace).split(".").filter((part) => part && part !== "TypeSpec") : [];
      const taken = (candidate: string) => this.identities.has(candidate) || RESERVED.has(candidate);
      const candidates = [pascalIdent(parts.slice(-1).join("_")) + name, pascalIdent(parts.join("_")) + name];
      chosen = candidates.find((candidate) => candidate !== name && !taken(candidate)) ?? name;
      for (let n = 2; taken(chosen); n++) chosen = `${name}${n}`;
    }
    this.identities.set(chosen, identity);
    this.names.set(identity, chosen);
    if (type) this.types.set(identity, type);
    return this.alias(chosen, () => {
      // A type first reached from a field of a generic struct is an ordinary type: the parameters and the flag are the struct's own.
      const before = this.templateParams;
      if (!identity.startsWith("generic:")) this.templateParams = new Set();
      try {
        return make(chosen);
      } finally {
        this.templateParams = before;
      }
    });
  }

  /** A file of a request: what `Http.File` is on the wire, written once when an operation takes one. The contract's own `File` models are never written. */
  uploadFile(): void {
    this.alias("UploadFile", () => `/// A file sent in a form: the name and the media type its part states (neither is to be trusted: the name is the client's, never a path to write to), and its contents.
#[derive(Clone, PartialEq, Eq)]
pub struct UploadFile {
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub contents: bytes::Bytes,
}

impl std::fmt::Debug for UploadFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UploadFile")
            .field("filename", &self.filename)
            .field("content_type", &self.content_type)
            .field("contents", &format_args!("{} bytes", self.contents.len()))
            .finish()
    }
}`);
  }

  alias(name: string, make: () => string): string {
    if (!this.defs.has(name)) {
      this.defs.set(name, "");
      this.defs.set(name, make());
    }
    return name;
  }
}
