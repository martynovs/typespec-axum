/**
 * The Rust of `types.rs`, as templates: each function takes data the writer already worked out and returns a fragment with its line breaks
 * where they belong. No decision about the contract is made here; `rustfmt` lays out whatever is written.
 */
import type { Const } from "../contract.js";
import { lastSegment, q, rustStr } from "../rust.js";

const lines = (items: string[]) => items.join("\n");

// ---------------------------------------------------------------------------------------------------------------------
// Wire types (types.rs)
// ---------------------------------------------------------------------------------------------------------------------

export const typesHeader = `
#![allow(unused_imports, dead_code, non_camel_case_types, non_snake_case, clippy::all, clippy::pedantic)]
use serde::{Deserialize, Serialize};
use serde_json::json;

/// A string the contract limits to some values (a literal such as \`"cat"\`), so a variant of an untagged union cannot take another's.
fn one_of<'de, D: serde::Deserializer<'de>>(deserializer: D, allowed: &[&str]) -> Result<String, D::Error> {
    let text = String::deserialize(deserializer)?;
    if allowed.contains(&text.as_str()) {
        Ok(text)
    } else {
        Err(serde::de::Error::custom(format!("{text:?} is not one of {allowed:?}")))
    }
}

fn one_of_option<'de, D: serde::Deserializer<'de>>(deserializer: D, allowed: &[&str]) -> Result<Option<String>, D::Error> {
    match Option::<String>::deserialize(deserializer)? {
        Some(text) if !allowed.contains(&text.as_str()) => Err(serde::de::Error::custom(format!("{text:?} is not one of {allowed:?}"))),
        other => Ok(other),
    }
}

fn double_one_of<'de, D: serde::Deserializer<'de>>(deserializer: D, allowed: &[&str]) -> Result<Option<Option<String>>, D::Error> {
    one_of_option(deserializer, allowed).map(Some)
}

/// A field that is required and may be \`null\`: it has to be there (serde would read a missing one as \`None\`).
fn required_option<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}

/// A field that may be left out and may be \`null\`: left out is \`None\`, \`null\` is \`Some(None)\`.
fn double_option<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}
`;

/** A dependency of a manual schema is a type, or `Type#Name` for a type that says the schema of the component `Name` (`schema: contract`). */
const depType = (d: string) => d.split("#")[0];
const depName = (d: string) => (d.includes("#") ? d.split("#")[1] : lastSegment(d));

/** `impl PartialSchema`/`ToSchema` for a type whose schema a derive cannot write; `schemaName` renames its component. */
export const manualSchema = (name: string, schema: string, deps: string[], schemaName?: string) => `
impl utoipa::PartialSchema for ${name} {
    fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
        serde_json::from_value(${schema}).expect("the ${name} schema is valid")
    }
}

impl utoipa::ToSchema for ${name} {
${schemaName ? `    fn name() -> std::borrow::Cow<'static, str> { std::borrow::Cow::Borrowed(${q(schemaName)}) }` : ""}
${deps.length ? `    fn schemas(schemas: &mut Vec<(String, utoipa::openapi::RefOr<utoipa::openapi::schema::Schema>)>) {
${lines([...new Set(deps)].map((d) => d.startsWith("~") ? `        <${d.slice(1)} as utoipa::ToSchema>::schemas(schemas);` : `        // Registered before it is followed, and once: a type that refers back to this one would otherwise be followed for ever.
        if !schemas.iter().any(|(name, _)| name == ${q(depName(d))}) {
            schemas.push((${q(depName(d))}.to_owned(), <${depType(d)} as utoipa::PartialSchema>::schema()));
            <${depType(d)} as utoipa::ToSchema>::schemas(schemas);
        }`))}
    }` : ""}
}`;

export interface StructField {
  doc: string; attr: string; serde: string; ident: string; ty: string; optional: boolean; consts: Const[];
  /** The function that reads the field, when the field is not read as its type is. */
  deserialize?: string;
}

/** Where a type derives `Eq` if `derive-eq` is on and every part of it is: told apart from the other derives once all the types are known (`TypeWriter.resolveEq`). */
export const eqMarker = (name: string) => `⟦eq:${name}⟧`;

/** Where a type derives `PartialEq`: not when a part of it is a type the application writes that is not (`partial-eq: false`); told apart with `eqMarker`. */
export const peqMarker = (name: string) => `⟦peq:${name}⟧`;

/** The associated constants of a type, or nothing when it has none. */
export const constantsImpl = (name: string, consts: Const[], generics: string[] = []) =>
  consts.length ? `\nimpl${generics.length ? `<${generics.join(", ")}>` : ""} ${name}${generics.length ? `<${generics.join(", ")}>` : ""} {\n${lines(consts.map((c) => `    pub const ${c.name}: ${c.ty} = ${c.value};`))}\n}\n` : "";

/** An optional field (`name?: T`) is absent when it has no value, never `null`. */
const structField = (f: StructField) => `${f.doc}${f.attr}    #[serde(rename = ${q(f.serde)}${f.optional ? ", default" : ""}${f.deserialize ? `, deserialize_with = ${q(f.deserialize)}` : ""}${f.optional ? ', skip_serializing_if = "Option::is_none"' : ""})]
    pub ${f.ident}: ${f.ty},`;

export const structDef = (s: { doc: string; name: string; generics?: string[]; example?: string; closed: boolean; schema: boolean; fields: StructField[]; consts: Const[] }) => `${s.doc}#[derive(Debug, Clone${peqMarker(s.name)}${eqMarker(s.name)}, Serialize, Deserialize${s.schema ? ", utoipa::ToSchema" : ""})]
${s.closed ? "#[serde(deny_unknown_fields)]\n" : ""}${s.generics?.length ? `#[serde(bound(serialize = ${q(s.generics.map((g) => `${g}: Serialize`).join(", "))}, deserialize = ${q(s.generics.map((g) => `${g}: Deserialize<'de>`).join(", "))}))]\n` : ""}${s.schema && s.example ? `#[schema(${s.example})]\n` : ""}pub struct ${s.name}${s.generics?.length ? `<${s.generics.join(", ")}>` : ""} {
${lines(s.fields.map(structField))}
}
${constantsImpl(s.name, [...s.consts, ...s.fields.flatMap((f) => f.consts)], s.generics)}`;

/** `model X is Record<T>` or `T[]`: a newtype over the map or the list. */
export const containerNewtype = (c: { doc: string; name: string; inner: string; schema: boolean }) => `${c.doc}#[derive(Debug, Clone${peqMarker(c.name)}${eqMarker(c.name)}, Serialize, Deserialize${c.schema ? ", utoipa::ToSchema" : ""})]
#[serde(transparent)]
pub struct ${c.name}(pub ${c.inner});`;

/** A scalar with a name of its own, so the document keeps the name. `attr` is its inline `#[schema(..)]`, or empty. */
export const scalarNewtype = (s: { doc: string; name: string; derives: string; attr: string; base: string; schema: boolean }) => `${s.doc}#[derive(${s.derives}, Serialize, Deserialize${s.schema ? ", utoipa::ToSchema" : ""})]
#[serde(transparent)]
pub struct ${s.name}(${s.attr ? s.attr + " " : ""}pub ${s.base});

impl std::fmt::Display for ${s.name} {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.0, f)
    }
}`;

