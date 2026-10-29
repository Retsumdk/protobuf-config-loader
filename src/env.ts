import { isScalarType, type Issue, type Schema, type SourceInput } from "./types.js";

export interface EnvOptions {
  prefix?: string;
}

const FLOATING = new Set(["double", "float"]);

function coerceScalar(scalar: string, raw: string): unknown {
  const text = raw.trim();
  if (scalar === "bool") {
    if (text === "true") return true;
    if (text === "false") return false;
    throw new Error(`invalid boolean '${raw}' (expected true or false)`);
  }
  if (scalar === "string") return raw;
  if (scalar === "bytes") return text;
  if (FLOATING.has(scalar)) {
    const num = Number(text);
    if (!Number.isFinite(num)) throw new Error(`invalid number '${raw}'`);
    return num;
  }
  if (!/^[+-]?\d+$/.test(text)) throw new Error(`invalid integer '${raw}'`);
  return Number(text);
}

export function parseEnvValue(value: string, expect: "integer" | "number" | "boolean" | "string" | "json"): unknown {
  switch (expect) {
    case "boolean": {
      if (value === "true") return true;
      if (value === "false") return false;
      throw new Error(`invalid boolean '${value}' (expected true or false)`);
    }
    case "integer": {
      if (!/^[+-]?\d+$/.test(value.trim())) throw new Error(`invalid integer '${value}'`);
      return Number(value.trim());
    }
    case "number": {
      const num = Number(value.trim());
      if (!Number.isFinite(num)) throw new Error(`invalid number '${value}'`);
      return num;
    }
    case "string":
      return value;
    case "json": {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        throw new Error(`invalid JSON '${value}'`);
      }
    }
  }
}

type FieldKind =
  | { kind: "scalar"; scalar: string }
  | { kind: "enum" }
  | { kind: "message" }
  | { kind: "map" };

interface FieldInfo {
  name: string;
  repeated: boolean;
  type: string;
  fieldKind: FieldKind;
}

interface LookupNode {
  fields: Map<string, FieldInfo>;
  children: Map<string, LookupNode>;
}

function classifyField(schema: Schema, type: string): FieldKind {
  if (type === "map") return { kind: "map" };
  if (isScalarType(type)) return { kind: "scalar", scalar: type };
  if (schema.enums.some((e) => e.fullName === type || e.name === type)) return { kind: "enum" };
  return { kind: "message" };
}

function buildLookup(schema: Schema, rootName: string): LookupNode {
  const root = schema.messages.find((m) => m.fullName === rootName || m.name === rootName);
  if (!root) throw new Error(`root message '${rootName}' not found in schema`);
  const build = (messageType: string): LookupNode => {
    const def = schema.messages.find((m) => m.fullName === messageType || m.name === messageType);
    const node: LookupNode = { fields: new Map(), children: new Map() };
    if (!def) return node;
    for (const field of def.fields) {
      const fieldKind = classifyField(schema, field.type);
      node.fields.set(field.name.toUpperCase(), {
        name: field.name,
        repeated: field.cardinality === "repeated",
        type: field.type,
        fieldKind,
      });
      if (fieldKind.kind === "message") {
        node.children.set(field.name.toUpperCase(), build(field.type));
      }
    }
    return node;
  };
  return build(rootName);
}

function asArray(value: string): unknown[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const parsed = parseEnvValue(trimmed, "json");
    if (!Array.isArray(parsed)) throw new Error("JSON value for repeated field must be an array");
    return parsed as unknown[];
  }
  if (trimmed === "") return [];
  return trimmed.split(",").map((part) => part.trim());
}

export function envSource(schema: Schema, env: Record<string, string>, options: EnvOptions = {}): SourceInput {
  const prefix = options.prefix ?? "PCL_";
  const root = buildLookup(schema, schema.root);
  const data: Record<string, unknown> = {};
  const issues: Issue[] = [];

  const entries = Object.entries(env)
    .filter(([key]) => key.startsWith(prefix) && key.length > prefix.length)
    .map(([envKey, value]) => ({
      envKey,
      path: envKey.slice(prefix.length).split("__").filter((p) => p !== ""),
      value,
    }))
    .sort(
      (a, b) =>
        a.path.join("__").localeCompare(b.path.join("__")) || a.envKey.localeCompare(b.envKey),
    );

  for (const entry of entries) {
    let node = root;
    const resolved: string[] = [];
    let ok = true;
    for (let i = 0; i < entry.path.length - 1; i++) {
      const part = entry.path[i];
      if (part === undefined) {
        ok = false;
        break;
      }
      const upper = part.toUpperCase();
      const child = node.children.get(upper);
      const field = node.fields.get(upper);
      if (!child || !field || field.fieldKind.kind !== "message") {
        issues.push({
          path: entry.envKey,
          code: "UNKNOWN_FIELD",
          message: `no schema field matches environment variable '${entry.envKey}'`,
          source: "env",
        });
        ok = false;
        break;
      }
      node = child;
      resolved.push(field.name);
    }
    if (!ok) continue;
    const leafSeg = entry.path[entry.path.length - 1];
    if (leafSeg === undefined) continue;
    const field = node.fields.get(leafSeg.toUpperCase());
    if (!field) {
      issues.push({
        path: entry.envKey,
        code: "UNKNOWN_FIELD",
        message: `no schema field matches environment variable '${entry.envKey}'`,
        source: "env",
      });
      continue;
    }
    resolved.push(field.name);

    try {
      let value: unknown;
      if (field.repeated) {
        const items = asArray(entry.value);
        const kind = field.fieldKind;
        if (kind.kind === "scalar") {
          const scalar = kind.scalar;
          value = items.map((item) =>
            typeof item === "string" ? coerceScalar(scalar, item) : item,
          );
        } else {
          value = items;
        }
      } else if (field.fieldKind.kind === "scalar") {
        value = coerceScalar(field.fieldKind.scalar, entry.value);
      } else if (field.fieldKind.kind === "enum") {
        value = entry.value.trim();
      } else {
        value = parseEnvValue(entry.value, "json");
      }
      let cursor = data;
      for (const part of resolved.slice(0, -1)) {
        const existing = cursor[part];
        if (existing === undefined || typeof existing !== "object" || Array.isArray(existing)) {
          cursor[part] = {};
        }
        cursor = cursor[part] as Record<string, unknown>;
      }
      const lastPart = resolved[resolved.length - 1];
      if (lastPart === undefined) continue;
      cursor[lastPart] = value;
    } catch (error) {
      issues.push({
        path: entry.envKey,
        code: "TYPE_MISMATCH",
        message: error instanceof Error ? error.message : String(error),
        source: "env",
      });
    }
  }
  return { name: "env", data, issues };
}
