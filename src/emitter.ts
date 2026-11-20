/** Reads TypeSpec types and writes the Rust type each one is: the wire types of `types.rs`. */
import { getDoc, getSummary, getExamples, serializeValueAsJson, type Type, type Model, type ModelProperty, type Program } from "@typespec/compiler";
import { constraintValues, constraints, q, rustField, schemaDeps, schemaExpr, type Config } from "./common.js";
import {
  containerNewtype, literalSchemaFn, manualSchema, numericEnum, scalarNewtype, stringEnum, structDef, untaggedUnion,
  type EnumMember, type StructField,
} from "./templates.js";

const SCALARS: Record<string, string> = {
  string: "String", boolean: "bool", int8: "i8", int16: "i16", int32: "i32", int64: "i64", safeint: "i64",
  uint8: "u8", uint16: "u16", uint32: "u32", uint64: "u64", float32: "f32", float64: "f64", float: "f64",
  integer: "i64", numeric: "f64", decimal: "String", url: "String", bytes: "String",
  utcDateTime: "String", offsetDateTime: "String", plainDate: "String", plainTime: "String", duration: "String",
};

export function pascalIdent(s: string): string {
  const p = s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  return /^[0-9]/.test(p) ? "_" + p : p;
}

function ident(s: string): string {
  const r = s.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(r) ? "_" + r : r;
}

/** The properties of a model after those of the models it extends, base first. */
function ownAndInherited(t: Model): ModelProperty[] {
  return [...(t.baseModel ? ownAndInherited(t.baseModel) : []), ...t.properties.values()];
}

const isNull = (t: Type) => t.kind === "Intrinsic" && t.name === "null";
const isNever = (t: Type) => t.kind === "Intrinsic" && t.name === "never";

/** Writes the Rust type each TypeSpec type is, defining it (once) in `defs` when it has a name. */
export class Emitter {
  defs = new Map<string, string>();
  private readonly numbered = new Map<Model, string>();
  constructor(readonly program: Program, readonly config: Config) {}

  /** The TypeSpec doc comment as Rust `///` lines, which utoipa turns into descriptions. */
  doc(t: Type, indent = ""): string {
    const d = getDoc(this.program, t);
    return d ? d.split("\n").map((l) => `${indent}/// ${l}`.trimEnd()).join("\n") + "\n" : "";
  }

  /** `example = json!(..)` for the first `@example` (a derive takes one; TypeSpec allows several). */
  exampleList(target: any): string[] {
    const examples = getExamples(this.program, target);
    return examples.length ? [`example = json!(${JSON.stringify(serializeValueAsJson(this.program, examples[0].value, target))})`] : [];
  }

  /** `#[schema(..)]` for a property: its constraints and example. */
  schemaAttr(p: Type, extra: string[] = []): string {
    const c = [...extra, ...constraints(this.program, p), ...this.exampleList(p)];
    return c.length ? `    #[schema(${c.join(", ")})]\n` : "";
  }

