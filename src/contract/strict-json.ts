export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_DEPTH = 64;
export const MAX_SAFE_INTEGER = 9007199254740991;

export type StrictJsonErrorCode =
  | "JSON_TOO_LARGE"
  | "JSON_SOURCE_BOM"
  | "INVALID_UTF8"
  | "JSON_SYNTAX"
  | "DUPLICATE_JSON_MEMBER"
  | "JSON_TOO_DEEP"
  | "UNSAFE_JSON_INTEGER"
  | "UNSUPPORTED_JSON_NUMBER"
  | "INVALID_JSON_UNICODE";

export class StrictJsonError extends Error {
  readonly code: StrictJsonErrorCode;

  constructor(code: StrictJsonErrorCode, detail?: string) {
    super(detail === undefined ? code : code + ": " + detail);
    this.name = "StrictJsonError";
    this.code = code;
  }
}

export interface StrictJsonOptions {
  readonly integerOnly?: boolean;
  readonly maxBytes?: number;
  readonly maxDepth?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function assertNoLoneSurrogates(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new StrictJsonError("INVALID_JSON_UNICODE");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new StrictJsonError("INVALID_JSON_UNICODE");
    }
  }
}

class Parser {
  private index = 0;

  constructor(
    private readonly source: string,
    private readonly integerOnly: boolean,
    private readonly maxDepth: number,
  ) {}

  parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      this.fail("trailing data");
    }
    return value;
  }

  private parseValue(depth: number): JsonValue {
    if (depth > this.maxDepth) {
      throw new StrictJsonError("JSON_TOO_DEEP");
    }

    const char = this.source[this.index];
    if (char === "{") return this.parseObject(depth);
    if (char === "[") return this.parseArray(depth);
    if (char === '"') return this.parseString();
    if (char === "t") return this.parseLiteral("true", true);
    if (char === "f") return this.parseLiteral("false", false);
    if (char === "n") return this.parseLiteral("null", null);
    if (char === "-" || isDigit(char)) return this.parseNumber();
    this.fail("unexpected token");
  }

  private parseLiteral<T extends boolean | null>(literal: string, value: T): T {
    if (!this.source.startsWith(literal, this.index)) {
      this.fail("expected " + literal);
    }
    this.index += literal.length;
    return value;
  }

  private parseObject(depth: number): JsonObject {
    this.index += 1;
    const object: JsonObject = Object.create(null) as JsonObject;
    this.skipWhitespace();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return object;
    }

    while (true) {
      if (this.source[this.index] !== '"') {
        this.fail("object key must be a string");
      }
      const key = this.parseString();
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        throw new StrictJsonError("DUPLICATE_JSON_MEMBER", key);
      }
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      object[key] = this.parseValue(depth + 1);
      this.skipWhitespace();

      const char = this.source[this.index];
      if (char === "}") {
        this.index += 1;
        return object;
      }
      if (char !== ",") {
        this.fail("expected , or }");
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): JsonValue[] {
    this.index += 1;
    const array: JsonValue[] = [];
    this.skipWhitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return array;
    }

    while (true) {
      array.push(this.parseValue(depth + 1));
      this.skipWhitespace();

      const char = this.source[this.index];
      if (char === "]") {
        this.index += 1;
        return array;
      }
      if (char !== ",") {
        this.fail("expected , or ]");
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.index += 1;
    let result = "";

    while (this.index < this.source.length) {
      const char = this.source[this.index];
      this.index += 1;
      if (char === undefined) this.fail("unterminated string");

      if (char === '"') {
        assertNoLoneSurrogates(result);
        return result;
      }

      if (char === "\\") {
        const escape = this.source[this.index];
        this.index += 1;
        switch (escape) {
          case '"':
            result += '"';
            break;
          case "\\":
            result += "\\";
            break;
          case "/":
            result += "/";
            break;
          case "b":
            result += "\b";
            break;
          case "f":
            result += "\f";
            break;
          case "n":
            result += "\n";
            break;
          case "r":
            result += "\r";
            break;
          case "t":
            result += "\t";
            break;
          case "u": {
            const hex = this.source.slice(this.index, this.index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              this.fail("invalid unicode escape");
            }
            result += String.fromCharCode(Number.parseInt(hex, 16));
            this.index += 4;
            break;
          }
          default:
            this.fail("invalid escape");
        }
      } else {
        if (char.charCodeAt(0) < 0x20) {
          this.fail("control character in string");
        }
        result += char;
      }
    }

    this.fail("unterminated string");
  }

  private parseNumber(): number {
    const start = this.index;
    let integer = true;

    if (this.source[this.index] === "-") {
      this.index += 1;
    }

    const first = this.source[this.index];
    if (first === "0") {
      this.index += 1;
      if (isDigit(this.source[this.index])) {
        this.fail("leading zero");
      }
    } else if (first !== undefined && first >= "1" && first <= "9") {
      while (isDigit(this.source[this.index])) {
        this.index += 1;
      }
    } else {
      this.fail("invalid number");
    }

    if (this.source[this.index] === ".") {
      integer = false;
      this.index += 1;
      if (!isDigit(this.source[this.index])) {
        this.fail("expected a fraction digit");
      }
      while (isDigit(this.source[this.index])) {
        this.index += 1;
      }
    }

    const exponent = this.source[this.index];
    if (exponent === "e" || exponent === "E") {
      integer = false;
      this.index += 1;
      const sign = this.source[this.index];
      if (sign === "+" || sign === "-") {
        this.index += 1;
      }
      if (!isDigit(this.source[this.index])) {
        this.fail("expected an exponent digit");
      }
      while (isDigit(this.source[this.index])) {
        this.index += 1;
      }
    }

    const token = this.source.slice(start, this.index);
    if (this.integerOnly && !integer) {
      throw new StrictJsonError("UNSUPPORTED_JSON_NUMBER", token);
    }

    const value = Number(token);
    if (!Number.isFinite(value)) {
      throw new StrictJsonError("UNSUPPORTED_JSON_NUMBER", token);
    }
    if (integer && !Number.isSafeInteger(value)) {
      throw new StrictJsonError("UNSAFE_JSON_INTEGER", token);
    }
    return value;
  }

  private skipWhitespace(): void {
    while (true) {
      const char = this.source[this.index];
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        this.index += 1;
      } else {
        return;
      }
    }
  }

  private expect(char: string): void {
    if (this.source[this.index] !== char) {
      this.fail("expected " + char);
    }
    this.index += 1;
  }

  private fail(message: string): never {
    throw new StrictJsonError("JSON_SYNTAX", message);
  }
}

export function decodeStrictJson(input: string | Uint8Array, options: StrictJsonOptions = {}): JsonValue {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new TypeError("maxDepth must be a non-negative safe integer");
  }

  let source: string;
  if (typeof input === "string") {
    assertNoLoneSurrogates(input);
    if (encoder.encode(input).byteLength > maxBytes) {
      throw new StrictJsonError("JSON_TOO_LARGE");
    }
    source = input;
  } else {
    if (input.byteLength > maxBytes) {
      throw new StrictJsonError("JSON_TOO_LARGE");
    }
    try {
      source = decoder.decode(input);
    } catch {
      throw new StrictJsonError("INVALID_UTF8");
    }
  }

  if (source.startsWith("\uFEFF")) {
    throw new StrictJsonError("JSON_SOURCE_BOM");
  }

  return new Parser(source, options.integerOnly ?? false, maxDepth).parse();
}

export async function readStrictJson(
  path: string,
  options: StrictJsonOptions = {},
): Promise<JsonValue> {
  const { open } = await import("node:fs/promises");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const result = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (result.bytesRead > maxBytes) {
      throw new StrictJsonError("JSON_TOO_LARGE");
    }
    return decodeStrictJson(buffer.subarray(0, result.bytesRead), { ...options, maxBytes });
  } finally {
    await handle.close();
  }
}
