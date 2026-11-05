import { describe, expect, test } from 'bun:test';
import { canonicalJson, CanonicalJsonError } from '../../src/contract/canonical-json.ts';

describe('canonicalJson', () => {
  test('sorts object keys by code point, keeps array order, and uses compact separators', () => {
    expect(canonicalJson({ b: 2, a: 1, arr: [1, 2] })).toBe('{"a":1,"arr":[1,2],"b":2}');
  });

  test('preserves non-ASCII characters', () => {
    expect(canonicalJson({ name: '한글', emoji: '🙂' })).toBe('{"emoji":"🙂","name":"한글"}');
  });

  test('escapes control characters like JSON', () => {
    expect(canonicalJson({ value: 'a\nb\t"c"' })).toBe('{"value":"a\\nb\\t\\"c\\""}');
  });

  test('rejects unsafe integers and negative zero', () => {
    expect(() => canonicalJson({ n: Number.MAX_SAFE_INTEGER + 1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ n: -0 })).toThrow(CanonicalJsonError);
  });

  test('rejects lone surrogates', () => {
    expect(() => canonicalJson({ s: '\ud800' })).toThrow(CanonicalJsonError);
  });

  test('rejects unsupported values and array holes', () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(CanonicalJsonError);
    const holes = new Array(1);
    expect(() => canonicalJson(holes)).toThrow(CanonicalJsonError);
  });
});
