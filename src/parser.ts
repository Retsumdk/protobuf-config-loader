import { PclError } from "./errors.js";
import {
  isMapKeyType,
  isScalarType,
  type Cardinality,
  type EnumDef,
  type EnumValueDef,
  type FieldDef,
  type Literal,
  type MessageDef,
  type OneofDef,
  type Schema,
} from "./types.js";

const MAX_FIELD_NUMBER = 536870911;
const PROTO_RESERVED_RANGE_START = 19000;
const PROTO_RESERVED_RANGE_END = 19999;
const RESERVED_NAMES = new Set([
  "message", "enum", "oneof", "map", "repeated", "optional", "required",
  "reserved", "option", "syntax", "package", "import", "extend", "extensions", "group",
]);

interface Token {
  kind: "ident" | "number" | "string" | "punct";
  value: string;
  line: number;
  col: number;
}

interface SchemaRef {
  messages: Map<string, MessageDef>;
  enums: Map<string, EnumDef>;
}

export interface ParseOptions {
  fileName?: string;
}

class Lexer {
  private pos = 0;
  private line = 1;
  private col = 1;

  constructor(
    private readonly src: string,
    private readonly fileName: string,
  ) {}

  private fail(message: string, line: number, col: number): never {
    throw new PclError("PCL_SCHEMA_PARSE", `${this.fileName}:${line}:${col}: ${message}`);
  }

  private peekChar(): string {
    return this.src[this.pos] ?? "";
  }

  private advance(): string {
    const ch = this.src[this.pos] ?? "";
    this.pos += 1;
    if (ch === "\n") {
      this.line += 1;
      this.col = 1;
    } else {
      this.col += 1;
    }
    return ch;
  }

  private skipTrivia(): void {
    for (;;) {
      const ch = this.peekChar();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.advance();
        continue;
      }
      if (ch === "/" && this.src[this.pos + 1] === "/") {
        while (this.pos < this.src.length && this.peekChar() !== "\n") this.advance();
        continue;
      }
      if (ch === "/" && this.src[this.pos + 1] === "*") {
        const startLine = this.line;
        const startCol = this.col;
        this.advance();
        this.advance();
        let closed = false;
        while (this.pos < this.src.length) {
          if (this.peekChar() === "*" && this.src[this.pos + 1] === "/") {
            this.advance();
            this.advance();
            closed = true;
            break;
          }
          this.advance();
        }
        if (!closed) this.fail("unterminated block comment", startLine, startCol);
        continue;
      }
      break;
    }
  }

  private readString(quote: string, line: number, col: number): Token {
    this.advance();
    let out = "";
    for (;;) {
      if (this.pos >= this.src.length) this.fail("unterminated string literal", line, col);
      const ch = this.advance();
      if (ch === quote) break;
      if (ch === "\n") this.fail("unterminated string literal", line, col);
      if (ch === "\\") {
        if (this.pos >= this.src.length) this.fail("unterminated escape sequence", this.line, this.col);
        const esc = this.advance();
        switch (esc) {
          case "n": out += "\n"; break;
          case "t": out += "\t"; break;
          case "r": out += "\r"; break;
          case "\\": out += "\\"; break;
          case "'": out += "'"; break;
          case '"': out += '"'; break;
          case "0": out += "\0"; break;
          case "x": {
            const hex = this.src.slice(this.pos, this.pos + 2);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
              this.fail(`invalid \\x escape (need two hex digits)`, this.line, this.col);
            }
            this.advance();
            this.advance();
            out += String.fromCharCode(parseInt(hex, 16));
            break;
          }
          default:
            this.fail(`unknown escape sequence \\${esc}`, this.line, this.col);
        }
        continue;
      }
      out += ch;
    }
    return { kind: "string", value: out, line, col };
  }

  private readNumber(line: number, col: number): Token {
    let out = "";
    if (this.peekChar() === "-") out += this.advance();
    const digits = /[0-9a-fA-FxX_.]/;
    for (;;) {
      const ch = this.peekChar();
      if (ch === "_") {
        this.advance();
        continue;
      }
      if (digits.test(ch)) {
        if (ch === "." && out.includes(".")) break;
        out += this.advance();
        continue;
      }
      if (/[eE]/.test(ch) && /\d/.test(out) && !/[xX][0-9a-fA-F]*$/.test(out)) {
        const nextCh = this.src[this.pos + 1] ?? "";
        const consumed = /[eE]/.test(ch) ? this.advance() : "";
        out += consumed;
        if (nextCh === "+" || nextCh === "-") out += this.advance();
        continue;
      }
      break;
    }
    if (out === "" || out === ".") this.fail("invalid number", line, col);
    return { kind: "number", value: out, line, col };
  }

  private readIdent(line: number, col: number): Token {
    let out = "";
    while (this.pos < this.src.length && /[A-Za-z0-9_.]/.test(this.peekChar())) {
      out += this.advance();
    }
    return { kind: "ident", value: out, line, col };
  }

  next(): Token | undefined {
    this.skipTrivia();
    if (this.pos >= this.src.length) return undefined;
    const line = this.line;
    const col = this.col;
    const ch = this.peekChar();
    if (ch === '"' || ch === "'") return this.readString(ch, line, col);
    const nextChar = this.src[this.pos + 1] ?? "";
    if (
      /[0-9]/.test(ch) ||
      (ch === "." && /[0-9]/.test(nextChar)) ||
      (ch === "-" && /[0-9.]/.test(nextChar))
    ) {
      return this.readNumber(line, col);
    }
    if (/[A-Za-z_]/.test(ch)) return this.readIdent(line, col);
    if ("{}[]()<>[]=;,.".includes(ch)) {
      this.advance();
      return { kind: "punct", value: ch, line, col };
    }
    this.fail(`unexpected character ${JSON.stringify(ch)}`, line, col);
  }
}

