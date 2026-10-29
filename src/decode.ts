import { isCanonicalBase64 } from "./parser.js";
import { sortIssues } from "./report.js";
import {
  isMapKeyType,
  isScalarType,
  type FieldDef,
  type Issue,
  type LoadOptions,
  type LoadResult,
  type MessageDef,
  type ScalarType,
  type Schema,
  type UnknownFieldsPolicy,
} from "./types.js";

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const UINT32_MAX = 4294967295;
const SAFE_MAX = Number.MAX_SAFE_INTEGER;

const SIGNED_32: readonly string[] = ["int32", "sint32", "sfixed32"];
const UNSIGNED_32: readonly string[] = ["uint32", "fixed32"];
const SIGNED_64: readonly string[] = ["int64", "sint64", "sfixed64"];
const UNSIGNED_64: readonly string[] = ["uint64", "fixed64"];
const FLOATING: readonly string[] = ["double", "float"];

interface TypeRegistry {
  messageByName: Map<string, MessageDef>;
  enumByName: Map<string, { fullName: string; values: { name: string; number: number }[] }>;
}

function buildRegistry(schema: Schema): TypeRegistry {
  const messageByName = new Map<string, MessageDef>();
  for (const m of schema.messages) {
    messageByName.set(m.fullName, m);
    messageByName.set(m.name, m);
  }
  const enumByName = new Map<string, { fullName: string; values: { name: string; number: number }[] }>();
  for (const e of schema.enums) {
    const entry = { fullName: e.fullName, values: e.values.map((v) => ({ name: v.name, number: v.number })) };
    enumByName.set(e.fullName, entry);
    enumByName.set(e.name, entry);
  }
  return { messageByName, enumByName };
}

