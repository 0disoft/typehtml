import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import * as v from 'valibot';
import { type } from 'arktype';
import {
  defineSchemaForm, createSchemaFormHandler, getSchemaFieldProps, createFormState, prepareFields,
  validateStandard, type SchemaFormInput,
} from '../../src/index.ts';

const origin = 'https://app.test';
const form = defineSchemaForm({
  id: 'profile.save', path: '/profile',
  fields: {
    'user.name': { type: 'string', minLength: 1, required: true },
    tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1, maxItems: 3 },
    accepted: { type: 'boolean' },
    'items[0].quantity': { type: 'integer', minimum: 1, maximum: 3, required: true },
    note: { type: 'string', control: 'textarea' },
    channel: { type: 'string', enum: ['email', 'paper'], control: 'radio' },
  },
  input: z.object({ user: z.object({ name: z.string().transform((name) => name.toUpperCase()) }), tags: z.array(z.string()), accepted: z.boolean(), items: z.array(z.object({ quantity: z.number() })), note: z.string().optional(), channel: z.string().optional() }),
  output: z.object({ message: z.string() }),
});
const body = (extra: readonly (readonly [string, string])[] = []) => new URLSearchParams(([
  ['_bc_csrf', 'token'], ['user.name', 'Ada'], ['tags', 'b'], ['tags', 'a'], ['tags', 'b'], ['items[0].quantity', '2'], ...extra,
] as readonly (readonly [string, string])[]).map(([key, value]) => [key, value]));
const request = (data = body()) => new Request(origin + '/profile', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: data });
function handler(overrides: { execute?: (input: SchemaFormInput<typeof form>) => void; invalid?: (context: any) => string; onError?: (error: unknown) => void } = {}) {
  return createSchemaFormHandler(form, {
    allowedOrigins: [origin], authenticate: () => ({ id: 'p' }), csrfToken: () => 'token', authorize: () => true,
    execute: ({ input }) => { overrides.execute?.(input); return { message: input.user.name }; },
    project: (value) => value, success: () => ({ location: '/done' }), invalid: overrides.invalid, onError: overrides.onError,
  });
}