export interface EnumMember { doc: string; variant: string; wire: string | number }

export const stringEnum = (e: { doc: string; name: string; members: EnumMember[]; schema: boolean }) => `${e.doc}#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize${e.schema ? ", utoipa::ToSchema" : ""})]
pub enum ${e.name} {
${lines(e.members.map((m) => `${m.doc}    #[serde(rename = ${q(String(m.wire))})]
    ${m.variant},`))}
}`;

export const numericEnum = (e: { doc: string; name: string; members: EnumMember[]; schema: boolean }) => `${e.doc}#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i64)]
pub enum ${e.name} {
${lines(e.members.map((m) => `${m.doc}    ${m.variant} = ${m.wire},`))}
}

impl ${e.name} {
    /// The number this is on the wire.
    pub const fn wire(self) -> i64 {
        self as i64
    }
}

impl Serialize for ${e.name} {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i64(self.wire())
    }
}

impl<'de> Deserialize<'de> for ${e.name} {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match i64::deserialize(deserializer)? {
${lines(e.members.map((m) => `            ${m.wire} => Ok(Self::${m.variant}),`))}
            other => Err(serde::de::Error::custom(format!("{other} is not a ${e.name}"))),
        }
    }
}`;

export const untaggedUnion = (u: { doc: string; name: string; variants: { name: string; ty: string }[] }) => `${u.doc}#[derive(Debug, Clone${peqMarker(u.name)}${eqMarker(u.name)}, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ${u.name} {
${lines(u.variants.map((v) => (v.ty === "()" ? `    ${v.name},` : `    ${v.name}(${v.ty}),`)))}
}`;

/** The schema of a field typed with literal values, which a derive cannot write (`schema_with`). */
export const literalSchemaFn = (name: string, schema: string) => `fn ${name}() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
    serde_json::from_str(${rustStr(schema)}).expect("the literal schema is valid")
}`;

/**
 * The schema of a field that holds a type of a `PartialSchema` and no `ToSchema`, from an expression of `schemaExpr` (`schema_with`, with which
 * the derive no longer adds the field's doc, so it is said here).
 */
export const partialSchemaFn = (name: string, schema: string, description?: string) => `fn ${name}() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
    let ${description ? "mut " : ""}schema: serde_json::Value = ${schema};
${description ? `    if let Some(object) = schema.as_object_mut() {
        object.insert("description".to_owned(), json!(${rustStr(description)}));
    }
` : ""}    serde_json::from_value(schema).expect("the schema is valid")
}`;
