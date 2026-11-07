import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createFormHandler, createSchemaFormHandler, defineForm, defineSchemaForm } from '../../src/index.ts';
import { createFormRequest, createFormTestClient } from '../../src/testing/index.ts';

const origin = 'https://app.test';
const form = defineForm({
  id: 'feedback.send', path: '/feedback',
  input: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1 } } },
  output: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } },
});
const token = 'explicit-test-token';
function client(trace: string[] = []) {
  return createFormTestClient(form, createFormHandler(form, {
    allowedOrigins: [origin], authenticate: (request) => { trace.push('authenticate'); return request.headers.get('authorization') === 'test-principal' ? { id: 'p' } : null; },
    csrfToken: () => { trace.push('csrf'); return token; },
    authorize: () => { trace.push('authorize'); return true; },
    execute: ({ input }) => { trace.push('execute'); return { message: input.name }; },
    project: (value) => value, success: () => ({ location: '/done' }),
  }), { origin });
}
const auth = { authorization: 'test-principal' };

describe('native Request testing helpers', () => {
  test('runs actual authentication/CSRF/validation/effects and returns actual HTML responses', async () => {
    const trace: string[] = [];
    const tester = client(trace);
    expect((await tester.submit({ entries: [['name', 'Ada']], csrfToken: token })).status).toBe(401);
    expect(trace).toEqual(['authenticate']);
    trace.length = 0;
    const forbidden = await tester.submit({ headers: auth, entries: [['name', 'Ada']], csrfToken: 'wrong' });
    expect(forbidden.status).toBe(403);
    expect(trace).toEqual(['authenticate', 'csrf']);
    trace.length = 0;
    const invalid = await tester.submit({ headers: auth, entries: [['name', '']], csrfToken: token });
    expect(invalid.status).toBe(422);
    expect(invalid.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await invalid.text()).toContain('aria-invalid="true"');
    expect(trace).toEqual(['authenticate', 'csrf']);
    trace.length = 0;
    const success = await tester.submit({ headers: auth, entries: [['name', 'Ada']], csrfToken: token });
    expect(success.status).toBe(303);
    expect(success.headers.get('location')).toBe('/done');
    expect(trace).toEqual(['authenticate', 'csrf', 'authorize', 'execute']);
  });

  test('preserves ordered duplicate/unknown fields and leaves caller entries unchanged', async () => {
    const entries = new URLSearchParams([['name', 'Ada'], ['name', 'Grace'], ['extra', 'x']]);
    const request = createFormRequest(form, { origin, entries, csrfToken: token, requestKey: 'request_key_0000001' });
    expect(await request.text()).toBe('_bc_csrf=explicit-test-token&_bc_request=request_key_0000001&name=Ada&name=Grace&extra=x');
    expect([...entries]).toEqual([['name', 'Ada'], ['name', 'Grace'], ['extra', 'x']]);
    const tester = client();
    expect((await tester.submit({ headers: auth, csrfToken: token, entries: [['name', 'a'], ['name', 'b']] })).status).toBe(400);
    expect((await tester.submit({ headers: auth, csrfToken: token, entries: [['name', 'a'], ['extra', 'x']] })).status).toBe(400);
    expect((await tester.submit({ headers: auth, entries: [['name', 'a']] })).status).toBe(400);
  });

  test('retains declared repeated values and real Standard Schema transforms', async () => {
    const rich = defineSchemaForm({ id: 'tags.save', path: '/tags', fields: { tags: { type: 'array', items: { type: 'string' } } },
      input: z.object({ tags: z.array(z.string()) }).transform(({ tags }) => ({ ordered: tags.join(',') })), output: z.object({ message: z.string() }) });
    const values: string[] = [];
    const tester = createFormTestClient(rich, createSchemaFormHandler(rich, {
      allowedOrigins: [origin], authenticate: () => ({ id: 'p' }), csrfToken: () => token, authorize: () => true,
      execute: ({ input }) => { values.push(input.ordered); return { message: input.ordered }; }, project: (value) => value, success: () => ({ location: '/done' }),
    }), { origin });
    expect((await tester.submit({ csrfToken: token, entries: [['tags', 'b'], ['tags', 'a'], ['tags', 'b']] })).status).toBe(303);
    expect(values).toEqual(['b,a,b']);
  });

  test('copies headers, retains explicit overrides, and supports missing-Origin negative cases', async () => {
    const headers = new Headers({ origin: 'https://attacker.test', 'content-type': 'application/json', authorization: 'test-principal' });
    const request = createFormRequest(form, { origin, headers, entries: [['name', 'Ada']], csrfToken: token });
    headers.set('origin', origin);
    expect(request.headers.get('origin')).toBe('https://attacker.test');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect((await client().submit({ headers: { ...auth, origin: 'https://attacker.test' }, csrfToken: token })).status).toBe(403);
    expect(createFormRequest(form, { sendOrigin: false }).headers.has('origin')).toBe(false);
    expect((await client().submit({ headers: auth, sendOrigin: false, csrfToken: token })).status).toBe(403);
    const typed = createFormRequest(form, { headers: { 'content-type': 'application/json' } });
    expect(typed.headers.get('content-type')).toBe('application/json');
    expect((await client().submit({ headers: { ...auth, 'content-type': 'application/json' } })).status).toBe(415);
  });

  test('passes raw malformed input with explicit media type instead of normalizing it', async () => {
    const rawBody = '_bc_csrf=explicit-test-token&name=%ZZ';
    expect(await createFormRequest(form, { rawBody }).text()).toBe(rawBody);
    expect(createFormRequest(form, { rawBody }).headers.get('content-type')).not.toBe('application/x-www-form-urlencoded');
    const response = await client().submit({ headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, rawBody });
    expect(response.status).toBe(400);
    expect(() => {
      // @ts-expect-error raw bodies and encoded entries cannot be silently combined
      createFormRequest(form, { rawBody, entries: [['name', 'Ada']] });
    }).toThrow('rawBody cannot be combined');
  });

  test('preserves request cancellation and propagates supplied handler errors', async () => {
    const controller = new AbortController();
    const reason = new Error('stop test');
    const request = createFormRequest(form, { signal: controller.signal });
    controller.abort(reason);
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toBe(reason);
    const tester = createFormTestClient(form, () => { throw reason; });
    await expect(tester.submit()).rejects.toBe(reason);
  });

  test('rejects unsafe test origins and snapshots the client target', async () => {
    for (const value of ['https://app.test/', 'https://app.test/path', 'https://user:password@app.test', 'file:///tmp/test', 'https://app.test?x=1', 'https://app.test#fragment']) {
      expect(() => createFormRequest(form, { origin: value })).toThrow(TypeError);
      expect(() => createFormTestClient(form, () => new Response(), { origin: value })).toThrow(TypeError);
    }
    expect(() => createFormRequest({ path: '//attacker.test/form' })).toThrow('absolute local path');
    const target = { path: '/original' };
    const tester = createFormTestClient(target, (request) => new Response(request.url));
    target.path = '/changed';
    expect(await (await tester.submit()).text()).toBe('https://typehtml.test/original');
    expect(Object.isFrozen(tester)).toBe(true);
    expect(client().request({ origin: undefined }).url).toBe(`${origin}/feedback`);
    expect((await client().submit({ method: 'GET' })).status).toBe(405);
    expect(() => createFormRequest(form, { method: 'GET', entries: [] })).toThrow('GET/HEAD');
  });
});
