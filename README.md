# protobuf-config-loader

Protobuf-style schemas for typed application config.

You write one schema file that describes your configuration — field types, required fields, defaults, nested messages, enums, maps — and the loader turns any combination of JSON files and environment variables into one validated, fully-resolved config object with precise error paths like `$.tls.cert: required field 'key' is not set`.

## The problem

Application config is usually validated with ad-hoc checks scattered through the code: `if (!config.port) throw ...`, `typeof config.tls?.cert === "string" || ...`. Every new field multiplies the checks, defaults live far away from the fields they belong to, env-var overrides need hand-written parsers per field, and error messages rarely say *which* nested field was wrong.

Schema languages solve this, but pulling in a full protobuf toolchain (protoc, codegen, runtime) just to validate a config file is heavy: generated code, a build step, and a runtime dependency for what is fundamentally "read JSON, check types, apply defaults".

## The solution

`protobuf-config-loader` keeps the part of protobuf that makes config safe — the schema language — and drops the parts that make it heavy: no wire format, no code generation, no protoc, no runtime dependencies.

- **Familiar schema language.** Messages, nested types, enums, maps, oneofs, `required`/`repeated`/`optional` cardinalities, field numbers, and `[default = ...]` options — if you have read a `.proto` file, you already know the syntax.
- **One loader, many sources.** Merge JSON files and environment variables in declared precedence order; later sources override earlier ones field-by-field, with deep merges for message fields.
- **Defaults live in the schema.** `[default = 8080]` sits next to the field it belongs to, and absent scalars resolve to their zero values (proto3-style) so the output is always explicit.
- **Precise errors.** Every validation issue carries a full path (`$.fleet.tls.cert`), an error class (`MISSING_REQUIRED`, `TYPE_MISMATCH`, `ENUM_VALUE`, …), and the source that caused it (`config.json`, `env`).
- **Zero dependencies.** ~15 kB of TypeScript, MIT licensed, runs on Node ≥ 18 and Bun.

## How it works

```
schema.proto ──loadSchema──▶ Schema (parsed + reference-resolved)
                                    │
config.json ─┐                      │
env PCL_*  ──┴─sources──▶ loadConfig ─▶ merge ─▶ validate ─▶ apply defaults ─▶ Resolved config
```

1. **Parse** (`loadSchema`): a recursive-descent parser reads the proto-style schema text and validates it — duplicate names, field-number ranges (1..536870911, protobuf-reserved 19000–19999 rejected), enum rules, type references, and default-literal compatibility are all checked at load time, before any config is read.
2. **Merge** (`loadConfig`): sources are decoded and merged in order. Message fields deep-merge across sources; repeated fields and maps replace wholesale; a `null` in a later source wins and then surfaces as a validation error, so a dropped value can never fail silently.
3. **Validate**: every value is checked against the schema — scalars (integer ranges for `int32`/`int64`/`uint32`/`uint64`, finiteness for floats, strict booleans, canonical base64 for `bytes`), enum values by name or number, map keys, and `required` fields.
4. **Apply defaults**: absent plain fields take their `[default = ...]` value or the type's zero value; absent message fields stay absent; oneofs enforce at-most-one-set.
5. **Resolve**: the output is a plain JSON-safe object, fully explicit — every scalar, repeated, and map field is present, in field-number order.

## Getting started

### Install (from GitHub)

The package is distributed via git — no registry needed:

```bash
npm install github:Retsumdk/protobuf-config-loader
```

The package ships a `prepare` script, so npm compiles it during install. If you use Bun, Bun blocks git-dependency lifecycle scripts by default — trust the package once after installing:

```bash
bun add github:Retsumdk/protobuf-config-loader
bun pm trust protobuf-config-loader
```

### Or clone and run

```bash
git clone https://github.com/Retsumdk/protobuf-config-loader.git
cd protobuf-config-loader
bun install && bun run build
```

### The CLI

The repo ships a CLI (`pcl`) with five commands. Given this schema (`svc.proto`):

```proto
syntax = "pcl/1";

package fleet;

message ServiceConfig {
  string host = 1;
  int32 port = 2 [default = 8080];
  bool verbose = 3;
  string api_key = 4;
  LogLevel log_level = 5 [default = INFO];
  repeated string tags = 6;
  map<string, string> labels = 7;
  Tls tls = 8;
  oneof auth {
    string token = 9;
    string basic_user = 10;
  }
}

message Tls {
  required string cert = 1;
  required string key = 2;
  bool skip_verify = 3;
}

enum LogLevel {
  DEBUG = 0;
  INFO = 1;
  WARN = 2;
  ERROR = 3;
}
```