describe('Standard Schema native forms', () => {
  test('decodes explicit nested paths, ordered repeated values, unchecked booleans and transformations', async () => {
    let observed: SchemaFormInput<typeof form> | undefined;
    expect((await handler({ execute: (input) => { observed = input; } })(request())).status).toBe(303);
    expect(observed).toEqual({ user: { name: 'ADA' }, tags: ['b', 'a', 'b'], accepted: false, items: [{ quantity: 2 }] });
    // @ts-expect-error Standard Schema output is inferred through transforms.
    const bad: SchemaFormInput<typeof form> = { user: { name: 2 } };
    void bad;
  });

  test('retains strict scalar/protocol duplicates and unknown-key rejection', async () => {
    for (const extra of [[['user.name', 'Other']], [['_bc_csrf', 'token']], [['unknown', 'x']], [['user.__proto__.polluted', 'yes']]] as const) {
      expect((await handler()(request(body(extra)))).status).toBe(400);
    }
    expect(({} as any).polluted).toBeUndefined();
  });

  test.each([0, 1, 3, 4])('enforces integer boundary %i before vendor validation', async (quantity) => {
    const data = body(); data.set('items[0].quantity', String(quantity));
    expect((await handler()(request(data))).status).toBe(quantity >= 1 && quantity <= 3 ? 303 : 422);
  });

  test('preserves raw arrays, control values, escaping and translated errors on 422', async () => {
    const data = body([['note', '</textarea><script>x</script>'], ['accepted', 'on'], ['channel', 'email']]);
    data.set('items[0].quantity', '4');
    const handle = createSchemaFormHandler(form, {
      allowedOrigins: [origin], authenticate: () => ({}), csrfToken: () => 'token', authorize: () => true,
      execute: () => ({ message: 'ok' }), project: (x) => x, success: () => ({ location: '/' }),
      errors: { locale: 'ko', title: '입력 확인', messages: { MAXIMUM: '수량 초과' } },
    });
    const response = await handle(request(data)); const html = await response.text();
    expect(response.status).toBe(422); expect(html).toContain('lang="ko"'); expect(html).toContain('수량 초과');
    expect(html).toContain('&lt;/textarea&gt;&lt;script&gt;'); expect(html).not.toContain('<script>');
    expect([...html.matchAll(/<input[^>]*name="tags"[^>]*value="([^"]*)"/g)].map((match) => match[1])).toEqual(['b', 'a', 'b']);
    expect(html).toContain('checked'); expect(html).toContain('aria-invalid');
  });

  test('validates using actual Zod, Valibot, and ArkType Standard Schema implementations', async () => {
    const data = { name: 'Ada', age: 2 };
    for (const schema of [z.object({ name: z.string(), age: z.number() }), v.object({ name: v.string(), age: v.number() }), type({ name: 'string', age: 'number' })]) {
      expect((await validateStandard(schema, data)).issues).toBeUndefined();
      expect((await validateStandard(schema, { name: 5, age: 'two' })).issues?.length).toBeGreaterThan(0);
    }
  });

  test('supports checkbox true tokens and multiple-select error props', () => {
    const state = createFormState({ accepted: 'on', tags: ['a'] }, [{ field: 'tags', code: 'X', message: 'invalid' }]);
    expect(getSchemaFieldProps(form, 'accepted', { state })).toMatchObject({ type: 'checkbox', checked: true });
    expect(getSchemaFieldProps(form, 'tags', { state })).toMatchObject({ multiple: true, 'aria-invalid': 'true' });
  });

  test('422 omits absent optional scalars instead of introducing empty values on resubmission', async () => {
    const data = body(); data.set('items[0].quantity', '4');
    const html = await (await handler()(request(data))).text();
    expect(html).not.toContain('name="note"');
    expect(html).not.toContain('name="channel"');
    expect(html).toContain('name="items[0].quantity"');
    expect(() => prepareFields({ agreed: { type: 'boolean', control: 'radio' } })).toThrow('checkbox');
  });

  test('maps vendor array-element issues back to the declared repeated control', async () => {
    const repeated = defineSchemaForm({ id: 'repeat.form', path: '/profile', fields: { tags: { type: 'array', items: { type: 'string' } } }, input: z.object({ tags: z.array(z.string().min(2)) }), output: z.string() });
    const handle = createSchemaFormHandler(repeated, { allowedOrigins: [origin], authenticate: () => ({}), csrfToken: () => 'token', authorize: () => true, execute: () => 'ok', project: (x) => x, success: () => ({ location: '/' }) });
    const response = await handle(request(new URLSearchParams([['_bc_csrf', 'token'], ['tags', 'a'], ['tags', 'b']])));
    const html = await response.text();
    expect(response.status).toBe(422); expect(html).toContain('name="tags" type="text" aria-invalid="true"');
    expect(html).not.toContain('tags[0]');
  });

  test('preserves explicit false boolean tokens and repeated boolean values on 422', async () => {
    const booleans = defineSchemaForm({ id: 'bool.form', path: '/profile', fields: {
      agreed: { type: 'boolean', trueValue: 'yes', falseValue: 'no', required: true },
      flags: { type: 'array', items: { type: 'boolean', trueValue: 'yes', falseValue: 'no' } },
      quantity: { type: 'integer', minimum: 1, required: true },
    }, input: z.unknown(), output: z.string() });
    const handle = createSchemaFormHandler(booleans, { allowedOrigins: [origin], authenticate: () => ({}), csrfToken: () => 'token', authorize: () => true, execute: () => 'ok', project: (x) => x, success: () => ({ location: '/' }) });
    const response = await handle(request(new URLSearchParams([['_bc_csrf', 'token'], ['agreed', 'no'], ['flags', 'no'], ['flags', 'yes'], ['flags', 'no'], ['quantity', '0']])));
    const html = await response.text();
    expect(response.status).toBe(422); expect(html).toContain('<option value="no" selected>');
    expect([...html.matchAll(/<input[^>]*name="flags"[^>]*value="([^"]*)"/g)].map((match) => match[1])).toEqual(['no', 'yes', 'no']);
  });

  test('rejects path overlap, prototype components, mixed containers and index bombs at definition', () => {
    for (const fields of [
      { a: { type: 'string' }, 'a.b': { type: 'string' } },
      { 'a.constructor.x': { type: 'string' } },
      { 'a[0]': { type: 'string' }, 'a.b': { type: 'string' } },
      { 'a[1024]': { type: 'string' } },
      { 'a[01]': { type: 'string' } },
    ]) expect(() => prepareFields(fields as any)).toThrow();
  });

  test('rejects indexed-array holes and repeated-value count over the boundary', async () => {
    const sparse = defineSchemaForm({ id: 'sparse.form', path: '/profile', fields: { 'items[1].name': { type: 'string' } }, input: z.unknown(), output: z.string() });
    const handle = createSchemaFormHandler(sparse, { allowedOrigins: [origin], authenticate: () => ({}), csrfToken: () => 'token', authorize: () => true, execute: () => 'ok', project: (x) => x, success: () => ({ location: '/' }) });
    expect((await handle(request(new URLSearchParams({ _bc_csrf: 'token', 'items[1].name': 'x' })))).status).toBe(422);
    expect((await handler()(request(body([['tags', 'a']])))).status).toBe(422);
  });
});