class Parser {
  private tokens: Token[] = [];
  private idx = 0;
  private syntax = "pcl/1";
  private readonly messages = new Map<string, MessageDef>();
  private readonly enums = new Map<string, EnumDef>();

  constructor(
    private readonly src: string,
    private readonly fileName: string,
  ) {
    const lexer = new Lexer(src, fileName);
    for (;;) {
      const tok = lexer.next();
      if (!tok) break;
      this.tokens.push(tok);
    }
  }

  private fail(message: string, tok?: Token): never {
    const line = tok?.line ?? 0;
    const col = tok?.col ?? 0;
    throw new PclError("PCL_SCHEMA_PARSE", `${this.fileName}:${line}:${col}: ${message}`);
  }

  private peek(): Token | undefined {
    return this.tokens[this.idx];
  }

  private next(): Token | undefined {
    const tok = this.tokens[this.idx];
    if (tok) this.idx += 1;
    return tok;
  }

  private expectPunct(p: string, what: string): Token {
    const tok = this.next();
    if (!tok) this.fail(`expected ${what} but reached end of file`);
    if (tok.kind !== "punct" || tok.value !== p) {
      this.fail(`expected ${what} ('${p}') but found ${describeToken(tok)}`, tok);
    }
    return tok;
  }

  private expectIdent(what: string): Token {
    const tok = this.next();
    if (!tok) this.fail(`expected ${what} but reached end of file`);
    if (tok.kind !== "ident") {
      this.fail(`expected ${what} but found ${describeToken(tok)}`, tok);
    }
    return tok;
  }

  private expectKeyword(word: string): void {
    const tok = this.next();
    if (!tok || tok.kind !== "ident" || tok.value !== word) {
      this.fail(`expected '${word}' but found ${describeToken(tok)}`, tok);
    }
  }

  private acceptKeyword(word: string): boolean {
    const tok = this.peek();
    if (tok && tok.kind === "ident" && tok.value === word) {
      this.idx += 1;
      return true;
    }
    return false;
  }

  private acceptPunct(p: string): boolean {
    const tok = this.peek();
    if (tok && tok.kind === "punct" && tok.value === p) {
      this.idx += 1;
      return true;
    }
    return false;
  }