Validate a config file (`ok.json`):

```bash
npx pcl validate svc.proto ok.json
# OK: 'ok.json' is valid against root 'fleet.ServiceConfig'
```

Print the fully-resolved config with defaults applied:

```bash
npx pcl print svc.proto ok.json
```

```json
{
  "host": "api.example.com",
  "port": 9090,
  "verbose": false,
  "api_key": "",
  "log_level": "INFO",
  "tags": [
    "edge"
  ],
  "labels": {},
  "tls": {
    "cert": "/etc/c.pem",
    "key": "/etc/k.pem",
    "skip_verify": false
  }
}
```

Inspect a schema:

```bash
npx pcl schema svc.proto
```

```text
syntax: pcl/1
package: fleet
root: fleet.ServiceConfig

enum fleet.LogLevel
  DEBUG = 0
  INFO = 1
  WARN = 2
  ERROR = 3

message fleet.ServiceConfig
  string host = 1
  int32 port = 2 [default = 8080]
  bool verbose = 3
  string api_key = 4
  LogLevel log_level = 5 [default = INFO]
  repeated string tags = 6
  map<string, string> labels = 7
  Tls tls = 8
  oneof auth { token, basic_user }

message fleet.Tls
  required string cert = 1
  required string key = 2
  bool skip_verify = 3
```

See a fully-worked example with env overrides:

```bash
npx pcl demo
```

```text
Resolved config ($ = fleet.ServiceConfig):
{
  "host": "api.example.com",
  "port": 9090,
  "verbose": true,
  "api_key": "",
  "log_level": "WARN",
  "tags": ["edge","prod"],
  "labels": { "team": "infra", "region": "us-east" },
  "tls": { "cert": "/etc/certs/api.pem", "key": "/etc/certs/api-key.pem", "skip_verify": false },
  "token": "tok_9f2c"
}
Sources: file config.json (highest) > env PCL_* > schema defaults (lowest).
```

### Library API

```ts
import { loadSchema, loadConfig, envSource } from "protobuf-config-loader";
import { readFileSync } from "node:fs";

const schema = loadSchema(readFileSync("svc.proto", "utf-8"));

const result = loadConfig({
  schema,
  sources: [
    { name: "config.json", data: JSON.parse(readFileSync("config.json", "utf-8")) },
    envSource(schema, process.env, { prefix: "PCL_" }),
  ],
  // unknownFields: "error" | "warn" | "ignore"  (default "error")
});

if (!result.ok) {
  for (const issue of result.issues) {
    console.error(`${issue.path}: ${issue.message} [${issue.code}]`);
  }
  process.exit(1);
}

console.log(result.value.port); // fully resolved, defaults applied
```

### Environment variable mapping

`envSource` maps variables to schema fields with a configurable prefix (default `PCL_`):

- Nesting uses double underscores: `PCL_TLS__CERT` → `tls.cert`.
- Scalars are parsed strictly: integers must be integers, booleans are exactly `true`/`false`.
- Repeated fields accept either a JSON array (`PCL_TAGS='["a","b"]'`) or a comma-separated list (`PCL_TAGS=a,b`).
- Message and map fields accept JSON (`PCL_LABELS='{"team":"infra"}'`).
- A variable that matches no schema field is an `UNKNOWN_FIELD` issue sourced to `env` — typos in env config are caught, not silently dropped.

## Error codes and exit status

| Code | Meaning | CLI exit |
|------|---------|----------|
| `PCL_USAGE` | bad command-line usage | 2 |
| `PCL_SCHEMA_PARSE` | schema text is invalid | 3 |
| `PCL_IO` | unreadable file, invalid JSON | 5 |
| `PCL_VALIDATION` | config failed validation | 4 |
| `PCL_INTERNAL` | unexpected internal failure | 1 |

Validation issue classes: `MISSING_REQUIRED`, `TYPE_MISMATCH`, `RANGE`, `ENUM_VALUE`, `UNKNOWN_FIELD`, `RESERVED_FIELD`, `ONEOF_VIOLATION`, `MAP_KEY`, `BASE64`, `PARSE`, `IO`.

## Development

```bash
bun install      # install devDependencies (typescript, bun-types)
bun run build    # tsc — emits dist/ with declarations
bun test         # 110 tests: parser, decoder, env mapping, CLI, demo determinism
```

The demo output checked into `src/demo.ts` is asserted byte-identical against a live `loadSchema → loadConfig → render` run on every test run, and CI verifies the git-install path with a real `npm install` from a neutral project — the README examples above are produced by those exact code paths.

## License

MIT