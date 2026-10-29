import { readFileSync } from "fs";
import { loadSchema, loadConfig, envSource, type Schema } from "./index.js";
import { PclError } from "./errors.js";
import { sortIssues, renderResolved, summarizeSchema } from "./report.js";
import { parseSchema } from "./parser.js";
import { DEMO_CONFIG, DEMO_ENV, DEMO_OUTPUT, DEMO_SCHEMA } from "./demo.js";
import { VERSION } from "./version.js";

function requireArg(args: string[], what: string): string {
  const value = args.shift();
  if (value === undefined) throw new PclError("PCL_USAGE", `missing required positional argument: ${what}`);
  return value;
}

function loadSchemaOrDie(path: string): Schema {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    throw new PclError("PCL_IO", `cannot read schema file '${path}': ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return loadSchema(text, { fileName: path });
  } catch (error) {
    if (error instanceof PclError) throw error;
    throw new PclError("PCL_INTERNAL", `unexpected schema load failure for '${path}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface GlobalOpts {
  schema?: string;
  root?: string;
}

export function cmdValidate(args: string[], global: GlobalOpts): number {
  const schemaPath = global.schema ?? requireArg(args, "--schema <file> or config file");
  const configPath = requireArg(args, "config file");
  const schema = loadSchemaOrDie(schemaPath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (error) {
    throw new PclError("PCL_IO", `cannot read config file '${configPath}': ${error instanceof Error ? error.message : String(error)}`);
  }
  const rootName = resolveRootName(schema, global.root ?? schema.root);
  const result = loadConfig({ schema, sources: [{ name: configPath, data: raw }], root: rootName });
  if (result.ok) {
    console.log(`OK: '${configPath}' is valid against root '${rootName}'`);
    return 0;
  }
  for (const issue of result.issues) {
    console.error(`  ${issue.path}: ${issue.message} [${issue.code}${issue.source ? `, ${issue.source}` : ""}]`);
  }
  console.error(`validation failed with ${result.issues.length} issue(s)`);
  return 4;
}

function resolveRootName(schema: Schema, name: string): string {
  const exact = schema.messages.find((m) => m.fullName === name);
  if (exact) return exact.fullName;
  const short = schema.messages.filter((m) => m.name === name || m.fullName.endsWith(`.${name}`));
  if (short.length === 1) return short[0]!.fullName;
  return name;
}

export function cmdPrint(args: string[], global: GlobalOpts): number {
  const schemaPath = global.schema ?? requireArg(args, "--schema <file> or config file");
  const configPath = requireArg(args, "config file");
  const schema = loadSchemaOrDie(schemaPath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (error) {
    throw new PclError("PCL_IO", `cannot read config file '${configPath}': ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = loadConfig({ schema, sources: [{ name: configPath, data: raw }], root: global.root ?? schema.root });
  if (!result.ok) {
    for (const issue of result.issues) {
      console.error(`  ${issue.path}: ${issue.message} [${issue.code}${issue.source ? `, ${issue.source}` : ""}]`);
    }
    console.error(`validation failed with ${result.issues.length} issue(s)`);
    throw new PclError("PCL_VALIDATION", "config failed validation", result.issues);
  }
  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export function cmdSchema(args: string[], global: GlobalOpts): number {
  const schemaPath = global.schema ?? requireArg(args, "--schema <file> or schema file");
  const schema = loadSchemaOrDie(schemaPath);
  process.stdout.write(summarizeSchema(schema));
  return 0;
}

export function cmdDemoSchema(_args: string[]): number {
  process.stdout.write(DEMO_SCHEMA);
  return 0;
}

export function cmdDemo(_args: string[]): number {
  const schema = loadSchema(DEMO_SCHEMA, { fileName: "demo.proto" });
  const json = JSON.parse(DEMO_CONFIG) as Record<string, unknown>;
  const envInput = envSource(schema, DEMO_ENV);
  const result = loadConfig({
    schema,
    sources: [
      { name: "config.json", data: json },
      envInput,
    ],
  });
  if (!result.ok) {
    for (const issue of sortIssues(result.issues)) {
      console.error(`  ${issue.path}: ${issue.message} [${issue.code}${issue.source ? `, ${issue.source}` : ""}]`);
    }
    throw new PclError("PCL_VALIDATION", "demo failed validation (this is a bug — the demo inputs are static and known-good)", result.issues);
  }
  const body = renderResolved(result.value);
  const trailer = "Sources: file config.json (highest) > env PCL_* > schema defaults (lowest).";
  console.log(`Resolved config ($ = ${schema.root}):\n${body}\n${trailer}`);
  return 0;
}

export function cmdVersion(): number {
  console.log(`pcl ${VERSION}`);
  return 0;
}

export function cmdHelp(): number {
  console.log(`pcl — protobuf-style config loader

Usage:
  pcl validate [args] <config.json>          Validate a config file against the schema (exit 0 or 4)
  pcl print [args] <config.json>             Print the resolved config with defaults applied
  pcl schema [args] <schema-file>            Print a summary of messages, enums, and fields
  pcl demo                                   Run the deterministic demo (schema + JSON + env overrides)
  pcl demo-schema                            Print the demo schema text
  pcl version                                Print version
  pcl help                                   Show this help

Arguments:
  --schema <file>    Path to the .proto-style schema (optional when positional schema given)
  --root <Message>   Root message name (default: the last message in the schema)

Exit codes:
  0  success
  1  internal error (a bug — please report)
  2  usage error
  3  schema parse or reference error
  4  config validation failure
  5  I/O error (unreadable file, invalid JSON)`);
  return 0;
}
