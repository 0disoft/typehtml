import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineSchemaForm, getSchemaFieldProps, type FormFields } from '../../src/index.ts';
import { decodeFormFields } from '../../src/form/fields.ts';
import { getPreparedFormTransport, prepareFormTransport, resolveTransportField } from '../../src/form/transport.ts';

describe('normalized form transport', () => {
  test('records occurrence and missing-value policy without changing declaration semantics', () => {
    const transport = prepareFormTransport({
      name: { type: 'string', required: true, minLength: 1 },
      note: { type: 'string' },
      accepted: { type: 'boolean', trueValue: 'yes', falseValue: 'no' },
      tags: { type: 'array', items: { type: 'string' }, required: true, maxItems: 3 },
      quantities: { type: 'array', items: { type: 'integer' }, minItems: 2 },
    });
    expect(transport.format).toBe('typehtml-transport/1');
    expect(transport.names).toEqual(['name', 'note', 'accepted', 'tags', 'quantities']);
    expect(transport.repeatable).toEqual(['tags', 'quantities']);
    expect(transport.fields.map(({ cardinality, minOccurrences, maxOccurrences, missing }) => ({ cardinality, minOccurrences, maxOccurrences, missing }))).toEqual([
      { cardinality: 'scalar', minOccurrences: 1, maxOccurrences: 1, missing: 'absent' },
      { cardinality: 'scalar', minOccurrences: 0, maxOccurrences: 1, missing: 'absent' },
      { cardinality: 'scalar', minOccurrences: 0, maxOccurrences: 1, missing: 'false' },
      { cardinality: 'repeated', minOccurrences: 1, maxOccurrences: 3, missing: 'empty-array' },
      { cardinality: 'repeated', minOccurrences: 2, maxOccurrences: null, missing: 'empty-array' },
    ]);
    expect(transport.byName.tags!.declaration.required).toBe(true);
    expect(transport.byName.quantities!.declaration.required).toBeUndefined();
    expect(transport.byName.name!.codec).toEqual({ type: 'string', minLength: 1 });
    expect(JSON.parse(JSON.stringify(transport)).byName.quantities.maxOccurrences).toBeNull();
  });

  test('resolves only exact declared canonical names, including boundary indexes', () => {
    const transport = prepareFormTransport({ 'items[1023].quantity': { type: 'integer' }, 'user.name': { type: 'string' } });
    expect(resolveTransportField(transport, 'items[1023].quantity')?.path).toEqual(['items', 1023, 'quantity']);
    for (const name of ['items[0].quantity', 'items[01023].quantity', 'items[1024].quantity', 'user', '__proto__', 'constructor', 'toString']) {
      expect(resolveTransportField(transport, name)).toBeNull();
    }
    const invalidFields: readonly FormFields[] = [
      { 'items[1024].quantity': { type: 'integer' } },
      { 'items[00].quantity': { type: 'integer' } },
      { 'user.__proto__.name': { type: 'string' } },
      { user: { type: 'string' }, 'user.name': { type: 'string' } },
    ];
    for (const fields of invalidFields) expect(() => prepareFormTransport(fields)).toThrow();
    expect(Object.getPrototypeOf(transport.byName)).toBeNull();
  });

  test('owns an immutable snapshot and never caches mutable caller declarations', () => {
    const source: Record<string, any> = { tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, maxItems: 2 } };
    const first = prepareFormTransport(source);
    source.tags.items.enum.push('c');
    source.tags.maxItems = 3;
    source.note = { type: 'string' };
    expect(first.names).toEqual(['tags']);
    expect(first.byName.tags!.codec).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(first.byName.tags!.maxOccurrences).toBe(2);
    for (const value of [first, first.declarations, first.fields, first.names, first.repeatable, first.byName, first.byName.tags, first.byName.tags!.path, first.byName.tags!.declaration, first.byName.tags!.codec, (first.byName.tags!.codec as { enum: readonly string[] }).enum]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(getPreparedFormTransport(first.declarations)).toBe(first);
    const current = getPreparedFormTransport(source);
    expect(current.names).toEqual(['tags', 'note']);
    expect(current.byName.tags!.maxOccurrences).toBe(3);
    source.tags.maxItems = 4;
    expect(getPreparedFormTransport(source).byName.tags!.maxOccurrences).toBe(4);
  });

  test('preserves required versus minimum-item errors and empty missing defaults', () => {
    const transport = prepareFormTransport({
      required: { type: 'array', items: { type: 'string' }, required: true, maxItems: 0 },
      minimum: { type: 'array', items: { type: 'string' }, minItems: 1 },
      flag: { type: 'boolean' },
      optional: { type: 'string' },
    });
    expect(transport.byName.required).toMatchObject({ minOccurrences: 1, maxOccurrences: 0 });
    const decoded = decodeFormFields(transport.declarations, []);
    expect(decoded.validation.ok).toBe(false);
    if (!decoded.validation.ok) expect(decoded.validation.issues.map(({ field, code }) => [field, code])).toEqual([
      ['required', 'REQUIRED'], ['minimum', 'MIN_ITEMS'],
    ]);
    const valid = decodeFormFields(prepareFormTransport({ values: { type: 'array', items: { type: 'string' } }, flag: { type: 'boolean' }, optional: { type: 'string' } }).declarations, []);
    expect(valid.validation).toEqual({ ok: true, value: { values: [], flag: false } });
  });

  test('schema forms reuse the same prepared snapshot for HTML and request metadata', () => {
    const fields = { name: { type: 'string', required: true, minLength: 2 }, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } } as const;
    const form = defineSchemaForm({ id: 'transport.test', path: '/save', fields, input: z.unknown(), output: z.unknown() });
    const transport = getPreparedFormTransport(form.fields);
    expect(getPreparedFormTransport(form.fields)).toBe(transport);
    expect(transport.declarations).toBe(form.fields);
    expect(getSchemaFieldProps(form, 'name')).toMatchObject({ name: 'name', required: true, minlength: 2 });
    expect(getSchemaFieldProps(form, 'tags')).toMatchObject({ name: 'tags', multiple: true });
    expect(() => getSchemaFieldProps(form, 'constructor')).toThrow('unknown form field');
  });
});