export function base64ToBytes(value: string): Uint8Array | undefined {
  if (!isCanonicalBase64(value)) return undefined;
  try {
    const decoded = atob(value);
    const out = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function rangeFor(scalar: ScalarType): { min: number; max: number } {
  if (SIGNED_32.includes(scalar)) return { min: INT32_MIN, max: INT32_MAX };
  if (UNSIGNED_32.includes(scalar)) return { min: 0, max: UINT32_MAX };
  if (SIGNED_64.includes(scalar)) return { min: -(2 ** 53) + 1, max: SAFE_MAX };
  if (UNSIGNED_64.includes(scalar)) return { min: 0, max: SAFE_MAX };
  return { min: -Infinity, max: Infinity };
}

function scalarTypeName(scalar: ScalarType): string {
  if (FLOATING.includes(scalar)) return "number";
  if (scalar === "bool") return "boolean";
  if (scalar === "string") return "string";
  if (scalar === "bytes") return "base64 string";
  return "integer";
}

function jsonTypeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return Number.isInteger(value as number) ? "integer" : "number";
  if (t === "object") return "object";
  return t;
}

class Decoder {
  private readonly registry: TypeRegistry;
  private readonly unknown: UnknownFieldsPolicy;
  private readonly issues: Issue[] = [];

  constructor(
    private readonly schema: Schema,
    unknown: UnknownFieldsPolicy,
  ) {
    this.registry = buildRegistry(schema);
    this.unknown = unknown;
  }

  private resolveFieldTarget(field: FieldDef): { kind: "scalar"; scalar: ScalarType } | { kind: "message"; def: MessageDef } | { kind: "enum"; def: { fullName: string; values: { name: string; number: number }[] } } | undefined {
    if (field.type === "map") return undefined;
    if (isScalarType(field.type)) return { kind: "scalar", scalar: field.type };
    const msg = this.registry.messageByName.get(field.type);
    if (msg) return { kind: "message", def: msg };
    const en = this.registry.enumByName.get(field.type);
    if (en) return { kind: "enum", def: en };
    return undefined;
  }

  private resolveMapValueTarget(field: FieldDef): { kind: "scalar"; scalar: ScalarType } | { kind: "message"; def: MessageDef } | { kind: "enum"; def: { fullName: string; values: { name: string; number: number }[] } } | undefined {
    const vt = field.mapValue ?? "";
    if (isScalarType(vt)) return { kind: "scalar", scalar: vt };
    const msg = this.registry.messageByName.get(vt);
    if (msg) return { kind: "message", def: msg };
    const en = this.registry.enumByName.get(vt);
    if (en) return { kind: "enum", def: en };
    return undefined;
  }

  private addIssue(path: string, code: Issue["code"], message: string, source?: string): void {
    const issue: Issue = { path, code, message };
    if (source !== undefined) issue.source = source;
    this.issues.push(issue);
  }

  decodeRoot(rootName: string, sources: LoadOptions["sources"]): Record<string, unknown> | undefined {
    const root = this.registry.messageByName.get(rootName);
    if (!root) {
      this.addIssue(rootName, "UNKNOWN_FIELD", `root message '${rootName}' is not defined in the schema`);
      return undefined;
    }
    for (const source of sources) {
      for (const issue of source.issues ?? []) {
        this.addIssue(issue.path, issue.code, issue.message, source.name);
      }
    }
    if (this.issues.length > 0) return undefined;
    let merged: Record<string, unknown> = {};
    for (const source of sources) {
      const data = source.data;
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        this.addIssue("$", "TYPE_MISMATCH", `source '${source.name}' must be a JSON object, got ${jsonTypeName(data)}`, source.name);
        continue;
      }
      const fragment = this.decodeMessage(root, data as Record<string, unknown>, "$", source.name);
      if (fragment) merged = mergeInto(merged, fragment);
    }
    const present = this.applyPresenceAndDefaults(root, merged, "$");
    if (this.issues.length > 0) return undefined;
    return present;
  }

  private decodeMessage(def: MessageDef, input: Record<string, unknown>, path: string, source: string): Record<string, unknown> | undefined {
    const fieldByName = new Map<string, FieldDef>();
    for (const f of def.fields) fieldByName.set(f.name, f);
    for (const o of def.oneofs) for (const f of o.fields) fieldByName.set(f.name, f);
    const reserved = this.schema.reservedNames.get(def.fullName) ?? new Set<string>();

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const field = fieldByName.get(key);
      if (!field) {
        if (reserved.has(key)) {
          this.addIssue(joinPath(path, key), "RESERVED_FIELD", `field '${key}' is reserved in message '${def.fullName}'`, source);
        } else if (this.unknown === "error") {
          this.addIssue(joinPath(path, key), "UNKNOWN_FIELD", `unknown field '${key}' in message '${def.fullName}'`, source);
        }
        continue;
      }
      const decoded = this.decodeField(field, value, joinPath(path, key), source);
      if (decoded !== undefined) out[key] = decoded;
    }
    return out;
  }

  private decodeField(field: FieldDef, value: unknown, path: string, source: string): unknown {
    if (field.type === "map") return this.decodeMap(field, value, path, source);
    const target = this.resolveFieldTarget(field);
    if (!target) {
      this.addIssue(path, "TYPE_MISMATCH", `field '${field.name}' has unresolved type '${field.type}'`, source);
      return undefined;
    }
    if (field.cardinality === "repeated") {
      if (!Array.isArray(value)) {
        this.addIssue(path, "TYPE_MISMATCH", `expected array for repeated field, got ${jsonTypeName(value)}`, source);
        return undefined;
      }
      const items: unknown[] = [];
      value.forEach((item, i) => {
        const decoded = this.decodeSingle(target, item, `${path}[${i}]`, source);
        if (decoded !== undefined) items.push(decoded);
      });
      return items;
    }
    return this.decodeSingle(target, value, path, source);
  }

  private decodeMap(field: FieldDef, value: unknown, path: string, source: string): Record<string, unknown> | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.addIssue(path, "TYPE_MISMATCH", `expected object for map field, got ${jsonTypeName(value)}`, source);
      return undefined;
    }
    const keyType = field.mapKey ?? "string";
    const target = this.resolveMapValueTarget(field);
    if (!target) {
      this.addIssue(path, "TYPE_MISMATCH", `map value type '${field.mapValue ?? ""}' is unresolved`, source);
      return undefined;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const keyPath = `${path}[${JSON.stringify(key)}]`;
      const normalizedKey = this.decodeMapKey(keyType, key, keyPath, source);
      if (normalizedKey === undefined) continue;
      const decoded = this.decodeSingle(target, item, keyPath, source);
      if (decoded !== undefined) out[normalizedKey] = decoded;
    }
    return out;
  }

  private decodeMapKey(keyType: string, key: string, path: string, source: string): string | undefined {
    if (keyType === "string") return key;
    if (keyType === "bool") {
      if (key === "true" || key === "false") return key;
      this.addIssue(path, "MAP_KEY", `map key must be "true" or "false" for ${keyType} keys`, source);
      return undefined;
    }
    const text = key.trim();
    if (!/^[+-]?\d+$/.test(text)) {
      this.addIssue(path, "MAP_KEY", `map key '${key}' must be an integer string for ${keyType} keys`, source);
      return undefined;
    }
    const num = Number(text);
    const { min, max } = rangeFor(keyType as ScalarType);
    if (!Number.isInteger(num) || num < min || num > max) {
      this.addIssue(path, "RANGE", `map key '${key}' out of range for ${keyType}`, source);
      return undefined;
    }
    return String(num);
  }

  private decodeSingle(target: { kind: "scalar"; scalar: ScalarType } | { kind: "message"; def: MessageDef } | { kind: "enum"; def: { fullName: string; values: { name: string; number: number }[] } }, value: unknown, path: string, source: string): unknown {
    switch (target.kind) {
      case "message": {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          this.addIssue(path, "TYPE_MISMATCH", `expected object for message '${target.def.fullName}', got ${jsonTypeName(value)}`, source);
          return undefined;
        }
        return this.decodeMessage(target.def, value as Record<string, unknown>, path, source);
      }
      case "enum": {
        if (typeof value === "string") {
          const found = target.def.values.find((v) => v.name === value);
          if (!found) {
            const names = target.def.values.map((v) => v.name).join(", ");
            this.addIssue(path, "ENUM_VALUE", `'${value}' is not a value of enum '${target.def.fullName}' (expected one of: ${names})`, source);
            return undefined;
          }
          return value;
        }
        if (typeof value === "number" && Number.isInteger(value)) {
          const found = target.def.values.find((v) => v.number === value);
          if (!found) {
            const nums = [...new Set(target.def.values.map((v) => v.number))].join(", ");
            this.addIssue(path, "ENUM_VALUE", `${value} is not a defined number of enum '${target.def.fullName}' (defined: ${nums})`, source);
            return undefined;
          }
          return found.name;
        }
        this.addIssue(path, "TYPE_MISMATCH", `expected enum name or number, got ${jsonTypeName(value)}`, source);
        return undefined;
      }
      case "scalar":
        return this.decodeScalar(target.scalar, value, path, source);
    }
  }

  private decodeScalar(scalar: ScalarType, value: unknown, path: string, source: string): unknown {
    switch (scalar) {
      case "double":
      case "float": {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          this.addIssue(path, "TYPE_MISMATCH", `expected finite number, got ${jsonTypeName(value)}`, source);
          return undefined;
        }
        return value;
      }
      case "bool": {
        if (typeof value !== "boolean") {
          this.addIssue(path, "TYPE_MISMATCH", `expected boolean, got ${jsonTypeName(value)}`, source);
          return undefined;
        }
        return value;
      }
      case "string": {
        if (typeof value !== "string") {
          this.addIssue(path, "TYPE_MISMATCH", `expected string, got ${jsonTypeName(value)}`, source);
          return undefined;
        }
        return value;
      }
      case "bytes": {
        if (typeof value !== "string") {
          this.addIssue(path, "TYPE_MISMATCH", `expected base64 string for bytes, got ${jsonTypeName(value)}`, source);
          return undefined;
        }
        const decoded = base64ToBytes(value);
        if (!decoded) {
          this.addIssue(path, "BASE64", `invalid base64 value for bytes field`, source);
          return undefined;
        }
        return bytesToBase64(decoded);
      }
      default: {
        if (typeof value !== "number" || !Number.isInteger(value)) {
          this.addIssue(path, "TYPE_MISMATCH", `expected ${scalarTypeName(scalar)}, got ${jsonTypeName(value)}`, source);
          return undefined;
        }
        const { min, max } = rangeFor(scalar);
        if (value < min || value > max) {
          this.addIssue(path, "RANGE", `value ${value} out of range for ${scalar} (${min}..${max})`, source);
          return undefined;
        }
        return value;
      }
    }
  }

  private applyPresenceAndDefaults(def: MessageDef, merged: Record<string, unknown>, path: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const oneofFieldByName = new Map<string, string>();
    for (const o of def.oneofs) for (const f of o.fields) oneofFieldByName.set(f.name, o.name);

    const presentOneofs = new Map<string, number>();
    for (const [name, value] of Object.entries(merged)) {
      const oneofName = oneofFieldByName.get(name);
      if (oneofName) presentOneofs.set(oneofName, (presentOneofs.get(oneofName) ?? 0) + (value !== undefined ? 1 : 0));
    }
    for (const oneof of def.oneofs) {
      const count = presentOneofs.get(oneof.name) ?? 0;
      if (count > 1) {
        const members = oneof.fields.map((f) => f.name).join("/");
        this.addIssue(joinPath(path, oneof.name), "ONEOF_VIOLATION", `oneof '${oneof.name}' has ${count} fields set, at most one is allowed (${members})`);
      }
    }

    const seenNames = new Set<string>();
    const allFields: FieldDef[] = [];
    for (const f of def.fields) allFields.push(f);
    for (const o of def.oneofs) for (const f of o.fields) allFields.push(f);
    const sorted = allFields
      .filter((f) => (seenNames.has(f.name) ? false : (seenNames.add(f.name), true)))
      .sort((a, b) => a.number - b.number);
    for (const field of sorted) {
      const fieldPath = joinPath(path, field.name);
      const present = merged[field.name] !== undefined;
      if (!present) {
        if (oneofFieldByName.has(field.name)) continue;
        if (field.cardinality === "required") {
          if (field.defaultValue) {
            out[field.name] = literalToValue(field, field.defaultValue, this.registry);
          } else {
            this.addIssue(fieldPath, "MISSING_REQUIRED", `required field '${field.name}' is not set`);
          }
          continue;
        }
        if (field.cardinality === "repeated") {
          out[field.name] = field.type === "map" ? {} : [];
          continue;
        }
        if (field.type === "map") {
          out[field.name] = {};
          continue;
        }
        const target = this.resolveFieldTarget(field);
        if (target === undefined || target.kind === "message") continue;
        if (field.cardinality === "plain") {
          out[field.name] = field.defaultValue
            ? literalToValue(field, field.defaultValue, this.registry)
            : zeroValue(target);
          continue;
        }
        if (field.defaultValue) {
          out[field.name] = literalToValue(field, field.defaultValue, this.registry);
        }
        continue;
      }
      const value = merged[field.name];
      if (field.type === "map") {
        out[field.name] = value;
        continue;
      }
      const target = this.resolveFieldTarget(field);
      if (target?.kind === "message") {
        out[field.name] = this.applyPresenceAndDefaults(target.def, value as Record<string, unknown>, fieldPath);
        continue;
      }
      out[field.name] = value;
    }
    return out;
  }

  issuesAll(): Issue[] {
    return this.issues;
  }
}