  parse(): Schema {
    let syntax = "pcl/1";
    let syntaxSeen = false;
    let packageName: string | undefined;

    while (this.peek()) {
      const tok = this.peek();
      if (!tok) break;
      if (tok.kind === "punct" && tok.value === ";") {
        this.next();
        continue;
      }
      if (tok.kind !== "ident") {
        this.fail(`expected a declaration but found ${describeToken(tok)}`, tok);
      }
      switch (tok.value) {
        case "syntax": {
          this.next();
          this.expectPunct("=", "':' after syntax");
          const val = this.next();
          if (!val || val.kind !== "string") this.fail("expected syntax string literal", val);
          if (val.value !== "proto3" && val.value !== "pcl/1") {
            this.fail(`unsupported syntax ${JSON.stringify(val.value)} (expected "proto3" or "pcl/1")`, val);
          }
          if (syntaxSeen) this.fail("duplicate syntax declaration", tok);
          syntaxSeen = true;
          this.syntax = val.value;
          syntax = val.value;
          this.expectPunct(";", "';' after syntax");
          break;
        }
        case "package": {
          this.next();
          const name = this.expectIdent("package name");
          if (packageName) this.fail("duplicate package declaration", tok);
          packageName = name.value;
          this.expectPunct(";", "';' after package");
          break;
        }
        case "import": {
          this.next();
          const val = this.next();
          if (!val || val.kind !== "string") this.fail("expected import path string", val);
          this.expectPunct(";", "';' after import");
          break;
        }
        case "option": {
          this.skipOption();
          break;
        }
        case "message": {
          this.parseMessage(packageName, undefined);
          break;
        }
        case "enum": {
          this.parseEnum(packageName, undefined);
          break;
        }
        default:
          this.fail(`expected a declaration (syntax/package/message/enum) but found '${tok.value}'`, tok);
      }
    }

    if (this.messages.size === 0 && this.enums.size === 0) {
      this.fail(`${this.fileName}: empty schema (no messages or enums)`, this.tokens[0]);
    }
    const [root] = [...this.messages.keys()];
    const schema: Schema = {
      syntax,
      fileName: this.fileName,
      messages: [...this.messages.values()],
      enums: [...this.enums.values()],
      root: root ?? "",
      reservedNames: new Map(),
      reservedNumbers: new Map(),
    };
    if (packageName !== undefined) schema.package = packageName;
    schema.reservedNames = this.reservedNames;
    schema.reservedNumbers = this.reservedNumbers;
    return schema;
  }

  private reservedNames = new Map<string, Set<string>>();
  private reservedNumbers = new Map<string, Set<number>>();

  private skipOption(): void {
    this.expectKeyword("option");
    for (;;) {
      const tok = this.next();
      if (!tok) this.fail("unterminated option (missing ';')");
      if (tok.kind === "punct" && tok.value === ";") return;
    }
  }

  private parseFullName(packageName: string | undefined, name: string): string {
    return packageName ? `${packageName}.${name}` : name;
  }

