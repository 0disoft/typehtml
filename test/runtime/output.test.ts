import { describe, expect, test } from 'bun:test';
import type { ObjectSchema, StringFieldSchema } from '../../src/contract/types.ts';
import { OutputValidationError, validateOutputObject } from '../../src/runtime/output.ts';

function stringSchema(field: Omit<StringFieldSchema, 'type'> = {}): ObjectSchema {
  return { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', ...field } } };
}

function rejection(field: Omit<StringFieldSchema, 'type'>, text: string): OutputValidationError {
  try {
    validateOutputObject(stringSchema(field), { text });
  } catch (error) {
    if (error instanceof OutputValidationError) return error;
    throw error;
  }
  throw new Error('Expected output validation to fail');
}

/** Measure consumed code points without relying on wall-clock timing or heap heuristics. */
function measureIterations<T>(text: string, work: () => T): { result: T; yielded: number } {
  const descriptor = Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator)!;
  const original = String.prototype[Symbol.iterator];
  let yielded = 0;
  Object.defineProperty(String.prototype, Symbol.iterator, {
    ...descriptor,
    value: function* (this: string) {
      const measured = String(this) === text;
      for (const point of original.call(this)) {
        if (measured) yielded++;
        yield point;
      }
    },
  });
  try {
    return { result: work(), yielded };
  } finally {
    Object.defineProperty(String.prototype, Symbol.iterator, descriptor);
  }
}

describe('output string validation', () => {
  test.each([
    ['ASCII', ['a', 'aa', 'aaa', 'aaaa']],
    ['astral characters', ['😀', '😀😀', '😀😀😀', '😀😀😀😀']],
    ['combining characters', ['\u0301', 'e\u0301', 'e\u0301x', 'e\u0301e\u0301']],
    ['unpaired surrogates', ['\ud800', '\ud800a', '\ud800a\udc00', '\ud800a\udc00b']],
  ] as const)('preserves min/max boundaries for %s', (_name, values) => {
    const field = { minLength: 2, maxLength: 3 };
    expect(rejection(field, values[0]).message).toBe('$.text: must be at least 2 characters');
    for (const text of [values[1], values[2]]) {
      expect(validateOutputObject(stringSchema(field), { text }).text).toBe(text);
    }
    expect(rejection(field, values[3]).message).toBe('$.text: must be at most 3 characters');
  });

  test('accepts an empty string when maxLength is zero and rejects the first code point', () => {
    expect(validateOutputObject(stringSchema({ maxLength: 0 }), { text: '' }).text).toBe('');
    expect(rejection({ maxLength: 0 }, '😀').message).toBe('$.text: must be at most 0 characters');
  });

  test('handles single-sided limits and preserves minLength error precedence', () => {
    expect(rejection({ minLength: 2 }, '😀').message).toBe('$.text: must be at least 2 characters');
    expect(validateOutputObject(stringSchema({ minLength: 2 }), { text: '😀😀😀' }).text).toBe('😀😀😀');
    expect(validateOutputObject(stringSchema({ maxLength: 2 }), { text: '😀😀' }).text).toBe('😀😀');
    expect(rejection({ maxLength: 2 }, '😀😀😀').message).toBe('$.text: must be at most 2 characters');

    // The public helper also accepts typed schemas directly, without contract loading.
    expect(rejection({ minLength: 5, maxLength: 1 }, 'aaa').message).toBe('$.text: must be at least 5 characters');
    expect(rejection({ minLength: 5, maxLength: 1 }, 'aaaaa').message).toBe('$.text: must be at most 1 characters');
    expect(rejection({ minLength: 5, maxLength: 1 }, 'aaaaaa').message).toBe('$.text: must be at most 1 characters');
  });

  test('retains length, const, enum, and pattern validation order', () => {
    expect(rejection({ minLength: 2, const: 'expected', enum: ['allowed'], pattern: '^z$' }, 'x').message)
      .toBe('$.text: must be at least 2 characters');
    expect(rejection({ maxLength: 1, const: 'expected', enum: ['allowed'], pattern: '^z$' }, 'xx').message)
      .toBe('$.text: must be at most 1 characters');
    expect(rejection({ const: 'expected', enum: ['allowed'], pattern: '^z$' }, 'other').message)
      .toBe('$.text: const mismatch');
    expect(rejection({ const: 'expected', enum: ['allowed'], pattern: '^z$' }, 'expected').message)
      .toBe('$.text: enum mismatch');
    expect(rejection({ const: 'expected', enum: ['expected'], pattern: '^z$' }, 'expected').message)
      .toBe('$.text: pattern mismatch');
    expect(validateOutputObject(stringSchema({ const: 'ok', enum: ['ok'], pattern: '^ok$' }), { text: 'ok' }).text).toBe('ok');
  });

  test('returns a frozen owned snapshot without changing the caller object or schema', () => {
    const field = { minLength: 1, maxLength: 2 };
    const schema = stringSchema(field);
    const input = { text: '😀' };
    const output = validateOutputObject(schema, input);
    expect(output).not.toBe(input);
    expect(Object.getPrototypeOf(output)).toBeNull();
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Reflect.set(output, 'text', 'changed')).toBe(false);
    input.text = 'caller';
    expect(output.text).toBe('😀');
    expect(schema).toEqual(stringSchema(field));
    expect(Object.isFrozen(schema)).toBe(false);
    expect(Object.isFrozen(schema.properties.text!)).toBe(false);
  });

  test('rejects one million code points after only maxLength plus one iterations', () => {
    const text = '😀'.repeat(1_000_000);
    const measured = measureIterations(text, () => rejection({ minLength: 1, maxLength: 64 }, text));
    expect(measured.result.path).toBe('$.text');
    expect(measured.result.message).toBe('$.text: must be at most 64 characters');
    expect(measured.yielded).toBe(65);
  });

  test('stops counting at minLength when there is no maximum', () => {
    const text = 'a'.repeat(1_000_000);
    const measured = measureIterations(text, () => validateOutputObject(stringSchema({ minLength: 3 }), { text }));
    expect(measured.result.text).toBe(text);
    expect(measured.yielded).toBe(3);
  });

  test('does not count an unconstrained string before checking its other constraints', () => {
    const text = 'a'.repeat(1_000_000);
    const measured = measureIterations(text, () => validateOutputObject(stringSchema({ const: text, enum: [text], pattern: '^a+$' }), { text }));
    expect(measured.result.text).toBe(text);
    expect(measured.yielded).toBe(0);
  });
});
