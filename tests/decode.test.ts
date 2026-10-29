import { describe, test, expect } from "bun:test";
import { loadSchema, parseSchema } from "../src/parser.js";
import { loadConfig, base64ToBytes, bytesToBase64 } from "../src/decode.js";
import type { SourceInput } from "../src/types.js";

function src(data: unknown, name = "json"): SourceInput {
  return { name, data };
}

const TRIVIAL = 'syntax = "pcl/1"; message M { string name = 1; }';

describe("scalars and ranges", () => {
  test("strings pass through", () => {
    const r = loadConfig({ schema: loadSchema(TRIVIAL), sources: [src({ name: "svc" })] });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toEqual({ name: "svc" });
  });

  test("int32 accepts integral JSON numbers and rejects fractions", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { int32 n = 1; }');
    expect(loadConfig({ schema, sources: [src({ n: 42 })] }).ok).toBe(true);
    expect(loadConfig({ schema, sources: [src({ n: 42.5 })] }).ok).toBe(false);
    expect(loadConfig({ schema, sources: [src({ n: "42" })] }).ok).toBe(false);
  });

  test("int32 range enforced", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { int32 n = 1; }');
    expect(loadConfig({ schema, sources: [src({ n: 2147483648 })] }).ok).toBe(false);
    expect(loadConfig({ schema, sources: [src({ n: -2147483649 })] }).ok).toBe(false);
  });

  test("uint range enforced", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { uint32 n = 1; }');
    expect(loadConfig({ schema, sources: [src({ n: -1 })] }).ok).toBe(false);
    expect(loadConfig({ schema, sources: [src({ n: 4294967296 })] }).ok).toBe(false);
  });

  test("int64 bounded to safe integer range", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { int64 n = 1; }');
    expect(loadConfig({ schema, sources: [src({ n: Number.MAX_SAFE_INTEGER })] }).ok).toBe(true);
    expect(loadConfig({ schema, sources: [src({ n: 9007199254740992 })] }).ok).toBe(false);
  });

  test("floats accept integral numbers, reject strings", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { double d = 1; }');
    expect(loadConfig({ schema, sources: [src({ d: 3 })] }).ok).toBe(true);
    expect(loadConfig({ schema, sources: [src({ d: "3" })] }).ok).toBe(false);
  });

  test("bool rejects truthy strings", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { bool flag = 1; }');
    expect(loadConfig({ schema, sources: [src({ flag: "true" })] }).ok).toBe(false);
    expect(loadConfig({ schema, sources: [src({ flag: true })] }).ok).toBe(true);
  });

  test("bytes accepts canonical base64 only", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { bytes blob = 1; }');
    expect(loadConfig({ schema, sources: [src({ blob: "aGVsbG8=" })] }).ok).toBe(true);
    expect(loadConfig({ schema, sources: [src({ blob: "not base64!!" })] }).ok).toBe(false);
  });

  test("base64 helpers round-trip", () => {
    const decoded = base64ToBytes("aGVsbG8=");
    expect(decoded && new TextDecoder().decode(decoded)).toBe("hello");
    expect(bytesToBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
  });

  test("non-finite numbers rejected", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { double d = 1; }');
    expect(loadConfig({ schema, sources: [src({ d: Number.POSITIVE_INFINITY })] }).ok).toBe(false);
  });
});

