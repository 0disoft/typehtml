import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeStrictJson,
  readStrictJson,
  StrictJsonError,
  type JsonObject,
} from "../../src/contract/strict-json.ts";

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof StrictJsonError) return error.code;
    throw error;
  }
  throw new Error("expected StrictJsonError");
}

describe("decodeStrictJson", () => {
  test("parses a null-prototype object", () => {
    const value = decodeStrictJson('{"x":1,"ok":true,"name":"가"}') as JsonObject;
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(value.x).toBe(1);
    expect(value.ok).toBe(true);
    expect(value.name).toBe("가");
  });

  test("rejects duplicate decoded member names", () => {
    expect(errorCode(() => decodeStrictJson('{"x":1,"x":2}'))).toBe("DUPLICATE_JSON_MEMBER");
    expect(errorCode(() => decodeStrictJson('{"x":1,"\\u0078":2}'))).toBe("DUPLICATE_JSON_MEMBER");
  });

  test("rejects source BOM and invalid UTF-8", () => {
    expect(errorCode(() => decodeStrictJson("\uFEFF{}"))).toBe("JSON_SOURCE_BOM");
    expect(errorCode(() => decodeStrictJson(new Uint8Array([0x7b, 0xff, 0x7d])))).toBe("INVALID_UTF8");
  });

  test("rejects floats when integerOnly is set", () => {
    expect(errorCode(() => decodeStrictJson('{"n":1.5}', { integerOnly: true }))).toBe("UNSUPPORTED_JSON_NUMBER");
    const value = decodeStrictJson('{"n":1.5}') as JsonObject;
    expect(value.n).toBe(1.5);
  });

  test("rejects unsafe integers and non-finite values", () => {
    expect(errorCode(() => decodeStrictJson("9007199254740992"))).toBe("UNSAFE_JSON_INTEGER");
    expect(errorCode(() => decodeStrictJson("1e309"))).toBe("UNSUPPORTED_JSON_NUMBER");
    expect(errorCode(() => decodeStrictJson("NaN"))).toBe("JSON_SYNTAX");
  });

  test("rejects excessive nesting", () => {
    expect(errorCode(() => decodeStrictJson("[[0]]", { maxDepth: 1 }))).toBe("JSON_TOO_DEEP");
    const deep = "[".repeat(65) + "0" + "]".repeat(65);
    expect(errorCode(() => decodeStrictJson(deep))).toBe("JSON_TOO_DEEP");
  });

  test("rejects lone surrogates but accepts a valid pair", () => {
    expect(errorCode(() => decodeStrictJson('"\\ud800"'))).toBe("INVALID_JSON_UNICODE");
    expect(errorCode(() => decodeStrictJson('"' + String.fromCharCode(0xd800) + '"'))).toBe("INVALID_JSON_UNICODE");
    expect(decodeStrictJson('"\\ud83d\\ude00"')).toBe("😀");
    expect(decodeStrictJson('"😀"')).toBe("😀");
  });

  test("rejects trailing data and malformed numbers", () => {
    expect(errorCode(() => decodeStrictJson("{}x"))).toBe("JSON_SYNTAX");
    expect(errorCode(() => decodeStrictJson("01"))).toBe("JSON_SYNTAX");
    expect(errorCode(() => decodeStrictJson("+1"))).toBe("JSON_SYNTAX");
  });

  test("honors maxBytes", () => {
    expect(errorCode(() => decodeStrictJson("{}", { maxBytes: 1 }))).toBe("JSON_TOO_LARGE");
  });

  test("does not pollute the prototype", () => {
    const value = decodeStrictJson('{"__proto__":{"polluted":true}}') as JsonObject;
    expect(Object.prototype.hasOwnProperty.call(value, "__proto__")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("readStrictJson", () => {
  test("reads a bounded file and rejects an oversized one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typehtml-strict-json-"));
    try {
      const valid = join(directory, "valid.json");
      await writeFile(valid, '{"x":1}', "utf8");
      const value = (await readStrictJson(valid)) as JsonObject;
      expect(value.x).toBe(1);

      const oversized = join(directory, "oversized.json");
      await writeFile(oversized, "{}", "utf8");
      await expect(readStrictJson(oversized, { maxBytes: 1 })).rejects.toMatchObject({
        code: "JSON_TOO_LARGE",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
