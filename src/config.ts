/** What the writers are asked for, and the error they refuse a contract with. */

/** What the emitter was asked for (`EmitterOptions`), and what it learned of the contract while writing types. */
export interface Config {
  /** The generated files' name for themselves, in their first line. */
  generator: string;
  /** Rust path of the module that holds `types.rs`. */
  typesPath: string;
  /** Rust path of the type a handler refuses with, or undefined for the one `axum.rs` defines. */
  refusalType?: string;
  /** Rust path of the function that makes the refusal of a request that cannot be read (`fn(StatusCode, &'static str) -> Refused`), or undefined for a text answer. */
  rejectWith?: string;
  /** Whether a type derives `Eq` when every part of it is `Eq`. */
  deriveEq: boolean;
  /** Whether `client.rs` is written: a client of the contract over a transport. */
  client: boolean;
  /** Whether \`axum.rs\` is written: the endpoints of the contract. */
  server: boolean;
  /** Whether `client.rs` also holds a transport over `reqwest`. */
  clientReqwest: boolean;
  /** The most of a response body the client reads, and of a line of an event stream. */
  clientMaxBodyBytes: number;
  /** Rust path of the module that holds `client.rs`, which `irpc.rs` uses. */
  clientPath: string;
  /** Whether `irpc.rs` is written: the contract as an irpc protocol. */
  irpc: boolean;
  maxQueryBytes: number;
  maxQueryPairs: number;
  /** How deep the JSON of a request body may nest. */
  maxJsonDepth: number;
  /** Whether a response may carry an untyped `serde_json::Value`. */
  allowUntyped: boolean;
  /** `typespec`: schemas written by hand to match `@typespec/openapi3` to the letter; `derived`: whatever utoipa's derive writes; `none`: no document, so no utoipa. */
  document: "typespec" | "derived" | "none";
  /** How an enum is written in a `typespec` document: `default`, one `enum`; `annotated`, a `oneOf` of `const` members with their titles and docs (as `@typespec/openapi3`'s option of the name). */
  enumStrategy: "default" | "annotated";
  /** Whether a JSON body is read only from a request that says it is JSON. */
  requireJson: boolean;
  /** Types the contract names that the application writes itself: the contract's name (`Name` or `Namespace.Name`) to the Rust path of the type. */
  typeMap: ReadonlyMap<string, TypeMapEntry>;
  /** What a contract's extension becomes in the Rust: a call of the application's macro, evaluated in a const, per operation. */
  extensionExpr: ReadonlyMap<string, ExtensionExpr>;
  /** Rust names of the types TypeSpec writes out in place wherever they are used (instances of a template). */
  inlined: Set<string>;
  /** The components whose schema utoipa cannot hold (a `const`): the JSON of each is put into the finished document as it is. */
  exact: Map<string, string>;
  /** The properties whose schema utoipa cannot hold (a keyword beside `anyOf` or `$ref`): `[component, property, json]`, put into the finished document as they are. */
  exactProperties: [string, string, string][];
}

/** How an `x-*` extension of an operation is lowered: `const <const>: <type> = <macro>!(<the extension's JSON>);` in the operation's module. */
export interface ExtensionExpr {
  /** The extension's name (`x-scope`). */
  name: string;
  macro: string;
  type: string;
  const: string;
  /** The method of `Operation` that returns the constant. */
  accessor: string;
  /** Whether every operation must state the extension (the accessor then returns the value, not an `Option`). */
  required: boolean;
}

/** A type written by hand: where it is, whether it is `Eq` (which the emitter cannot see), and `inline`: the path names no schema of the document, so its schema is written in place from its own `PartialSchema`; otherwise it is a component and implements `ToSchema`. */
export interface TypeMapEntry { path: string; eq: boolean; inline: boolean; contract: boolean; partialEq: boolean; scalar: boolean }

/** A contract the emitter cannot write faithfully: reported to the user as an error of the contract, not as a fault of the emitter. */
export class Refusal extends Error {}
