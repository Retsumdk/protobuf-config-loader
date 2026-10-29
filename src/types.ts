export type ScalarType =
  | "double" | "float"
  | "int32" | "int64" | "uint32" | "uint64"
  | "sint32" | "sint64" | "fixed32" | "fixed64" | "sfixed32" | "sfixed64"
  | "bool" | "string" | "bytes";

export const SCALAR_TYPES: readonly ScalarType[] = [
  "double", "float",
  "int32", "int64", "uint32", "uint64",
  "sint32", "sint64", "fixed32", "fixed64", "sfixed32", "sfixed64",
  "bool", "string", "bytes",
];

export function isScalarType(name: string): name is ScalarType {
  return (SCALAR_TYPES as readonly string[]).includes(name);
}

export type MapKeyType = Extract<
  ScalarType,
  "int32" | "int64" | "uint32" | "uint64" | "sint32" | "sint64" | "fixed32" | "fixed64" | "sfixed32" | "sfixed64" | "bool" | "string"
>;

export const MAP_KEY_TYPES: readonly MapKeyType[] = [
  "int32", "int64", "uint32", "uint64",
  "sint32", "sint64", "fixed32", "fixed64", "sfixed32", "sfixed64",
  "bool", "string",
];

export function isMapKeyType(name: string): name is MapKeyType {
  return (MAP_KEY_TYPES as readonly string[]).includes(name);
}

export type Cardinality = "plain" | "optional" | "required" | "repeated";

export type Literal =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "identifier"; value: string };

export interface FieldDef {
  name: string;
  number: number;
  type: string;
  cardinality: Cardinality;
  mapKey?: MapKeyType;
  mapValue?: string;
  defaultValue?: Literal;
  deprecated?: boolean;
}

export interface OneofDef {
  name: string;
  fields: FieldDef[];
}

export interface MessageDef {
  name: string;
  fullName: string;
  fields: FieldDef[];
  oneofs: OneofDef[];
}

export interface EnumValueDef {
  name: string;
  number: number;
  deprecated?: boolean;
}

export interface EnumDef {
  name: string;
  fullName: string;
  values: EnumValueDef[];
  allowAlias: boolean;
}

export interface Schema {
  syntax: string;
  package?: string;
  fileName: string;
  messages: MessageDef[];
  enums: EnumDef[];
  root: string;
  reservedNames: Map<string, Set<string>>;
  reservedNumbers: Map<string, Set<number>>;
}

export type IssueCode =
  | "TYPE_MISMATCH"
  | "RANGE"
  | "MISSING_REQUIRED"
  | "UNKNOWN_FIELD"
  | "RESERVED_FIELD"
  | "ONEOF_VIOLATION"
  | "ENUM_VALUE"
  | "BASE64"
  | "MAP_KEY"
  | "PARSE"
  | "IO";

export interface Issue {
  path: string;
  code: IssueCode;
  message: string;
  source?: string;
}

export type ConfigValue = unknown;

export type UnknownFieldsPolicy = "error" | "ignore";

export interface SourceInput {
  name: string;
  data: ConfigValue;
  /** Pre-decode issues from building this source (e.g. malformed env values). */
  issues?: Issue[];
}

export interface LoadOptions {
  schema: Schema;
  root?: string;
  sources: SourceInput[];
  unknownFields?: UnknownFieldsPolicy;
}

export type LoadResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: Issue[] };