function zeroValue(target: { kind: "scalar"; scalar: ScalarType } | { kind: "message"; def: MessageDef } | { kind: "enum"; def: { fullName: string; values: { name: string; number: number }[] } }): unknown {
  switch (target.kind) {
    case "message": return undefined;
    case "enum": {
      const first = target.def.values[0];
      return first ? first.name : "";
    }
    case "scalar": {
      switch (target.scalar) {
        case "bool": return false;
        case "string": return "";
        case "bytes": return "";
        default: return 0;
      }
    }
  }
}

function literalToValue(field: FieldDef, literal: NonNullable<FieldDef["defaultValue"]>, registry: TypeRegistry): unknown {
  switch (literal.kind) {
    case "number": return literal.value;
    case "string": return literal.value;
    case "bool": return literal.value;
    case "identifier": {
      const en = registry.enumByName.get(field.type);
      return literal.value ? literal.value : en?.values[0]?.name ?? literal.value;
    }
  }
}

function joinPath(base: string, key: string): string {
  return `${base}.${key}`;
}

function mergeInto(base: Record<string, unknown>, fragment: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(fragment)) {
    const existing = out[key];
    if (
      existing !== null && value !== null &&
      typeof existing === "object" && typeof value === "object" &&
      !Array.isArray(existing) && !Array.isArray(value)
    ) {
      out[key] = mergeInto(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function loadConfig(options: LoadOptions): LoadResult {
  const unknown = options.unknownFields ?? "error";
  const root = options.root ?? options.schema.root;
  const preIssues: Issue[] = [];
  for (const source of options.sources) {
    if (source.issues) preIssues.push(...source.issues);
  }
  if (preIssues.length > 0) {
    return { ok: false, issues: sortIssues(preIssues) };
  }
  const decoder = new Decoder(options.schema, unknown);
  const value = decoder.decodeRoot(root, options.sources);
  if (value === undefined) {
    return { ok: false, issues: decoder.issuesAll() };
  }
  return { ok: true, value };
}


