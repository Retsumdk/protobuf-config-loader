import { describe, test, expect } from "bun:test";
import { parseSchema, loadSchema } from "../src/parser.js";
import { PclError } from "../src/errors.js";
import { DEMO_SCHEMA } from "../src/demo.js";
import type { FieldDef, MessageDef } from "../src/types.js";

function fields(text: string): Map<string, FieldDef> {
  const schema = parseSchema(text);
  const msg: MessageDef = schema.messages[0]!;
  return new Map(msg.fields.map((f) => [f.name, f]));
}

describe("lexer", () => {
  test("line comments are skipped", () => {
    const schema = parseSchema("// leading\nsyntax = \"pcl/1\"; // trailing\nmessage M { string a = 1; }");
    expect(schema.syntax).toBe("pcl/1");
    expect(schema.messages).toHaveLength(1);
  });

  test("block comments are skipped", () => {
    const schema = parseSchema("/* multi\nline */ syntax = \"pcl/1\"; message M { string a = 1; }");
    expect(schema.syntax).toBe("pcl/1");
  });

  test("unterminated block comment fails with position", () => {
    expect(() => parseSchema("/* nope")).toThrow(PclError);
  });

  test("string escapes decode", () => {
    const f = fields(`message M { string a = 1 [default = "x\\ny\\t\\x41\\\\\\"q"]; }`);
    expect(f.get("a")?.defaultValue).toEqual({ kind: "string", value: 'x\ny\tA\\"q' });
  });

  test("unterminated string fails", () => {
    expect(() => parseSchema('message M { string a = 1 [default = "oops]; }')).toThrow(/unterminated string/);
  });

  test("hex and negative numbers tokenize", () => {
    const f = fields('message M { int32 a = 1 [default = 0x10]; int32 b = 2 [default = -7]; }');
    expect(f.get("a")?.defaultValue).toEqual({ kind: "number", value: 16 });
    expect(f.get("b")?.defaultValue).toEqual({ kind: "number", value: -7 });
  });
});

