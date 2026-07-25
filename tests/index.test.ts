import { describe, test, expect } from "bun:test";
describe("protobuf-config-loader", () => {
  test("module loads", async () => { const m = await import("./index"); expect(m).toBeDefined(); });
});