  private parseMessage(packageName: string | undefined, container: string | undefined): void {
    this.expectKeyword("message");
    const nameTok = this.expectIdent("message name");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nameTok.value)) {
      this.fail(`invalid message name '${nameTok.value}'`, nameTok);
    }
    const fullName = container
      ? `${container}.${nameTok.value}`
      : this.parseFullName(packageName, nameTok.value);
    if (this.messages.has(fullName)) this.fail(`duplicate message '${fullName}'`, nameTok);
    if (this.enums.has(fullName)) this.fail(`name '${fullName}' already used by an enum`, nameTok);

    const message: MessageDef = { name: nameTok.value, fullName, fields: [], oneofs: [] };
    this.messages.set(fullName, message);

    this.expectPunct("{", "'{' to open message body");
    for (;;) {
      const tok = this.peek();
      if (!tok) this.fail(`unterminated message '${fullName}'`);
      if (tok.kind === "punct" && tok.value === "}") {
        this.next();
        return;
      }
      if (tok.kind === "punct" && tok.value === ";") {
        this.next();
        continue;
      }
      if (tok.kind !== "ident") {
        this.fail(`expected a field or declaration but found ${describeToken(tok)}`, tok);
      }
      switch (tok.value) {
        case "message":
          this.parseMessage(packageName, fullName);
          break;
        case "enum":
          this.parseEnum(packageName, fullName);
          break;
        case "option":
          this.skipOption();
          break;
        case "reserved":
          this.parseReserved(fullName);
          break;
        case "oneof":
          this.parseOneof(fullName, message);
          break;
        case "map":
          this.parseMapField(fullName, message);
          this.expectPunct(";", "';' after map field");
          break;
        default:
          message.fields.push(this.parseField(fullName, message));
          this.expectPunct(";", "';' after field");
          break;
      }
    }
  }

  private checkFieldUniqueness(fullName: string, field: FieldDef, tok: Token): void {
    const msg = this.messages.get(fullName);
    if (!msg) return;
    for (const existing of msg.fields) {
      if (existing.name === field.name) {
        this.fail(`duplicate field name '${field.name}' in message '${fullName}'`, tok);
      }
      if (existing.number === field.number) {
        this.fail(`duplicate field number ${field.number} in message '${fullName}'`, tok);
      }
    }
    for (const oneof of msg.oneofs) {
      for (const existing of oneof.fields) {
        if (existing.name === field.name) {
          this.fail(`duplicate field name '${field.name}' in message '${fullName}'`, tok);
        }
        if (existing.number === field.number) {
          this.fail(`duplicate field number ${field.number} in message '${fullName}'`, tok);
        }
      }
    }
    const reserved = this.reservedNames.get(fullName);
    if (reserved?.has(field.name)) {
      this.fail(`field name '${field.name}' is reserved in message '${fullName}'`, tok);
    }
    const reservedNums = this.reservedNumbers.get(fullName);
    if (reservedNums?.has(field.number)) {
      this.fail(`field number ${field.number} is reserved in message '${fullName}'`, tok);
    }
  }

  private validateFieldNumber(num: number, fullName: string, tok: Token): void {
    if (!Number.isInteger(num) || num < 1) {
      this.fail(`positive field number required in message '${fullName}'`, tok);
    }
    if (num > MAX_FIELD_NUMBER) {
      this.fail(`field number ${num} too large (max ${MAX_FIELD_NUMBER}) in message '${fullName}'`, tok);
    }
    if (num >= PROTO_RESERVED_RANGE_START && num <= PROTO_RESERVED_RANGE_END) {
      this.fail(`field number ${num} is reserved for the protobuf implementation (19000-19999)`, tok);
    }
  }

  private parseCardinality(): Cardinality {
    if (this.acceptKeyword("optional")) return "optional";
    if (this.acceptKeyword("required")) return "required";
    if (this.acceptKeyword("repeated")) return "repeated";
    return "plain";
  }

  private parseField(fullName: string, msg: MessageDef, forcedCardinality?: Cardinality): FieldDef {
    const start = this.peek();
    const cardinality = forcedCardinality ?? this.parseCardinality();
    const typeTok = this.expectIdent("field type");
    const nameTok = this.expectIdent("field name");
    if (RESERVED_NAMES.has(nameTok.value)) {
      this.fail(`reserved keyword '${nameTok.value}' cannot be used as a field name`, nameTok);
    }
    this.expectPunct("=", "'=' before field number");
    const numTok = this.peek();
    const number = this.parseFieldNumber(fullName);
    this.validateFieldNumber(number, fullName, numTok ?? start ?? nameTok);
    const field: FieldDef = {
      name: nameTok.value,
      number,
      type: typeTok.value,
      cardinality,
    };
    const options = this.parseFieldOptions(fullName, field);
    if (options?.default) field.defaultValue = options.default;
    if (options?.deprecated) field.deprecated = true;
    this.checkFieldUniqueness(fullName, field, nameTok);
    return field;
  }

  private parseFieldNumber(fullName: string): number {
    let negative = false;
    if (this.acceptPunct("-")) negative = true;
    const tok = this.next();
    if (!tok || tok.kind !== "number") {
      this.fail(`expected field number in message '${fullName}' but found ${describeToken(tok)}`, tok);
    }
    const parsed = interpretNumber(tok.value, tok);
    if (typeof parsed !== "number" || !Number.isInteger(parsed)) {
      this.fail(`field number must be an integer`, tok);
    }
    return negative ? -parsed : parsed;
  }

  private parseMapField(fullName: string, msg: MessageDef): void {
    this.expectKeyword("map");
    this.expectPunct("<", "'<' to open map key type");
    const keyTok = this.expectIdent("map key type");
    if (!isMapKeyType(keyTok.value)) {
      this.fail(`invalid map key type '${keyTok.value}'`, keyTok);
    }
    this.expectPunct(",", "',' between map key and value types");
    const valTok = this.expectIdent("map value type");
    this.expectPunct(">", "'>' to close map type");
    const nameTok = this.expectIdent("field name");
    this.expectPunct("=", "'=' before field number");
    const numTok = this.peek();
    const number = this.parseFieldNumber(fullName);
    this.validateFieldNumber(number, fullName, numTok ?? nameTok);
    const field: FieldDef = {
      name: nameTok.value,
      number,
      type: "map",
      cardinality: "repeated",
      mapKey: keyTok.value,
      mapValue: valTok.value,
    };
    const options = this.parseFieldOptions(fullName, field);
    if (options?.default) field.defaultValue = options.default;
    if (options?.deprecated) field.deprecated = true;
    this.checkFieldUniqueness(fullName, field, nameTok);
    msg.fields.push(field);
  }

  private parseFieldOptions(fullName: string, field: FieldDef): { default?: Literal; deprecated?: boolean } | undefined {
    if (!this.acceptPunct("[")) return undefined;
    const result: { default?: Literal; deprecated?: boolean } = {};
    for (;;) {
      const key = this.expectIdent("option name");
      this.expectPunct("=", "'=' after option name");
      if (key.value === "default") {
        if (field.type === "map") {
          this.fail("map fields cannot have a default value", key);
        }
        result.default = this.parseLiteral();
      } else if (key.value === "deprecated") {
        const val = this.next();
        if (!val || val.kind !== "ident" || (val.value !== "true" && val.value !== "false")) {
          this.fail("deprecated option expects true or false", val);
        }
        if (val.value === "true") result.deprecated = true;
      } else {
        this.parseLiteral();
      }
      if (this.acceptPunct("]")) return result;
      this.expectPunct(",", "',' between field options");
    }
  }

  private parseLiteral(): Literal {
    const sign = this.acceptPunct("-") ? -1 : 1;
    const tok = this.next();
    if (!tok) this.fail("expected literal value");
    if (tok.kind === "string") {
      if (sign === -1) this.fail("cannot negate a string literal", tok);
      return { kind: "string", value: tok.value };
    }
    if (tok.kind === "number") {
      const num = interpretNumber(tok.value, tok);
      if (typeof num !== "number") this.fail("invalid numeric literal", tok);
      return { kind: "number", value: sign * num };
    }
    if (tok.kind === "ident") {
      if (tok.value === "true") return { kind: "bool", value: true };
      if (tok.value === "false") return { kind: "bool", value: false };
      if (tok.value === "inf" || tok.value === "nan") {
        if (sign === -1 && tok.value === "inf") return { kind: "number", value: -Infinity };
        return { kind: "number", value: tok.value === "inf" ? Infinity : NaN };
      }
      if (sign === -1) this.fail("cannot negate an identifier literal", tok);
      return { kind: "identifier", value: tok.value };
    }
    this.fail(`expected literal value but found ${describeToken(tok)}`, tok);
  }

  private parseOneof(fullName: string, msg: MessageDef): void {
    this.expectKeyword("oneof");
    const nameTok = this.expectIdent("oneof name");
    for (const existing of msg.oneofs) {
      if (existing.name === nameTok.value) {
        this.fail(`duplicate oneof name '${nameTok.value}' in message '${fullName}'`, nameTok);
      }
    }
    const oneof: OneofDef = { name: nameTok.value, fields: [] };
    msg.oneofs.push(oneof);
    this.expectPunct("{", "'{' to open oneof body");
    for (;;) {
      const tok = this.peek();
      if (!tok) this.fail(`unterminated oneof '${nameTok.value}'`);
      if (tok.kind === "punct" && tok.value === "}") {
        this.next();
        return;
      }
      if (tok.kind === "punct" && tok.value === ";") {
        this.next();
        continue;
      }
      if (tok.kind === "ident" && ["optional", "required", "repeated"].includes(tok.value)) {
        this.fail(`Oneof fields cannot have explicit cardinality ('${tok.value}')`, tok);
      }
      if (tok.kind === "ident" && tok.value === "option") {
        this.skipOption();
        continue;
      }
      const field = this.parseFieldInOneof(fullName, oneof);
      oneof.fields.push(field);
      this.expectPunct(";", "';' after oneof field");
    }
  }

  private parseFieldInOneof(fullName: string, oneof: OneofDef): FieldDef {
    const typeTok = this.expectIdent("field type");
    const nameTok = this.expectIdent("field name");
    this.expectPunct("=", "'=' before field number");
    const number = this.parseFieldNumber(fullName);
    this.validateFieldNumber(number, fullName, nameTok);
    const field: FieldDef = {
      name: nameTok.value,
      number,
      type: typeTok.value,
      cardinality: "optional",
    };
    const msg = this.messages.get(fullName);
    if (msg) {
      const all = [...msg.fields, ...msg.oneofs.flatMap((o) => o.fields)];
      for (const existing of all) {
        if (existing.name === field.name) {
          this.fail(`duplicate field name '${field.name}' in message '${fullName}'`, nameTok);
        }
        if (existing.number === field.number) {
          this.fail(`duplicate field number ${field.number} in message '${fullName}'`, nameTok);
        }
      }
      const reserved = this.reservedNames.get(fullName);
      if (reserved?.has(field.name)) {
        this.fail(`field name '${field.name}' is reserved in message '${fullName}'`, nameTok);
      }
      const reservedNums = this.reservedNumbers.get(fullName);
      if (reservedNums?.has(field.number)) {
        this.fail(`field number ${field.number} is reserved in message '${fullName}'`, nameTok);
      }
    }
    const options = this.parseFieldOptions(fullName, field);
    if (options?.default) {
      this.fail(`oneof field '${field.name}' cannot declare a default value`, nameTok);
    }
    if (options?.deprecated) field.deprecated = true;
    return field;
  }

  private parseReserved(fullName: string): void {
    this.expectKeyword("reserved");
    if (!this.reservedNames.has(fullName)) this.reservedNames.set(fullName, new Set());
    if (!this.reservedNumbers.has(fullName)) this.reservedNumbers.set(fullName, new Set());
    const names = this.reservedNames.get(fullName) as Set<string>;
    const numbers = this.reservedNumbers.get(fullName) as Set<number>;
    const first = this.peek();
    if (first?.kind === "string") {
      for (;;) {
        const tok = this.next();
        if (!tok || tok.kind !== "string") this.fail("expected reserved name string", tok);
        names.add(tok.value);
        if (this.acceptPunct(",")) continue;
        this.expectPunct(";", "';' after reserved names");
        return;
      }
    }
    for (;;) {
      const loTok = this.next();
      if (!loTok || loTok.kind !== "number") this.fail("expected reserved number or range", loTok);
      const lo = interpretNumber(loTok.value, loTok);
      if (typeof lo !== "number" || !Number.isInteger(lo)) this.fail("invalid reserved number", loTok);
      let hi = lo;
      if (this.acceptKeyword("to")) {
        const maxTok = this.peek();
        if (maxTok?.kind === "ident" && maxTok.value === "max") {
          this.next();
          hi = MAX_FIELD_NUMBER;
        } else {
          const hiTok = this.next();
          if (!hiTok || hiTok.kind !== "number") this.fail("expected range end after 'to'", hiTok);
          const parsed = interpretNumber(hiTok.value, hiTok);
          if (typeof parsed !== "number" || !Number.isInteger(parsed)) this.fail("invalid reserved number", hiTok);
          hi = parsed;
        }
      }
      for (let n = lo; n <= hi; n++) numbers.add(n);
      if (this.acceptPunct(",")) continue;
      this.expectPunct(";", "';' after reserved numbers");
      return;
    }
  }

  private parseEnum(packageName: string | undefined, container: string | undefined): void {
    this.expectKeyword("enum");
    const nameTok = this.expectIdent("enum name");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nameTok.value)) {
      this.fail(`invalid enum name '${nameTok.value}'`, nameTok);
    }
    const fullName = container
      ? `${container}.${nameTok.value}`
      : this.parseFullName(packageName, nameTok.value);
    if (this.messages.has(fullName)) this.fail(`name '${fullName}' already used by a message`, nameTok);
    if (this.enums.has(fullName)) this.fail(`duplicate enum '${fullName}'`, nameTok);

    const def: EnumDef = { name: nameTok.value, fullName, values: [], allowAlias: false };
    this.enums.set(fullName, def);

    this.expectPunct("{", "'{' to open enum body");
    for (;;) {
      const tok = this.peek();
      if (!tok) this.fail(`unterminated enum '${fullName}'`);
      if (tok.kind === "punct" && tok.value === "}") {
        this.next();
        if (def.values[0]?.number !== 0) {
          this.fail(`first enum value of '${fullName}' must be 0`, nameTok);
        }
        return;
      }
      if (tok.kind === "punct" && tok.value === ";") {
        this.next();
        continue;
      }
      if (tok.kind === "ident" && tok.value === "option") {
        this.next();
        const nameTok = this.expectIdent("option name");
        this.expectPunct("=", "'=' after option name");
        const valTok = this.next();
        if (!valTok) this.fail("expected option value");
        if (nameTok.value === "allow_alias") {
          if (valTok.kind !== "ident" || (valTok.value !== "true" && valTok.value !== "false")) {
            this.fail("allow_alias must be true or false", valTok);
          }
          def.allowAlias = valTok.value === "true";
        }
        this.expectPunct(";", "';' after option");
        continue;
      }
      if (tok.kind === "ident" && tok.value === "reserved") {
        this.skipOptionLikeReserved();
        continue;
      }
      const valTok = this.expectIdent("enum value name");
      this.expectPunct("=", "'=' before enum value number");
      let negative = false;
      if (this.acceptPunct("-")) negative = true;
      const numTok = this.next();
      if (!numTok || numTok.kind !== "number") {
        this.fail("expected enum value number", numTok);
      }
      const parsed = interpretNumber(numTok.value, numTok);
      if (typeof parsed !== "number" || !Number.isInteger(parsed)) {
        this.fail("enum value must be an integer", numTok);
      }
      const number = negative ? -parsed : parsed;
      if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647) {
        this.fail(`enum value ${number} out of int32 range`, numTok);
      }
      if (def.values.some((v) => v.name === valTok.value)) {
        this.fail(`duplicate enum value name '${valTok.value}' in enum '${fullName}'`, valTok);
      }
      if (!def.allowAlias && def.values.some((v) => v.number === number)) {
        this.fail(`duplicate enum number ${number} in enum '${fullName}' (set 'option allow_alias = true;' to allow aliases)`, numTok);
      }
      const ev: EnumValueDef = { name: valTok.value, number };
      def.values.push(ev);
      this.expectEnumValueEnd(def);
    }
  }

  private expectEnumValueEnd(def: EnumDef): void {
    if (!this.acceptPunct("[")) {
      this.expectPunct(";", "';' after enum value");
      return;
    }
    for (;;) {
      const key = this.expectIdent("option name");
      this.expectPunct("=", "'=' after option name");
      const val = this.next();
      if (!val) this.fail("expected option value");
      if (key.value === "deprecated" && val.kind === "ident" && val.value === "true") {
        const last = def.values[def.values.length - 1];
        if (last) last.deprecated = true;
      }
      if (this.acceptPunct("]")) {
        this.expectPunct(";", "';' after enum value");
        return;
      }
      this.expectPunct(",", "',' between enum value options");
    }
  }

  private skipOptionLikeReserved(): void {
    this.expectKeyword("reserved");
    for (;;) {
      const tok = this.next();
      if (!tok) this.fail("unterminated reserved statement");
      if (tok.kind === "punct" && tok.value === ";") return;
    }
  }
}

