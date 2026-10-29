import { describe, test, expect } from "bun:test";
import { loadSchema, loadConfig, envSource, parseEnvValue } from "../src/index.js";
import type { SourceInput } from "../src/types.js";

const SCHEMA = loadSchema(
  'syntax = "pcl/1"; message M { string host = 1; int32 port = 2 [default = 8080]; repeated string tags = 3; Tls tls = 4; } message Tls { string cert = 1; bool skip_verify = 2; }',
);

function src(data: Record<string, unknown>): SourceInput {
  return { name: "config.json", data };
}

describe("parseEnvValue", () => {
  test("integer parsing", () => {
    expect(parseEnvValue("42", "integer")).toBe(42);
    expect(parseEnvValue("-7", "integer")).toBe(-7);
    expect(() => parseEnvValue("4.5", "integer")).toThrow(/integer/);
    expect(() => parseEnvValue("abc", "integer")).toThrow(/integer/);
  });

  test("number parsing", () => {
    expect(parseEnvValue("3.25", "number")).toBe(3.25);
    expect(() => parseEnvValue("x", "number")).toThrow(/number/);
  });

  test("boolean parsing is strict", () => {
    expect(parseEnvValue("true", "boolean")).toBe(true);
    expect(parseEnvValue("false", "boolean")).toBe(false);
    expect(() => parseEnvValue("yes", "boolean")).toThrow(/true or false/);
  });

  test("json parsing for message fields", () => {
    expect(parseEnvValue('{"cert":"c.pem"}', "json")).toEqual({ cert: "c.pem" });
    expect(() => parseEnvValue("{nope", "json")).toThrow(/JSON/);
  });
});

describe("envSource", () => {
  test("prefix and nesting path derivation", () => {
    const input = envSource(SCHEMA, {
      PCL_HOST: "h.example.com",
      PCL_TLS__CERT: "c.pem",
    });
    const r = loadConfig({ schema: SCHEMA, sources: [input] });
    expect(r.ok && r.value).toEqual({
      host: "h.example.com",
      port: 8080,
      tags: [],
      tls: { cert: "c.pem", skip_verify: false },
    });
  });

  test("repeated fields split on commas", () => {
    const input = envSource(SCHEMA, { PCL_TAGS: "a,b , c" });
    const r = loadConfig({ schema: SCHEMA, sources: [input] });
    expect(r.ok && r.value).toEqual({
      host: "",
      port: 8080,
      tags: ["a", "b", "c"],
    });
  });

  test("unrelated variables are ignored with the default prefix", () => {
    const input = envSource(SCHEMA, { PATH: "/usr/bin", PCL_HOST: "h" });
    expect(input.issues ?? []).toHaveLength(0);
  });

  test("unknown PCL_ variable produces UNKNOWN_FIELD with env source", () => {
    const input = envSource(SCHEMA, { PCL_NOPE: "1" });
    const r = loadConfig({ schema: SCHEMA, sources: [input] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0]?.code).toBe("UNKNOWN_FIELD");
      expect(r.issues[0]?.path).toBe("PCL_NOPE");
      expect(r.issues[0]?.source).toBe("env");
    }
  });

  test("bad scalar value produces TYPE_MISMATCH with the env key as path", () => {
    const input = envSource(SCHEMA, { PCL_PORT: "not-a-number" });
    const r = loadConfig({ schema: SCHEMA, sources: [input] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0]?.code).toBe("TYPE_MISMATCH");
      expect(r.issues[0]?.path).toBe("PCL_PORT");
    }
  });

  test("intermediate segments that are not messages fail cleanly", () => {
    const input = envSource(SCHEMA, { PCL_TLS__CERT__EXTRA: "x" });
    const r = loadConfig({ schema: SCHEMA, sources: [input] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.code).toBe("UNKNOWN_FIELD");
  });

  test("custom prefix", () => {
    const input = envSource(SCHEMA, { APP_HOST: "h" }, { prefix: "APP_" });
    const r = loadConfig({ schema: SCHEMA, sources: [input] });
    expect(r.ok && r.value).toEqual({
      host: "h",
      port: 8080,
      tags: [],
    });
  });
});

describe("env precedence", () => {
  test("file source wins over env when listed last", () => {
    const env = envSource(SCHEMA, { PCL_PORT: "9090" });
    const r = loadConfig({ schema: SCHEMA, sources: [env, src({ port: 7070 })] });
    expect(r.ok && (r.value as Record<string, unknown>).port).toBe(7070);
  });

  test("env wins over schema defaults", () => {
    const env = envSource(SCHEMA, { PCL_PORT: "9090" });
    const r = loadConfig({ schema: SCHEMA, sources: [env] });
    expect(r.ok && (r.value as Record<string, unknown>).port).toBe(9090);
  });
});