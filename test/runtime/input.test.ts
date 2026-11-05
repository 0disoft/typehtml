import { describe, expect, test } from 'bun:test';
import { validateBusinessInput, hashValidatedInput } from '../../src/runtime/input.ts';
import type { InputContract } from '../../src/contract/types.ts';

const input: InputContract = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['productId', 'quantity'],
    properties: {
      productId: { type: 'string', minLength: 1, maxLength: 64 },
      quantity: { type: 'integer', minimum: 1, maximum: 20 },
      note: { type: 'string', maxLength: 3 },
    },
  },
  codecs: { productId: 'text', quantity: 'decimal-integer', note: 'text' },
  unknownKeys: 'reject',
  duplicateScalars: 'reject',
  scalarSemantics: {
    missing: 'absent',
    emptyString: 'preserve',
    textNormalization: 'none',
    schemaStringLength: 'unicode-code-points',
    validationMutatesData: false,
  },
};

describe('business input validation', () => {
  test('decodes scalars without mutating empty strings', () => {
    const result = validateBusinessInput(input, { productId: 'p_100', quantity: '2', note: '' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ productId: 'p_100', quantity: 2, note: '' });
    expect(result.raw.note).toBe('');
  });

  test('separates unknown keys from value issues', () => {
    const unknown = validateBusinessInput(input, { productId: 'p', quantity: '2', ownerId: 'x' });
    expect(unknown).toMatchObject({ ok: false, unknownKeys: ['ownerId'] });
    const missing = validateBusinessInput(input, { productId: 'p' });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.issues.map((issue) => issue.code)).toContain('REQUIRED');
  });

  test('rejects exponent, leading zero, unsafe integer, and bounds', () => {
    for (const quantity of ['1e1', '01', '-1', '21', '9007199254740992']) {
      const result = validateBusinessInput(input, { productId: 'p', quantity });
      expect(result.ok).toBe(false);
    }
    expect(validateBusinessInput(input, { productId: 'p', quantity: '20' }).ok).toBe(true);
  });

  test('counts Unicode code points for string length', () => {
    expect(validateBusinessInput(input, { productId: '😀', quantity: '1' }).ok).toBe(true);
    expect(validateBusinessInput(input, { productId: '😀😀😀😀', quantity: '1', note: '😀😀😀😀' }).ok).toBe(false);
  });

  test('lets the schema decide whether canonical negative integers are allowed', () => {
    const signed: InputContract = {
      ...input,
      schema: { ...input.schema, properties: { ...input.schema.properties, quantity: { type: 'integer', minimum: -20, maximum: 20 } } },
    };
    expect(validateBusinessInput(signed, { productId: 'p', quantity: '-2' })).toMatchObject({ ok: true, value: { quantity: -2 } });
    expect(validateBusinessInput(input, { productId: 'p', quantity: '-2' }).ok).toBe(false);
  });

  test('hashes canonical decoded input and preserves type tags', () => {
    const a = validateBusinessInput(input, { productId: 'p', quantity: '2' });
    const b = validateBusinessInput(input, { quantity: '2', productId: 'p' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(hashValidatedInput(a.value)).toBe(hashValidatedInput(b.value));
    expect(hashValidatedInput(a.value)).toMatch(/^[a-f0-9]{64}$/);
  });
});
