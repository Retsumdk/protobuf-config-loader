import type { FieldDef, Issue, Literal, Schema } from "./types.js";

const ISSUE_ORDER: Issue["code"][] = [
  "IO",
  "PARSE",
  "MISSING_REQUIRED",
  "UNKNOWN_FIELD",
  "RESERVED_FIELD",
  "ONEOF_VIOLATION",
  "TYPE_MISMATCH",
  "RANGE",
  "ENUM_VALUE",
  "BASE64",
  "MAP_KEY",
];

export function sortIssues(issues: Issue[]): Issue[] {
  const rank = new Map(ISSUE_ORDER.map((code, i) => [code, i]));
  return [...issues].sort((a, b) => {
    const ra = rank.get(a.code) ?? ISSUE_ORDER.length;
    const rb = rank.get(b.code) ?? ISSUE_ORDER.length;
    if (ra !== rb) return ra - rb;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
}

export function formatIssues(issues: Issue[]): string {
  return sortIssues(issues)
    .map((i) => {
      const where = i.source ? ` [${i.source}]` : "";
      return `error ${i.code} at ${i.path}${where}: ${i.message}`;
    })
    .join("\n");
}

export function formatConfig(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

export function summarizeSchema(schema: Schema): string {
  const lines: string[] = [];
  lines.push(`syntax: ${schema.syntax}`);
  if (schema.package) lines.push(`package: ${schema.package}`);
  lines.push(`root: ${schema.root}`);
  lines.push("");
  for (const en of schema.enums) {
    lines.push(`enum ${en.fullName}`);
    for (const v of en.values) lines.push(`  ${v.name} = ${v.number}`);
    lines.push("");
  }
  for (const msg of schema.messages) {
    lines.push(`message ${msg.fullName}`);
    for (const f of msg.fields) lines.push(`  ${renderField(f)}`);
    for (const one of msg.oneofs) {
      lines.push(`  oneof ${one.name} { ${one.fields.map((f) => f.name).join(", ")} }`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function renderField(f: FieldDef): string {
  const type = f.mapKey && f.mapValue ? `map<${f.mapKey}, ${f.mapValue}>` : f.type;
  const isMap = Boolean(f.mapKey && f.mapValue);
  const card = f.cardinality === "plain" || isMap ? "" : `${f.cardinality} `;
  const def = f.defaultValue === undefined ? "" : ` [default = ${formatDefault(f.defaultValue)}]`;
  return `${card}${type} ${f.name} = ${f.number}${def}`;
}

function formatDefault(v: Literal): string {
  switch (v.kind) {
    case "string": return JSON.stringify(v.value);
    case "number": return String(v.value);
    case "bool": return v.value ? "true" : "false";
    case "identifier": return v.value;
  }
}

function isScalarValue(v: unknown): boolean {
  return v === null || typeof v === "number" || typeof v === "boolean" || typeof v === "string";
}

function inlineValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((item) => JSON.stringify(item)).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const parts = Object.entries(v as Record<string, unknown>).map(
      ([k, val]) => `${JSON.stringify(k)}: ${inlineValue(val)}`,
    );
    return `{ ${parts.join(", ")} }`;
  }
  return JSON.stringify(v);
}

/**
 * Render a resolved config deterministically: nested objects print multiline with
 * 2-space indentation, but objects whose values are all scalars and scalar arrays
 * print inline. Used by `pcl demo` and the demo test so output is byte-identical.
 */
export function renderResolved(value: unknown): string {
  const render = (v: unknown, indent: string): string => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.every(([, val]) => isScalarValue(val) || Array.isArray(val))) return inlineValue(v);
      const parts = entries.map(
        ([k, val]) => `${indent}${JSON.stringify(k)}: ${render(val, indent + "  ")}`,
      );
      return `{\n${parts.join(",\n")}\n${indent.slice(2)}}`;
    }
    return inlineValue(v);
  };
  return render(value, "  ");
}