function interpretNumber(raw: string, tok: Token): number | undefined {
  let text = raw.replace(/_/g, "");
  let value: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) {
    value = parseInt(text, 16);
  } else if (/^0[bB][01]+$/.test(text)) {
    value = parseInt(text, 2);
  } else if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
    value = Number(text);
  } else {
    throw new PclError("PCL_SCHEMA_PARSE", `invalid numeric literal '${raw}'`, undefined);
  }
  void tok;
  if (Number.isNaN(value)) return undefined;
  return value;
}

function describeToken(tok: Token | undefined): string {
  if (!tok) return "end of file";
  switch (tok.kind) {
    case "ident": return `'${tok.value}'`;
    case "number": return `number '${tok.value}'`;
    case "string": return `string ${JSON.stringify(tok.value)}`;
    case "punct": return `'${tok.value}'`;
  }
}

export function parseSchema(text: string, options?: ParseOptions): Schema {
  const fileName = options?.fileName ?? "schema.proto";
  const parser = new Parser(text, fileName);
  const schema = parser.parse();
  resolveSchema(schema);
  return schema;
}

/**
 * Parse a schema from proto-style text. Alias of parseSchema kept for API symmetry
 * with loadConfig: text in, resolved Schema out.
 */
export function loadSchema(text: string, options?: ParseOptions): Schema {
  return parseSchema(text, options);
}

