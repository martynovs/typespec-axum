/** What TypeSpec states of a type (its limits, pattern, doc, examples) as schema attributes and as constants. */
import { getDoc, getExamples, getSummary, getMaxLength, getMaxValue, getMinLength, getMinValue, getPattern, serializeValueAsJson, type Program, type Type } from "@typespec/compiler";
import type { Const } from "./contract.js";
import { rustStr } from "./rust.js";
import { q, rustNumber } from "./rust.js";

/** The `minimum`, `maximum`, `minLength`, `maxLength` and `pattern` TypeSpec states on a type, under their JSON Schema names. */
export function constraintValues(program: Program, p: Type): Record<string, number | string> {
  const values: Record<string, number | string | undefined> = {
    minimum: getMinValue(program, p),
    maximum: getMaxValue(program, p),
    minLength: getMinLength(program, p),
    maxLength: getMaxLength(program, p),
    pattern: getPattern(program, p),
  };
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Record<string, number | string>;
}

/** The same constraints as `#[schema(..)]` and parameter attributes. */
export function constraints(program: Program, p: Type): string[] {
  const attribute: Record<string, string> = { minimum: "minimum", maximum: "maximum", minLength: "min_length", maxLength: "max_length", pattern: "pattern" };
  // A length is a `usize`, which a suffix would make something else.
  const number = (name: string, value: number) => (name.endsWith("Length") ? String(value) : rustNumber(value));
  return Object.entries(constraintValues(program, p)).map(([name, value]) => `${attribute[name]} = ${typeof value === "string" ? q(value) : number(name, value)}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Constants: what the contract states of a type, a field or a parameter, as values Rust can read
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The constants for one target: its constraints (`MINIMUM`, `MAXIMUM`, `MIN_LENGTH`, `MAX_LENGTH`, `PATTERN`), its `@summary`
 * (`SUMMARY`), its doc (`DESCRIPTION`) and its first `@example` (`EXAMPLE`, as JSON text), each named `prefix` + that. `ty` is the Rust type of the value the target
 * describes, which a bound takes the type of.
 */
export function facts(program: Program, target: Type, ty: string, prefix = ""): Const[] {
  const out: Const[] = [];
  const stated = constraintValues(program, target);
  const inner = ty.replace(/^(?:Option|Vec)<(.*)>$/, "$1").replace(/^(?:Option|Vec)<(.*)>$/, "$1");
  for (const [rule, name] of [["minimum", "MINIMUM"], ["maximum", "MAXIMUM"]] as const) {
    const value = stated[rule];
    if (typeof value !== "number") continue;
    const numeric = /^[iuf]\d+$/.test(inner) && (Number.isInteger(value) || inner.startsWith("f")) ? inner : Number.isInteger(value) ? "i64" : "f64";
    out.push({ name: prefix + name, ty: numeric, value: numeric.startsWith("f") ? `${value}_${numeric}` : String(value) });
  }
  for (const [rule, name] of [["minLength", "MIN_LENGTH"], ["maxLength", "MAX_LENGTH"]] as const) {
    if (typeof stated[rule] === "number") out.push({ name: prefix + name, ty: "usize", value: String(stated[rule]) });
  }
  if (typeof stated.pattern === "string") out.push({ name: prefix + "PATTERN", ty: "&'static str", value: rustStr(stated.pattern) });
  const summary = getSummary(program, target);
  if (summary) out.push({ name: prefix + "SUMMARY", ty: "&'static str", value: rustStr(summary) });
  const doc = getDoc(program, target);
  if (doc) out.push({ name: prefix + "DESCRIPTION", ty: "&'static str", value: rustStr(doc) });
  const examples = getExamples(program, target as any);
  if (examples.length) {
    out.push({ name: prefix + "EXAMPLE", ty: "&'static str", value: rustStr(JSON.stringify(serializeValueAsJson(program, examples[0].value, target as any))) });
  }
  return out;
}