  nameOf(t: Model | { name?: string; templateMapper?: any }): string {
    const base = ident(t.name || "Anon");
    const args = (t as any).templateMapper?.args ?? [];
    return base + args.map((a: any) => "Of" + this.argName(a)).join("");
  }
  argName(a: any): string {
    if (a.entityKind === "Type") {
      if (a.kind === "Intrinsic") return pascalIdent(a.name);
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
  private numberOf(t: Model): string {
    if (!this.numbered.has(t)) this.numbered.set(t, `Anon${this.numbered.size + 1}`);
    return this.numbered.get(t)!;
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
      case "Union": return this.union(t);
      case "Model": return this.model(t);
      default: return "serde_json::Value";
    }
  }

  /** A scalar with a name of its own is a newtype, so the document keeps the name (`Instant`). */
  private scalar(t: Type & { kind: "Scalar" }): string {
    if (SCALARS[t.name] && t.namespace?.name === "TypeSpec") return SCALARS[t.name];
    const name = ident(t.name);
    return this.alias(name, () => {
      const base = t.baseScalar ? this.rust(t.baseScalar) : "String";
      // A derive cannot write a constraint on a newtype's field, so a constrained scalar takes a schema written by hand.
      const stated = constraintValues(this.program, t);
      const constrained = Object.keys(stated).length > 0;
      const code = scalarNewtype({
        doc: this.doc(t),
        name,
        base,
        derives: base.startsWith("f") ? "Debug, Clone, PartialEq" : "Debug, Clone, PartialEq, Eq, Hash",
        attr: constrained ? "" : this.schemaAttr(t).trim(),
        schema: !constrained,
      });
      if (!constrained) return code;
      const description = getDoc(this.program, t);
      const sets = Object.entries({ ...stated, ...(description ? { description } : {}) }).map(([key, value]) => `schema[${q(key)}] = json!(${JSON.stringify(value)});`);
      return `${code}\n${manualSchema(name, `{ let mut schema = ${schemaExpr(base, this.config.inlined)}; ${sets.join(" ")} schema }`, [])}`;
    });
  }

  /** An enum is written by hand as a schema (each member with its title and description) and, when numeric, as a number. */
  private enumeration(t: Type & { kind: "Enum" }): string {
    const name = ident(t.name);
    return this.alias(name, () => {
      const members = [...t.members.values()];
      const numeric = members.some((m) => typeof m.value === "number");
      const wire = (m: (typeof members)[number]) => (typeof m.value === "number" || typeof m.value === "string" ? m.value : m.name);
      const data: EnumMember[] = members.map((m) => ({ doc: this.doc(m, "    "), variant: pascalIdent(m.name), wire: wire(m) }));
      const code = (numeric ? numericEnum : stringEnum)({ doc: this.doc(t), name, members: data });
      const schema = {
        description: getDoc(this.program, t),
        oneOf: members.map((m) => ({
          type: typeof wire(m) === "number" ? "integer" : "string",
          enum: [wire(m)],
          title: getSummary(this.program, m),
          description: getDoc(this.program, m),
        })),
      };
      return `${code}\n${manualSchema(name, `serde_json::json!(${JSON.stringify(schema)})`, [])}`;
    });
  }

  /** A union of two or more variants is an untagged enum with a hand-written `anyOf` (`oneOf` under `@oneOf`) schema. */
  private union(t: Type & { kind: "Union" }): string {
    const variants = [...t.variants.entries()];
    const nonNull = variants.filter(([, v]) => !isNull(v.type));
    if (nonNull.length === 1 && variants.length === 2) return `Option<${this.rust(nonNull[0][1].type)}>`;
    if (!t.name) {
      // `"a" | "b"` is a string; its values are the schema's business (`literalSchema`).
      if (nonNull.length > 0 && nonNull.every(([, v]) => v.type.kind === "String")) return variants.length > nonNull.length ? "Option<String>" : "String";
      return "serde_json::Value";
    }
    const name = ident(t.name);
    return this.alias(name, () => {
      const types = variants.map(([, v]) => this.rust(v.type));
      const oneOf = (t as any).decorators.some((d: any) => d.definition?.name === "@oneOf");
      const schemas = types.map((ty) => schemaExpr(ty, this.config.inlined));
      const body = schemas.length === 1 ? schemas[0] : `json!({${oneOf ? '"oneOf"' : '"anyOf"'}: [${schemas.join(", ")}]})`;
      const description = getDoc(this.program, t);
      const schema = description ? `{ let mut schema = ${body}; schema["description"] = json!(${q(description)}); schema }` : body;
      const code = untaggedUnion({
        doc: this.doc(t),
        name,
        variants: variants.map(([k, v], i) => ({
          name: typeof k === "string" ? pascalIdent(k) : pascalIdent(types[i].replace(/\W+/g, " ")),
          ty: types[i],
        })),
      });
      return `${code}\n${manualSchema(name, schema, types.flatMap((ty) => schemaDeps(ty, this.config.inlined)))}`;
    });
  }

  private model(t: Type & { kind: "Model" }): string {
    if (t.name === "Array" && t.indexer) return `Vec<${this.rust(t.indexer.value)}>`;
    if (t.name === "Record" && t.indexer) return `std::collections::BTreeMap<String, ${this.rust(t.indexer.value)}>`;
    if (!t.name && t.properties.size === 0 && !t.indexer) return "serde_json::Value"; // `{}`: an open object; a field says so with value_type
    // An inline model takes the name of the model it copies, and is numbered when it copies none.
    const copied = t.name ? undefined : this.copyOf(t);
    const name = t.name ? this.nameOf(t) : copied ? this.nameOf(copied) : this.numberOf(t);
    if (this.isInstance(t) || (copied && this.isInstance(copied))) this.config.inlined.add(name);
    return this.alias(name, () => {
      // `model X is Record<T>` (or `T[]`) has no properties of its own: a newtype over the map (or list).
      if (t.indexer && t.properties.size === 0 && !isNever(t.indexer.value)) {
        const inner = t.indexer.key.name === "integer"
          ? `Vec<${this.rust(t.indexer.value)}>`
          : `std::collections::BTreeMap<String, ${this.rust(t.indexer.value)}>`;
        return containerNewtype({ doc: this.doc(t), name, inner });
      }
      const fields = ownAndInherited(t).map((p) => this.field(name, p));
      return structDef({ doc: this.doc(t), name, example: this.exampleList(t).join(", "), fields });
    });
  }

  private field(owner: string, p: ModelProperty): StructField {
    const ty = this.rust(p.type);
    const optional = p.optional && !ty.startsWith("Option<") ? `Option<${ty}>` : ty;
    const open = p.type.kind === "Model" && !p.type.name && p.type.properties.size === 0 && !p.type.indexer;
    const literal = this.literalSchema(p.type, owner, p) ?? this.unsignedSchema(p) ?? this.nullSchema(p);
    // `Option<T>` is nullable in a schema; an optional field TypeSpec does not make `| null` is neither nullable nor required.
    const plainOptional = p.optional && !ty.startsWith("Option<") && !open && !literal;
    // The TypeSpec document writes an instance of a template (`Begun<X>`) out in place.
    const instance = p.type.kind === "Model" && this.isInstance(p.type);
    const extra = [
      ...(instance ? ["inline"] : []),
      ...(open ? ["value_type = Object"] : []),
      ...(literal ? [`schema_with = ${literal}`] : []),
      ...(!p.optional && optional.startsWith("Option<") ? ["required = true"] : []),
      ...(plainOptional ? [`value_type = ${ty}`, "required = false"] : []),
      ...(p.defaultValue ? [`default = json!(${JSON.stringify(serializeValueAsJson(this.program, p.defaultValue, p.type))})`] : []),
    ];
    return { doc: this.doc(p, "    "), attr: this.schemaAttr(p, extra), serde: p.name, ident: rustField(p.name), ty: optional, optional: p.optional };
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
    const variants = t.kind === "Union" && !t.name ? [...t.variants.values()].map((v) => v.type) : [t];
    const schemas = variants.map(one);
    if (schemas.some((s) => s === undefined) || variants.every(isNull)) return undefined;
    return this.schemaFn(owner, property, schemas.length === 1 ? schemas[0]! : { anyOf: schemas });
  }

  /**
   * A property typed `uint32` (or another unsigned width) is `format: uint32` in the TypeSpec document, which a derive cannot write:
   * it writes `int32` with `minimum: 0`. Returns the name of the function that gives the field its schema, or undefined.
   */
  private unsignedSchema(property: ModelProperty): string | undefined {
    const t = property.type;
    if (t.kind !== "Scalar" || t.namespace?.name !== "TypeSpec" || !/^uint(8|16|32|64)$/.test(t.name)) return undefined;
    if (constraints(this.program, property).length) return undefined; // a stated bound is the derive's to write
    return this.schemaFn(property.model?.name || "model", property, { type: "integer", format: t.name });
  }

  /** A property typed `null` (a `()`) is `type: null` in the TypeSpec document; a derive writes `default: null`. */
  private nullSchema(property: ModelProperty): string | undefined {
    return isNull(property.type) ? this.schemaFn(property.model?.name || "model", property, { type: "null" }) : undefined;
  }

  /** The function that gives a field the schema `body`, with the field's own doc as its description. Returns its name. */
  private schemaFn(owner: string, property: ModelProperty, body: object): string {
    const name = `schema_${owner}_${ident(property.name)}`.toLowerCase();
    this.alias(`fn ${name}`, () => {
      // With `schema_with` the derive no longer adds the field's doc as its description.
      const description = getDoc(this.program, property);
      return literalSchemaFn(name, JSON.stringify({ ...body, description }));
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
      const def = this.defs.get(name);
      if (def === undefined || seen.has(name)) continue;
      seen.add(name);
      const loose = /\bserde_json::Value\b/.test(def) ? name : this.untyped(def, seen);
      if (loose) return loose === name ? name : `${name} → ${loose}`;
    }
    return undefined;
  }

  alias(name: string, make: () => string): string {
    if (!this.defs.has(name)) {
      this.defs.set(name, "");
      this.defs.set(name, make());
    }
    return name;
  }
}
