import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createFormHelpers, createFormState, createSchemaFormHandler, defineSchemaForm, getSchemaFieldId, getSchemaFieldProps, renderSchemaFormErrors } from '../../src/index.ts';
import { appendCollectionRow, collectionFieldName, createCollectionRows, moveCollectionRow, prepareFormCollections, removeCollectionRow, type FormCollections } from '../../src/form/collections.ts';
import { decodeFormTransport, getPreparedFormTransport, prepareFormTransport, resolveTransportField } from '../../src/form/transport.ts';

const collection = {
  minItems: 0, maxItems: 3, rowKey: 'rowId', fields: {
    rowId: { type: 'string', required: true, minLength: 1, maxLength: 64 },
    quantity: { type: 'integer', required: true, minimum: 1, maximum: 5 },
    accepted: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
    'address.city': { type: 'string' },
  },
} as const;
const form = defineSchemaForm({ id: 'rows.save', path: '/rows', fields: {}, collections: { items: collection },
  input: z.object({ items: z.array(z.object({ rowId: z.string(), quantity: z.number(), accepted: z.boolean(), tags: z.array(z.string()), address: z.object({ city: z.string() }).optional() })) }), output: z.string(),
});
const entries = (values: readonly (readonly [string, string])[]) => values.map(([key, value]) => ({ key, value }));
const valid = [['items[0].rowId', 'first'], ['items[0].quantity', '2'], ['items[0].tags', 'b'], ['items[0].tags', 'a'], ['items[0].tags', 'b'], ['items[1].rowId', 'second'], ['items[1].quantity', '3']] as const;
const transport = () => getPreparedFormTransport(form.fields, form.collections);
const origin = 'https://app.test';
const request = (values: readonly (readonly [string, string])[]) => new Request(origin + '/rows', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['_bc_csrf', 'token'], ...values.map(([key, value]) => [key, value])]) });

