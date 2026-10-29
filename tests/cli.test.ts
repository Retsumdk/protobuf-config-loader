import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEMO_OUTPUT, DEMO_SCHEMA } from "../src/demo.js";
import { VERSION } from "../src/version.js";

const BIN = join(import.meta.dir, "..", "bin", "pcl.js");

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pcl-cli-"));
  writeFileSync(join(dir, "svc.proto"), DEMO_SCHEMA);
  writeFileSync(
    join(dir, "ok.json"),
    '{"host":"api.example.com","port":9090,"tags":["edge"],"tls":{"cert":"/etc/c.pem","key":"/etc/k.pem"}}',
  );
  writeFileSync(join(dir, "bad.json"), '{"host":42}');
  writeFileSync(join(dir, "bad2.json"), '{"tls":{"cert":"/etc/c.pem"}}');
  writeFileSync(join(dir, "tls.json"), '{"cert":"/etc/c.pem","key":"/etc/k.pem"}');
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", BIN, ...args], { cwd: dir });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("pcl validate", () => {
  test("valid config exits 0", () => {
    const r = run(["validate", "--schema", "svc.proto", "ok.json"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK");
    expect(r.stdout).toContain("fleet.ServiceConfig");
  });

  test("invalid config exits 4 with sorted issue lines on stderr", () => {
    const r = run(["validate", "--schema", "svc.proto", "bad.json"]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("TYPE_MISMATCH");
    expect(r.stderr).toContain("$.host");
    expect(r.stderr).toContain("expected string, got integer");
    expect(r.stderr).toContain("validation failed with");
  });

  test("missing required nested field reported with path", () => {
    const r = run(["validate", "--schema", "svc.proto", "bad2.json"]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("MISSING_REQUIRED");
    expect(r.stderr).toContain("$.tls.key");
  });

  test("schema path can be passed as the only positional", () => {
    const r = run(["validate", "svc.proto", "ok.json"]);
    expect(r.code).toBe(0);
  });

  test("--root overrides the root message", () => {
    const r = run(["validate", "--schema", "svc.proto", "--root", "Tls", "tls.json"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("'fleet.Tls'");
  });

  test("missing config file exits 5 (I/O)", () => {
    const r = run(["validate", "--schema", "svc.proto", "absent.json"]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain("PCL_IO");
    expect(r.stderr).toContain("cannot read config file");
  });

  test("malformed schema exits 3", () => {
    writeFileSync(join(dir, "broken.proto"), "message M { string a = ; }");
    const r = run(["validate", "--schema", "broken.proto", "ok.json"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("PCL_SCHEMA_PARSE");
  });
});

describe("pcl print", () => {
  test("prints resolved JSON with defaults applied", () => {
    const r = run(["print", "--schema", "svc.proto", "ok.json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed["port"]).toBe(9090);
    expect(parsed["verbose"]).toBe(false);
    expect(parsed["api_key"]).toBe("");
    expect(parsed["tls"]).toEqual({ cert: "/etc/c.pem", key: "/etc/k.pem", skip_verify: false });
  });

  test("invalid config exits 4", () => {
    const r = run(["print", "--schema", "svc.proto", "bad.json"]);
    expect(r.code).toBe(4);
  });
});

describe("pcl schema", () => {
  test("summarizes messages and fields", () => {
    const r = run(["schema", "--schema", "svc.proto"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("message fleet.ServiceConfig");
    expect(r.stdout).toContain("oneof auth");
    expect(r.stdout).toContain("default = 8080");
  });
});

describe("pcl demo", () => {
  test("demo output is byte-identical to the checked-in constant", () => {
    const r = run(["demo"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${DEMO_OUTPUT}\n`);
  });

  test("demo-schema prints the demo schema", () => {
    const r = run(["demo-schema"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(DEMO_SCHEMA);
  });
});

describe("pcl meta commands", () => {
  test("version", () => {
    const r = run(["version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`pcl ${VERSION}\n`);
  });

  test("help exits 0 and lists commands", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("validate");
    expect(r.stdout).toContain("print");
    expect(r.stdout).toContain("demo");
  });

  test("no arguments shows help", () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage");
  });

  test("unknown command exits 2", () => {
    const r = run(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unknown command");
  });

  test("unknown option exits 2", () => {
    const r = run(["validate", "--wat"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown option");
  });

  test("missing arguments exit 2", () => {
    const r = run(["validate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("required");
  });
});