export function resolveSchema(schema: Schema): void {
  const refs: SchemaRef = {
    messages: new Map(schema.messages.map((m) => [m.fullName, m])),
    enums: new Map(schema.enums.map((e) => [e.fullName, e])),
  };
  const shortToFullMessage = new Map<string, string[]>();
  const shortToFullEnum = new Map<string, string[]>();
  for (const [full, m] of refs.messages) {
    const short = full.split(".").pop() ?? full;
    pushList(shortToFullMessage, short, full);
    if (short !== full) pushList(shortToFullMessage, full, full);
    void m;
  }
  for (const [full, e] of refs.enums) {
    const short = full.split(".").pop() ?? full;
    pushList(shortToFullEnum, short, full);
    if (short !== full) pushList(shortToFullEnum, full, full);
    void e;
  }

  const resolveTypeName = (type: string, where: string): "scalar" | "message" | "enum" => {
    if (isScalarType(type)) return "scalar";
    const msgMatches = shortToFullMessage.get(type) ?? [];
    const enumMatches = shortToFullEnum.get(type) ?? [];
    if (msgMatches.length > 1 || enumMatches.length > 1) {
      throw new PclError(
        "PCL_SCHEMA_REF",
        `type '${type}' is ambiguous in ${where}; use the fully qualified name`,
      );
    }
    if (msgMatches.length === 1) return "message";
    if (enumMatches.length === 1) return "enum";
    throw new PclError("PCL_SCHEMA_REF", `unknown type '${type}' referenced in ${where}`);
  };

  const resolveEnumDefault = (enumName: string, valueName: string, where: string): EnumValueDef => {
    const matches = shortToFullEnum.get(enumName) ?? [];
    const def = matches.length === 1 ? refs.enums.get(matches[0] ?? "") : undefined;
    if (!def) throw new PclError("PCL_SCHEMA_REF", `unknown enum '${enumName}' referenced in ${where}`);
    const value = def.values.find((v) => v.name === valueName);
    if (!value) {
      throw new PclError(
        "PCL_SCHEMA_REF",
        `enum '${enumName}' has no value named '${valueName}' (referenced in ${where})`,
      );
    }
    return value;
  };

  for (const message of schema.messages) {
    const all: FieldDef[] = [...message.fields, ...message.oneofs.flatMap((o) => o.fields)];
    for (const field of all) {
      const where = `field '${message.fullName}.${field.name}'`;
      if (field.type === "map") {
        if (!field.mapKey || !field.mapValue) {
          throw new PclError("PCL_SCHEMA_REF", `map field '${field.name}' is missing key/value types`);
        }
        const keyKind = resolveTypeName(field.mapKey, `${where} (map key)`);
        if (keyKind !== "scalar") {
          throw new PclError("PCL_SCHEMA_REF", `map key type must be an integral or string type in ${where}`);
        }
        resolveTypeName(field.mapValue, `${where} (map value)`);
        continue;
      }
      const kind = resolveTypeName(field.type, where);
      if (field.defaultValue) {
        checkDefaultLiteral(field, kind, refs, resolveEnumDefault, where);
      }
    }
  }

  for (const enumDef of schema.enums) {
    if (schema.syntax === "proto3" && enumDef.values[0]?.number !== 0) {
      throw new PclError(
        "PCL_SCHEMA_REF",
        `first enum value of '${enumDef.fullName}' must be 0`,
      );
    }
  }
}