describe("schema language", () => {
  test("syntax header is validated", () => {
    expect(parseSchema('syntax = "pcl/1"; message M {}').syntax).toBe("pcl/1");
    expect(() => parseSchema('syntax = "proto9";')).toThrow(/unsupported syntax/);
  });

  test("duplicate syntax header fails", () => {
    expect(() => parseSchema('syntax = "pcl/1"; syntax = "pcl/1";')).toThrow(/duplicate syntax/);
  });

  test("package is captured", () => {
    expect(parseSchema('package acme.config; message M {}').package).toBe("acme.config");
  });

  test("full field form parses", () => {
    const f = fields('message M { required int32 port = 2 [default = 8080, deprecated = true]; }');
    const port = f.get("port")!;
    expect(port.cardinality).toBe("required");
    expect(port.number).toBe(2);
    expect(port.deprecated).toBe(true);
    expect(port.defaultValue).toEqual({ kind: "number", value: 8080 });
  });

  test("repeated and map cardinalities parse", () => {
    const f = fields('message M { repeated string tags = 1; map<string, int32> limits = 2; }');
    expect(f.get("tags")?.cardinality).toBe("repeated");
    expect(f.get("limits")?.mapKey).toBe("string");
    expect(f.get("limits")?.mapValue).toBe("int32");
  });

  test("nested messages get qualified fullNames", () => {
    const schema = parseSchema('message A { message B { string x = 1; } B b = 1; }');
    const b = schema.messages.find((m) => m.name === "B");
    expect(b?.fullName).toBe("A.B");
  });

  test("doubly nested fullName chain", () => {
    const schema = parseSchema('message A { message B { message C { bool ok = 1; } C c = 1; } B b = 1; }');
    const c = schema.messages.find((m) => m.name === "C");
    expect(c?.fullName).toBe("A.B.C");
  });

  test("enums parse with values and allow_alias", () => {
    const schema = parseSchema('enum Level { option allow_alias = true; LOW = 0; MED = 1; HIGH = 2; ALSO_HIGH = 2; }');
    const e = schema.enums[0]!;
    expect(e.allowAlias).toBe(true);
    expect(e.values.map((v) => v.number)).toEqual([0, 1, 2, 2]);
    expect(e.values[3]?.name).toBe("ALSO_HIGH");
  });

  test("duplicate enum number without allow_alias fails", () => {
    expect(() => parseSchema('enum E { A = 0; B = 0; }')).toThrow(/duplicate enum number/);
  });

  test("enum aliases permitted with allow_alias", () => {
    expect(() => parseSchema('enum E { option allow_alias = true; A = 0; B = 0; }')).not.toThrow();
  });

  test("enum first value must be zero", () => {
    expect(() => parseSchema('enum E { A = 1; B = 2; }')).toThrow(/first enum value/);
  });

  test("duplicate field names fail", () => {
    expect(() => parseSchema('message M { string a = 1; string a = 2; }')).toThrow(/duplicate field name/);
  });

  test("duplicate field numbers fail", () => {
    expect(() => parseSchema('message M { string a = 1; string b = 1; }')).toThrow(/duplicate field number/);
  });

  test("duplicate oneof names fail", () => {
    expect(() => parseSchema('message M { oneof c { string a = 1; } oneof c { string b = 2; } }')).toThrow(/duplicate oneof name/);
  });

  test("oneof fields reject explicit cardinality", () => {
    expect(() => parseSchema('message M { oneof c { required string a = 1; } }')).toThrow(/Oneof fields cannot/);
  });

  test("field number must be positive", () => {
    expect(() => parseSchema('message M { string a = 0; }')).toThrow(/positive field number/);
  });

  test("field number must fit 29 bits", () => {
    expect(() => parseSchema('message M { string a = 536870912; }')).toThrow(/too large/);
  });

  test("protobuf reserved range 19000-19999 is rejected", () => {
    expect(() => parseSchema('message M { string a = 19500; }')).toThrow(/reserved for the protobuf implementation/);
  });

  test("negative default on unsigned field fails", () => {
    expect(() => parseSchema('message M { uint32 a = 1 [default = -1]; }')).toThrow(/negative default/);
  });

  test("boolean default must be true or false", () => {
    expect(() => parseSchema('message M { bool a = 1 [default = TRUE]; }')).toThrow(/boolean default must be/);
  });

  test("map field with message value type resolves", () => {
    const schema = parseSchema('message A { string x = 1; } message M { map<string, A> items = 1; }');
    const schema2 = parseSchema('message A { string x = 1; } message M { map<string, A> items = 1; }');
    expect(schema2.messages).toHaveLength(2);
    expect(schema.messages[1]!.fields[0]!.mapValue).toBe("A");
  });

  test("unknown type reference fails at resolve", () => {
    expect(() => loadSchema('message M { Missing a = 1; }')).toThrow(/unknown type/);
  });

  test("empty file fails", () => {
    expect(() => parseSchema("   \n  ")).toThrow(/empty schema/);
  });

  test("missing semicolon fails with position", () => {
    expect(() => parseSchema('message M { string a = 1 }')).toThrow(/expected ';'/);
  });

  test("keywords cannot be field names", () => {
    expect(() => parseSchema('message M { string message = 1; }')).toThrow(/reserved keyword/);
  });

  test("root inference picks top-level message without message-typed fields", () => {
    const schema = parseSchema('message Leaf { string a = 1; } message Top { Leaf leaf = 1; }');
    expect(schema.root).toBe("Leaf");
  });
});

describe("loadSchema entry", () => {
  test("throws PCL_SCHEMA_PARSE on bad input", () => {
    try {
      loadSchema("nope");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PclError);
      expect((error as PclError).code).toBe("PCL_SCHEMA_PARSE");
    }
  });

  test("accepts the demo schema", () => {
    const schema = loadSchema(DEMO_SCHEMA);
    expect(schema.messages.map((m) => m.name)).toContain("ServiceConfig");
  });
});
