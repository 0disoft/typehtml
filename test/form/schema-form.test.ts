import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import * as v from 'valibot';
import { type } from 'arktype';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import {
  defineSchemaForm, createSchemaFormHandler, getSchemaFieldProps, createFormState, prepareFields,
  validateStandard, type SchemaFormInput, renderSchemaFormErrors,
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

/** Selected successful controls from parsed HTML, rather than source-string regexes. */
function successfulFields(html: string): readonly (readonly [string, string])[] {
  type Element = DefaultTreeAdapterTypes.Element;
  type Node = DefaultTreeAdapterTypes.Node;
  const fields: [string, string][] = [];
  const attribute = (node: Element, name: string) => node.attrs.find((attr) => attr.name === name)?.value;
  const text = (node: Node): string => 'value' in node ? node.value : 'childNodes' in node ? node.childNodes.map(text).join('') : '';
  const visit = (node: Node) => {
    if ('tagName' in node) {
      const name = attribute(node, 'name');
      if (name !== undefined && attribute(node, 'disabled') === undefined) {
        if (node.tagName === 'input') {
          const type = attribute(node, 'type') ?? 'text';
          if (!['submit', 'button', 'reset'].includes(type) && (!['checkbox', 'radio'].includes(type) || attribute(node, 'checked') !== undefined)) {
            const value = attribute(node, 'value') ?? (['checkbox', 'radio'].includes(type) ? 'on' : '');
            fields.push([name, type === 'text' ? value.replace(/[\r\n]/g, '') : value]);
          }
        } else if (node.tagName === 'textarea') fields.push([name, text(node)]);
        else if (node.tagName === 'select') {
          const options = node.childNodes.filter((item): item is Element => 'tagName' in item && item.tagName === 'option');
          const selected = options.filter((option) => attribute(option, 'selected') !== undefined);
          const values = selected.length === 0 && attribute(node, 'multiple') === undefined ? options.slice(0, 1) : selected;
          for (const option of values) fields.push([name, attribute(option, 'value') ?? text(option)]);
        }
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  };
  visit(parse(html));
  return fields;
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

  test('maps a nested repeated element issue to its full fixed wire path', async () => {
    const repeated = defineSchemaForm({ id: 'nested.repeat', path: '/profile', fields: {
      'items[0].tags': { type: 'array', items: { type: 'string' } },
    }, input: z.object({ items: z.array(z.object({ tags: z.array(z.string().min(2)) })) }), output: z.string() });
    let issueField: string | null | undefined;
    const handle = createSchemaFormHandler(repeated, { allowedOrigins: [origin], authenticate: () => ({}), csrfToken: () => 'token', authorize: () => true,
      execute: () => 'ok', project: (x) => x, success: () => ({ location: '/' }),
      invalid: (context) => { issueField = context.issues[0]?.field; return renderSchemaFormErrors(repeated, context.rawValues, context.issues, context.csrfToken); },
    });
    const response = await handle(request(new URLSearchParams([['_bc_csrf', 'token'], ['items[0].tags', 'a']])));
    const html = await response.text();
    expect(response.status).toBe(422);
    expect(issueField).toBe('items[0].tags');
    expect(html).toContain('name="items[0].tags" type="text" aria-invalid="true"');
    expect(html).toContain('a href="#field-');
  });

  test('projects the output schema input and passes its transformed output to success', async () => {
    const transformed = defineSchemaForm({ id: 'output.transform', path: '/profile', fields: { name: { type: 'string' } },
      input: z.object({ name: z.string() }),
      output: z.object({ count: z.string().transform((value) => ({ total: Number(value) })) }),
    });
    let count: number | undefined;
    const handle = createSchemaFormHandler(transformed, { allowedOrigins: [origin], authenticate: () => ({}), csrfToken: () => 'token', authorize: () => true,
      execute: () => ({ count: '7' }), project: (result) => result,
      success: (result) => { count = result.count.total; return { location: `/done?count=${result.count.total}` }; },
    });
    const response = await handle(request(new URLSearchParams({ _bc_csrf: 'token', name: 'Ada' })));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/done?count=7');
    expect(count).toBe(7);
    if (false) {
      createSchemaFormHandler(transformed, { allowedOrigins: [origin], authenticate: () => ({}), csrfToken: () => 'token', authorize: () => true,
        execute: () => '7',
        // @ts-expect-error project returns the vendor schema's input, not its transformed output
        project: () => ({ count: { total: 7 } }),
        success: () => ({ location: '/' }),
      });
    }
  });

  test('treats an unrepresentable root array issue as a form-level error', async () => {
    const rootIssue = defineSchemaForm({ id: 'root.issue', path: '/profile', fields: { name: { type: 'string' } },
      input: { '~standard': { version: 1, vendor: 'test', validate: () => ({ issues: [{ message: 'root array issue', path: [0] }] }) } }, output: z.string(),
    });
    let issueField: string | null | undefined;
    const handle = createSchemaFormHandler(rootIssue, { allowedOrigins: [origin], authenticate: () => ({}), csrfToken: () => 'token', authorize: () => true,
      execute: () => 'ok', project: (value) => value, success: () => ({ location: '/' }),
      invalid: (context) => { issueField = context.issues[0]?.field; return 'invalid'; },
    });
    expect((await handle(request(new URLSearchParams({ _bc_csrf: 'token', name: 'Ada' })))).status).toBe(422);
    expect(issueField).toBeNull();
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

  test('parsed 422 HTML preserves invalid choices, leading textarea LF and repeated-value order', () => {
    const redisplay = defineSchemaForm({ id: 'redisplay', path: '/profile', fields: {
      note: { type: 'string', control: 'textarea' },
      channel: { type: 'string', enum: ['email', 'paper'], control: 'radio' },
      delivery: { type: 'string', enum: ['email', 'paper'], control: 'select' },
      checkbox: { type: 'string', enum: ['yes', 'no'], control: 'checkbox' },
      agreed: { type: 'boolean', trueValue: 'yes' },
      explicit: { type: 'boolean', trueValue: 'yes', falseValue: 'no' },
      flags: { type: 'array', items: { type: 'boolean', trueValue: 'yes', falseValue: 'no' } },
      tags: { type: 'array', items: { type: 'string' } },
    }, input: z.unknown(), output: z.string() });
    const raw = { note: '\nfirst\nlast', channel: '<invalid>', delivery: 'other', checkbox: 'no', agreed: 'invalid', explicit: 'no', flags: ['no', 'yes', 'no'], tags: ['b', '\na\nb', 'b'] };
    const html = renderSchemaFormErrors(redisplay, raw, [{ field: 'channel', code: 'ENUM', message: 'bad' }], 'token');
    const selected = successfulFields(html);
    for (const [name, value] of Object.entries(raw)) {
      expect(selected.filter(([field]) => field === name).map(([, value]) => value)).toEqual(typeof value === 'string' ? [value] : value);
    }
    expect(html).not.toContain('<invalid>');
    expect(selected.filter(([name]) => name === '_bc_csrf')).toEqual([['_bc_csrf', 'token']]);
    expect(getSchemaFieldProps(redisplay, 'explicit', { state: createFormState({ explicit: 'no' }, []), optionValue: 'no' }).checked).toBe(true);
  });

  test('parsed 422 HTML preserves scalar radio values without an enum', () => {
    const radio = defineSchemaForm({ id: 'radio.scalar', path: '/profile', fields: {
      free: { type: 'string', control: 'radio' },
      constant: { type: 'integer', const: 1, control: 'radio' },
    }, input: z.unknown(), output: z.string() });
    const html = renderSchemaFormErrors(radio, { free: 'custom', constant: '2' }, [{ field: 'constant', code: 'CONST', message: 'must be one' }], 'token');
    const selected = successfulFields(html);
    expect(selected.filter(([name]) => name === 'free')).toEqual([['free', 'custom']]);
    expect(selected.filter(([name]) => name === 'constant')).toEqual([['constant', '2']]);
  });

  test('snapshots null-prototype field data while rejecting getters and non-data descriptors without executing them', () => {
    const allowed = ['a', 'b'];
    const fields = Object.assign(Object.create(null), { tags: { type: 'array', items: { type: 'string', enum: allowed } } });
    const snapshot = prepareFields(fields);
    allowed.push('c');
    fields.tags.items.enum = ['changed'];
    expect(snapshot.tags).toMatchObject({ items: { enum: ['a', 'b'] } });
    expect(Object.isFrozen(allowed)).toBe(false);
    expect(Object.isFrozen((snapshot.tags as any).items.enum)).toBe(true);
    let calls = 0;
    const accessor = Object.defineProperty({}, 'name', { enumerable: true, get() { calls++; return { type: 'string' }; } });
    expect(() => prepareFields(accessor)).toThrow('data properties');
    const nested = { name: Object.defineProperty({ type: 'string' }, 'enum', { enumerable: true, get() { calls++; return ['a']; } }) };
    expect(() => prepareFields(nested as any)).toThrow('data properties');
    expect(calls).toBe(0);
    expect(() => prepareFields({ name: { type: 'array', items: null } } as any)).toThrow('scalar field');
    const cyclic: any = {}; cyclic.name = cyclic;
    expect(() => prepareFields(cyclic)).toThrow('cycles');
    class Descriptor { type = 'string'; }
    expect(() => prepareFields({ name: new Descriptor() } as any)).toThrow('plain objects');
  });
});