describe("cardinality and defaults", () => {
  test("required missing reports MISSING_REQUIRED with path", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { required string host = 1; }');
    const r = loadConfig({ schema, sources: [src({})] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0]?.code).toBe("MISSING_REQUIRED");
      expect(r.issues[0]?.path).toBe("$.host");
    }
  });

  test("explicit schema default fills absent plain field", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { int32 port = 1 [default = 8080]; }');
    const r = loadConfig({ schema, sources: [src({})] });
    expect(r.ok && r.value).toEqual({ port: 8080 });
  });

  test("zero values fill absent plain fields (proto3-style)", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { string s = 1; int32 n = 2; bool b = 3; }');
    const r = loadConfig({ schema, sources: [src({})] });
    expect(r.ok && r.value).toEqual({ s: "", n: 0, b: false });
  });

  test("repeated defaults to empty array", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { repeated string tags = 1; }');
    const r = loadConfig({ schema, sources: [src({})] });
    expect(r.ok && r.value).toEqual({ tags: [] });
  });

  test("repeated scalar validates every element", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { repeated int32 ports = 1; }');
    const r = loadConfig({ schema, sources: [src({ ports: [1, 2, "x", 4] })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe("$.ports[2]");
  });

  test("repeated rejects non-array", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { repeated string tags = 1; }');
    const r = loadConfig({ schema, sources: [src({ tags: "ops" })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.code).toBe("TYPE_MISMATCH");
  });

  test("nested message absent stays absent", () => {
    const schema = loadSchema('syntax = "pcl/1"; message Tls { string cert = 1; } message M { Tls tls = 1; }');
    const r = loadConfig({ schema, root: "M", sources: [src({})] });
    expect(r.ok && r.value).toEqual({});
  });

  test("nested message decodes recursively with defaults", () => {
    const schema = loadSchema(
      'syntax = "pcl/1"; message Tls { string cert = 1 [default = "none"]; required bool enabled = 2; } message M { Tls tls = 1; }',
    );
    const r = loadConfig({ schema, root: "M", sources: [src({ tls: { enabled: true } })] });
    expect(r.ok && r.value).toEqual({ tls: { cert: "none", enabled: true } });
  });

  test("nested message missing required reports nested path", () => {
    const schema = loadSchema(
      'syntax = "pcl/1"; message Tls { required string cert = 1; } message M { Tls tls = 1; }',
    );
    const r = loadConfig({ schema, root: "M", sources: [src({ tls: {} })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe("$.tls.cert");
  });

  test("null for message field is a type mismatch", () => {
    const schema = loadSchema('syntax = "pcl/1"; message T { string a = 1; } message M { T t = 1; }');
    const r = loadConfig({ schema, root: "M", sources: [src({ t: null })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.code).toBe("TYPE_MISMATCH");
  });
});

describe("maps", () => {
  const SCHEMA = 'syntax = "pcl/1"; message M { map<string, int32> limits = 1; }';

  test("map decodes keys and values", () => {
    const schema = loadSchema(SCHEMA);
    const r = loadConfig({ schema, sources: [src({ limits: { api: 10, db: 5 } })] });
    expect(r.ok && r.value).toEqual({ limits: { api: 10, db: 5 } });
  });

  test("map values validated", () => {
    const schema = loadSchema(SCHEMA);
    const r = loadConfig({ schema, sources: [src({ limits: { api: "ten" } })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe('$.limits["api"]');
  });

  test("numeric JSON keys arrive as strings for string-key maps", () => {
    const schema = loadSchema(SCHEMA);
    const r = loadConfig({ schema, sources: [src({ limits: { 7: 1 } })] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ limits: { "7": 1 } });
  });

  test("int-keyed map coerces string digits? no - strict", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { map<int32, string> m = 1; }');
    const r = loadConfig({ schema, sources: [src({ m: { "1": "a" } })] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ m: { "1": "a" } });
  });

  test("map input that is not an object fails", () => {
    const schema = loadSchema(SCHEMA);
    const r = loadConfig({ schema, sources: [src({ limits: [1, 2] })] });
    expect(r.ok).toBe(false);
  });
});

describe("enums", () => {
  const SCHEMA = 'syntax = "pcl/1"; enum Level { LOW = 0; MED = 1; HIGH = 2; } message M { Level level = 1 [default = MED]; }';

  test("enum by name", () => {
    const schema = loadSchema(SCHEMA);
    const r = loadConfig({ schema, sources: [src({ level: "HIGH" })] });
    expect(r.ok && r.value).toEqual({ level: "HIGH" });
  });

  test("enum by number", () => {
    const schema = loadSchema(SCHEMA);
    const r = loadConfig({ schema, sources: [src({ level: 2 })] });
    expect(r.ok && r.value).toEqual({ level: "HIGH" });
  });

  test("unknown enum name fails with ENUM_VALUE", () => {
    const schema = loadSchema(SCHEMA);
    const r = loadConfig({ schema, sources: [src({ level: "EXTREME" })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.code).toBe("ENUM_VALUE");
  });

  test("unknown enum number fails", () => {
    const schema = loadSchema(SCHEMA);
    expect(loadConfig({ schema, sources: [src({ level: 9 })] }).ok).toBe(false);
  });

  test("default applies", () => {
    const schema = loadSchema(SCHEMA);
    const r = loadConfig({ schema, sources: [src({})] });
    expect(r.ok && r.value).toEqual({ level: "MED" });
  });

  test("non-string non-number enum input fails", () => {
    const schema = loadSchema(SCHEMA);
    expect(loadConfig({ schema, sources: [src({ level: true })] }).ok).toBe(false);
  });
});

describe("merging and precedence", () => {
  test("later sources override scalars", () => {
    const schema = loadSchema(TRIVIAL);
    const r = loadConfig({ schema, sources: [src({ name: "a" }, "base"), src({ name: "b" }, "override")] });
    expect(r.ok && r.value).toEqual({ name: "b" });
  });

  test("message fields deep-merge across sources", () => {
    const schema = loadSchema(
      'syntax = "pcl/1"; message Tls { string cert = 1; string key = 2; } message M { Tls tls = 1; }',
    );
    const r = loadConfig({
      schema,
      root: "M",
      sources: [src({ tls: { cert: "a.pem", key: "a.key" } }, "base"), src({ tls: { cert: "b.pem" } }, "override")],
    });
    expect(r.ok && r.value).toEqual({ tls: { cert: "b.pem", key: "a.key" } });
  });

  test("repeated fields replace rather than concat", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { repeated string tags = 1; }');
    const r = loadConfig({ schema, sources: [src({ tags: ["a", "b"] }), src({ tags: ["c"] })] });
    expect(r.ok && r.value).toEqual({ tags: ["c"] });
  });

  test("null in a later source overrides with null (surfaced as error)", () => {
    const schema = loadSchema(TRIVIAL);
    const r = loadConfig({ schema, sources: [src({ name: "a" }), src({ name: null })] });
    expect(r.ok).toBe(false);
  });

  test("non-object source is rejected with source name", () => {
    const schema = loadSchema(TRIVIAL);
    const r = loadConfig({ schema, sources: [src([1, 2], "listy")] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.message).toContain("listy");
  });

  test("source pre-issues fail the load before decode", () => {
    const schema = loadSchema(TRIVIAL);
    const r = loadConfig({
      schema,
      sources: [{ name: "env", data: {}, issues: [{ path: "PCL_X", code: "UNKNOWN_FIELD", message: "nope", source: "env" }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.source).toBe("env");
  });
});

describe("unknown and reserved fields", () => {
  const SCHEMA = 'syntax = "pcl/1"; message M { reserved 5; reserved "legacy"; string a = 1; }';

  test("unknown policy error (default) reports path and message", () => {
    const schema = loadSchema(SCHEMA);
    const r = loadConfig({ schema, sources: [src({ nope: 1 })] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0]?.code).toBe("UNKNOWN_FIELD");
      expect(r.issues[0]?.path).toBe("$.nope");
    }
  });

  test("unknown policy ignore drops the field", () => {
    const schema = loadSchema(SCHEMA);
    const r = loadConfig({ schema, sources: [src({ nope: 1, a: "x" })], unknownFields: "ignore" });
    expect(r.ok && r.value).toEqual({ a: "x" });
  });

  test("reserved fields error even under ignore policy", () => {
    const schema = loadSchema(SCHEMA);
    const r = loadConfig({ schema, sources: [src({ legacy: 1 })], unknownFields: "ignore" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.code).toBe("RESERVED_FIELD");
  });

  test("unknown inside nested message reports nested path", () => {
    const schema = loadSchema('syntax = "pcl/1"; message T { string a = 1; } message M { T t = 1; }');
    const r = loadConfig({ schema, root: "M", sources: [src({ t: { nope: 1 } })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe("$.t.nope");
  });
});

describe("root selection", () => {
  test("explicit root option overrides schema inference", () => {
    const schema = parseSchema('syntax = "pcl/1"; message Leaf { string a = 1; } message Top { Leaf leaf = 1; }');
    const r = loadConfig({ schema, root: "Top", sources: [src({ leaf: { a: "x" } })] });
    expect(r.ok && r.value).toEqual({ leaf: { a: "x" } });
  });

  test("unknown root message fails", () => {
    const schema = loadSchema(TRIVIAL);
    const r = loadConfig({ schema, root: "Nope", sources: [src({})] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.message).toContain("Nope");
  });

  test("root cannot name an enum", () => {
    const schema = parseSchema('syntax = "pcl/1"; enum E { A = 0; } message M { string a = 1; }');
    const r = loadConfig({ schema, root: "E", sources: [src({})] });
    expect(r.ok).toBe(false);
  });
});

describe("determinism", () => {
  test("field application follows field-number order", () => {
    const schema = loadSchema('syntax = "pcl/1"; message M { string z = 2; string a = 1; }');
    const r = loadConfig({ schema, sources: [src({ z: "zz", a: "aa" })] });
    if (r.ok) expect(Object.keys(r.value)).toEqual(["a", "z"]);
    else throw new Error("expected ok");
  });
});