function pushList(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function checkDefaultLiteral(
  field: FieldDef,
  kind: "scalar" | "message" | "enum",
  refs: SchemaRef,
  resolveEnumDefault: (enumName: string, valueName: string, where: string) => EnumValueDef,
  where: string,
): void {
  const literal = field.defaultValue;
  if (!literal) return;
  if (kind === "message") {
    throw new PclError("PCL_SCHEMA_REF", `message-typed field cannot have a default value in ${where}`);
  }
  if (kind === "enum") {
    if (literal.kind !== "identifier") {
      throw new PclError("PCL_SCHEMA_REF", `enum default must be a value name in ${where}`);
    }
    resolveEnumDefault(field.type, literal.value, where);
    return;
  }
  const scalar = field.type;
  switch (scalar) {
    case "double":
    case "float":
      if (literal.kind !== "number") {
        throw new PclError("PCL_SCHEMA_REF", `default for ${scalar} must be numeric in ${where}`);
      }
      return;
    case "int32": case "int64": case "sint32": case "sint64":
    case "sfixed32": case "sfixed64":
      if (literal.kind !== "number" || !Number.isInteger(literal.value)) {
        throw new PclError("PCL_SCHEMA_REF", `default for ${scalar} must be an integer in ${where}`);
      }
      return;
    case "uint32": case "uint64": case "fixed32": case "fixed64":
      if (literal.kind !== "number" || !Number.isInteger(literal.value)) {
        throw new PclError("PCL_SCHEMA_REF", `default for ${scalar} must be an integer in ${where}`);
      }
      if (literal.value < 0) {
        throw new PclError("PCL_SCHEMA_REF", `negative default on unsigned field ${scalar} in ${where}`);
      }
      return;
    case "bool":
      if (literal.kind !== "bool") {
        throw new PclError("PCL_SCHEMA_REF", `boolean default must be true or false in ${where}`);
      }
      return;
    case "string":
      if (literal.kind !== "string") {
        throw new PclError("PCL_SCHEMA_REF", `default for string must be a string literal in ${where}`);
      }
      return;
    case "bytes":
      if (literal.kind !== "string") {
        throw new PclError("PCL_SCHEMA_REF", `default for bytes must be a base64 string literal in ${where}`);
      }
      if (!isCanonicalBase64(literal.value)) {
        throw new PclError("PCL_SCHEMA_REF", `default for bytes is not valid base64 in ${where}`);
      }
      return;
    default:
      throw new PclError("PCL_SCHEMA_REF", `unsupported scalar type '${scalar}' in ${where}`);
  }
  void refs;
}

export function isCanonicalBase64(value: string): boolean {
  if (value === "") return true;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  if (value.length % 4 !== 0) return false;
  return true;
}