describe('bounded object row collections', () => {
  test('expands a finite exact allowlist and preserves rows, duplicates and missing defaults', () => {
    expect(transport().names).toHaveLength(15);
    expect(transport().repeatable).toEqual(['items[0].tags', 'items[1].tags', 'items[2].tags']);
    expect(resolveTransportField(transport(), 'items[2].address.city')?.row).toEqual({ collection: 'items', index: 2, member: 'address.city' });
    for (const name of ['items[3].rowId', 'items[01].rowId', 'items[0].unknown', 'items[0].__proto__.polluted']) expect(resolveTransportField(transport(), name)).toBeNull();
    expect(decodeFormTransport(transport(), entries(valid)).validation).toEqual({ ok: true, value: { items: [
      { rowId: 'first', quantity: 2, accepted: false, tags: ['b', 'a', 'b'] },
      { rowId: 'second', quantity: 3, accepted: false, tags: [] },
    ] } });
    expect(decodeFormTransport(transport(), []).validation).toEqual({ ok: true, value: { items: [] } });
  });

  test('any member activates a row; missing keys, incomplete rows and index gaps fail', () => {
    for (const values of [[['items[0].accepted', 'on']], [['items[0].rowId', 'first']], [['items[1].rowId', 'second'], ['items[1].quantity', '2']]] as const) {
      const result = decodeFormTransport(transport(), entries(values)).validation;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
    }
    const absentKey = decodeFormTransport(transport(), entries([['items[0].quantity', '2']])).validation;
    if (!absentKey.ok) expect(absentKey.issues).toContainEqual({ field: 'items[0].rowId', code: 'REQUIRED', message: 'items[0].rowId is required' });
  });

  test('enforces unique row identity, row minimums and ordinary member bounds', () => {
    const duplicate = decodeFormTransport(transport(), entries([...valid, ['items[2].rowId', 'first'], ['items[2].quantity', '1']])).validation;
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.issues.some(({ code }) => code === 'DUPLICATE_ROW_KEY')).toBe(true);
    const requiredRows = prepareFormTransport({}, { items: { ...collection, minItems: 1 } });
    const missing = decodeFormTransport(requiredRows, []).validation;
    if (!missing.ok) expect(missing.issues[0]?.code).toBe('MIN_ITEMS');
    for (const quantity of ['0', '1', '5', '6']) expect(decodeFormTransport(transport(), entries([['items[0].rowId', 'key'], ['items[0].quantity', quantity]])).validation.ok).toBe(quantity === '1' || quantity === '5');
  });

  test('bounds expanded leaves and rejects domain overlap even for a zero-row collection', () => {
    const twoLeaves = { maxItems: 512, rowKey: 'key', fields: { key: { type: 'string', required: true, minLength: 1, maxLength: 64 }, value: { type: 'string' } } } as const;
    expect(prepareFormTransport({}, { rows: twoLeaves }).fields).toHaveLength(1024);
    expect(() => prepareFormTransport({}, { rows: { ...twoLeaves, maxItems: 513 } })).toThrow('transport limit');
    expect(() => prepareFormTransport({ 'items[0].other': { type: 'string' } }, { items: { ...collection, maxItems: 0 } })).toThrow('overlapping collection path');
    expect(() => prepareFormTransport({}, { items: collection, 'items.other': collection })).toThrow('overlapping collection path');
    expect(decodeFormTransport(prepareFormTransport({}, { items: { ...collection, maxItems: 0 } }), []).validation).toEqual({ ok: true, value: { items: [] } });
  });

  test('validates configuration snapshots without getters or aliases', () => {
    let reads = 0;
    const getter = { get maxItems() { reads++; return 1; }, rowKey: 'rowId', fields: collection.fields };
    expect(() => prepareFormCollections({ items: getter })).toThrow('data properties');
    expect(reads).toBe(0);
    const invalid: unknown[] = [
      { items: { ...collection, maxItems: Infinity } }, { items: { ...collection, minItems: null } },
      { items: { ...collection, rowKey: 'quantity' } }, { items: { ...collection, rowKey: 'missing' } },
      { 'items[0]': collection }, { '__proto__.items': collection },
      { items: { ...collection, fields: { rowId: { type: 'string', required: true, minLength: 1, maxLength: 65 } } } },
    ];
    for (const config of invalid) expect(() => prepareFormCollections(config as FormCollections)).toThrow();
    for (const [index, member] of [[-1, 'rowId'], [1024, 'rowId'], [0, '__proto__'], [0, 'values[01]']] as const) expect(() => collectionFieldName('items', index, member)).toThrow();
    const source = { items: { ...collection, maxItems: 1 } };
    const prepared = prepareFormTransport({}, source);
    source.items.maxItems = 2;
    expect(prepared.collections.items!.maxItems).toBe(1);
    expect(Object.isFrozen(prepared.collections.items!.fields)).toBe(true);
  });

  test('HTTP boundary retains transport rejection, hook order and empty-collection execution', async () => {
    const calls: string[] = [];
    let input: unknown;
    const handle = createSchemaFormHandler(form, { allowedOrigins: [origin], authenticate: () => { calls.push('authenticate'); return {}; }, csrfToken: () => { calls.push('csrf'); return 'token'; }, authorize: () => { calls.push('authorize'); return true; }, execute: ({ input: value }) => { calls.push('execute'); input = value; return 'ok'; }, project: (x) => x, success: () => ({ location: '/done' }) });
    expect((await handle(request(valid))).status).toBe(303);
    expect(calls).toEqual(['authenticate', 'csrf', 'authorize', 'execute']);
    expect((input as any).items).toHaveLength(2);
    expect((await handle(request([]))).status).toBe(303);
    expect(input).toEqual({ items: [] });
    for (const data of [[...valid, ['items[0].rowId', 'duplicate']], [['items[3].rowId', 'out']], [['items[00].rowId', 'alias']], [['items[0].unknown', 'x']], [['items[0].__proto__.polluted', 'x']]] as const) expect((await handle(request(data))).status).toBe(400);
    expect(({} as any).polluted).toBeUndefined();
    expect((await handle(request([['items[0].quantity', '2']]))).status).toBe(422);
  });

  test('422 renders only active rows and maps member errors to stable labels and links', async () => {
    const raw = Object.fromEntries([['items[0].rowId', 'first'], ['items[0].quantity', '9']]);
    const issues = [{ field: 'items[0].quantity', code: 'MAXIMUM', message: 'Too many' }];
    const state = createFormState(raw, issues);
    const id = getSchemaFieldId(form, 'items[0].quantity', state);
    const html = renderSchemaFormErrors(form, raw, issues, 'token');
    expect(html).toContain(`label for="${id}"`);
    expect(html).toContain(`href="#${id}"`);
    expect(html).toContain(`id="${id}-error"`);
    expect(html).not.toContain('items[1]');
    expect(html).not.toContain('items[2]');
    expect(getSchemaFieldProps(form, 'items[0].quantity', { state })['aria-describedby']).toBe(`${id}-error`);
    const duplicateKeys = createFormState({ 'items[0].rowId': 'same', 'items[1].rowId': 'same' }, []);
    expect(getSchemaFieldId(form, 'items[0].quantity', duplicateKeys)).not.toBe(getSchemaFieldId(form, 'items[1].quantity', duplicateKeys));
  });

  test('typed row helpers preserve member names and stable DOM identity across reorder', () => {
    const helpers = createFormHelpers(form);
    const row = helpers.row('items', 0, 'stable');
    const name: `items[${number}].quantity` = row.name('quantity');
    expect(name).toBe('items[0].quantity');
    expect(row.field('quantity').id).toBe(helpers.row('items', 2, 'stable').field('quantity').id);
    expect(row.rowKey()).toMatchObject({ name: 'items[0].rowId', value: 'stable', type: 'hidden' });
    expect(() => helpers.row('items', 3, 'key')).toThrow('index');
    if (false) {
      // @ts-expect-error dynamic row members are checked independently of scalar fields
      row.field('quanity');
      // @ts-expect-error a dynamic row does not grant arbitrary scalar names
      helpers.field('items[0].quantity');
      // @ts-expect-error unknown collection names are rejected
      helpers.row('other', 0, 'key');
    }
  });

  test('add/remove/reorder are immutable and enforce bounded unique host-owned keys', () => {
    const input = [{ key: 'first', value: { quantity: 1 } }, { key: 'second', value: { quantity: 2 } }];
    const rows = createCollectionRows(input);
    const appended = appendCollectionRow(rows, { key: 'third', value: { quantity: 3 } }, 3);
    expect(moveCollectionRow(appended, 'third', 0).map(({ key }) => key)).toEqual(['third', 'first', 'second']);
    expect(removeCollectionRow(appended, 'second').map(({ key }) => key)).toEqual(['first', 'third']);
    expect(input.map(({ key }) => key)).toEqual(['first', 'second']);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(Object.isFrozen(input[0]!.value)).toBe(false);
    expect(() => appendCollectionRow(rows, { key: 'first', value: { quantity: 3 } })).toThrow('unique');
    expect(() => appendCollectionRow(rows, { key: 'third', value: { quantity: 3 } }, 2)).toThrow('limit');
    expect(() => moveCollectionRow(rows, 'first', 2)).toThrow('index');
    expect(() => removeCollectionRow(rows, 'unknown')).toThrow('unknown');
  });

  test('nested collections preserve fixed siblings and initialize empty arrays without mutation', () => {
    const prepared = prepareFormTransport({ 'user.name': { type: 'string' } }, { 'user.items': collection, 'user.other': collection });
    const decoded = decodeFormTransport(prepared, entries([['user.name', 'Ada']])).validation;
    expect(decoded).toEqual({ ok: true, value: { user: { name: 'Ada', items: [], other: [] } } });
    if (decoded.ok) expect(Object.isFrozen((decoded.value.user as any).items)).toBe(true);
  });
});
