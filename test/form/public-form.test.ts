import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFormHandler, defineForm, FORM_FORMAT, FormHttpError, loadForm, projectForm, verifyFormSource,
  type FormHandlerOptions, type InferInput, type InferOutput,
} from '../../src/index.ts';

const form = defineForm({
  id: 'feedback.send', path: '/feedback',
  input: { type: 'object', additionalProperties: false, required: ['displayName', 'copies'], properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 64 },
    copies: { type: 'integer', minimum: -3, maximum: 9 },
    channel: { type: 'string', enum: ['email', 'paper'] },
  } },
  output: { type: 'object', additionalProperties: false, required: ['message', 'state'], properties: {
    message: { type: 'string', maxLength: 64 }, state: { type: 'string', const: 'sent' },
  } },
});

type Principal = { id: string; token: string };
type Result = { message: string; state: 'sent'; privateNote: string };
const origin = 'http://localhost';

function options(): FormHandlerOptions<typeof form.input.schema, typeof form.output, Principal, Result> {
  return {
    allowedOrigins: [origin], authenticate: () => ({ id: 'person', token: 'synthetic-token' }),
    csrfToken: ({ principal }) => principal.token, authorize: () => true,
    execute: ({ input }) => ({ message: `${input.displayName}:${input.copies}`, state: 'sent', privateNote: 'must not leave the handler' }),
    project: ({ message, state }) => ({ message, state }),
    success: (output) => ({ location: `/thanks?message=${encodeURIComponent(output.message)}` }),
  };
}

function request(body: string | Record<string, string>, init: RequestInit = {}, path = '/feedback') {
  return new Request(origin + path, {
    method: 'POST', ...init,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin, ...Object.fromEntries(new Headers(init.headers)) },
    body: typeof body === 'string' ? body : new URLSearchParams(body).toString(),
  });
}

const valid = { _bc_csrf: 'synthetic-token', displayName: 'Ada', copies: '-2' };

describe('public generic forms', () => {
  it('infers non-order field types, optional enum input, and literal output values', () => {
    const accepted: InferInput<typeof form> = { displayName: 'Ada', copies: 2, channel: 'paper' };
    const withoutOptional: InferInput<typeof form> = { displayName: 'Ada', copies: 2 };
    const output: InferOutput<typeof form> = { message: 'ok', state: 'sent' };
    // @ts-expect-error decimal-integer inputs decode to number
    const wrongWire: InferInput<typeof form> = { displayName: 'Ada', copies: '2' };
    // @ts-expect-error required schema keys are required
    const missing: InferInput<typeof form> = { displayName: 'Ada' };
    // @ts-expect-error finite enums remain literal unions
    const wrongEnum: InferInput<typeof form> = { displayName: 'Ada', copies: 2, channel: 'sms' };
    // @ts-expect-error output const is preserved
    const wrongOutput: InferOutput<typeof form> = { message: 'ok', state: 'other' };
    expect([accepted.copies, withoutOptional.copies, output.state]).toEqual([2, 2, 'sent']);
    void wrongWire; void missing; void wrongEnum; void wrongOutput;
  });

  it('validates definitions and snapshots them independently of caller mutations', () => {
    const definition = structuredClone(form.definition) as any;
    const copy = defineForm(definition);
    definition.input.properties.copies.maximum = 100;
    expect(copy.input.schema.properties.copies).toMatchObject({ maximum: 9 });
    expect(Object.isFrozen(copy.input.schema.properties.copies)).toBe(true);
    for (const path of ['//external.test', '/a/../feedback', '/feedback?x=1', '/feedback/:id', '/a%2fb']) {
      expect(() => defineForm({ ...form.definition, path })).toThrow();
    }
    expect(() => defineForm({ ...form.definition, limits: { maxBytes: 0 } })).toThrow('invalid form limit');
    expect(() => defineForm({ ...form.definition, input: { ...form.definition.input, properties: { ...form.definition.input.properties, nested: { type: 'object' } } } } as any)).toThrow();
  });

  it('loads static manifests and verifies their exact projection and source digest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'typehtml-public-manifest-'));
    try {
      const path = join(directory, 'feedback.form.json');
      await writeFile(path, JSON.stringify({ ...form.definition, format: FORM_FORMAT }));
      const loaded = await loadForm(path);
      const check = projectForm(loaded.form, { sourcePath: 'feedback.form.json', sourceSha256: loaded.sourceSha256 });
      expect(check.status).toBe('generated');
      expect(check.protocolFields).toEqual(['_bc_csrf']);
      expect(check.input.codecs).toEqual({ channel: 'text', copies: 'decimal-integer', displayName: 'text' });
      expect(() => verifyFormSource(check, loaded)).not.toThrow();
      const forged = structuredClone(check) as any;
      forged.input.schema.properties.copies.maximum = 100;
      expect(() => verifyFormSource(forged, loaded)).toThrow('does not match');
      await writeFile(path, JSON.stringify(form.definition, null, 2));
      expect(() => verifyFormSource(check, loaded)).not.toThrow();
      const changed = await loadForm(path);
      expect(changed.form.behaviorSha256).toBe(loaded.form.behaviorSha256);
      expect(() => verifyFormSource(check, changed)).toThrow('source bytes have changed');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('handles a generic flat native form and exposes only its public projection', async () => {
    const order: string[] = [];
    const config = options();
    const handle = createFormHandler(form, {
      ...config,
      authenticate: () => { order.push('authenticate'); return { id: 'person', token: 'synthetic-token' }; },
      csrfToken: (context) => { order.push('csrf'); return config.csrfToken(context); },
      authorize: (context) => { order.push('authorize'); expect(Object.isFrozen(context.input)).toBe(true); return config.authorize(context); },
      execute: (context) => { order.push('execute'); return config.execute(context); },
      project: (result) => { order.push('project'); return config.project(result); },
      success: (output) => { order.push('success'); expect(Object.isFrozen(output)).toBe(true); return config.success(output); },
    });
    const response = await handle(request(valid));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/thanks?message=Ada%3A-2');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).not.toContain('privateNote');
    expect(order).toEqual(['authenticate', 'csrf', 'authorize', 'execute', 'project', 'success']);
  });

  it('renders bounded declared raw input with escaped field errors on 422', async () => {
    let executed = false;
    const handle = createFormHandler(form, { ...options(), execute: () => { executed = true; throw new Error('must not run'); } });
    const response = await handle(request({ ...valid, displayName: '"><script>alert(1)</script>', copies: '1e1' }));
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain('&quot;&gt;&lt;script&gt;');
    expect(body).not.toContain('<script>');
    expect(body).toContain('aria-describedby="field-copies-error"');
    expect(body).toContain('href="#field-copies"');
    expect(body).toContain('value="1e1"');
    expect(executed).toBe(false);
  });

  it('preserves absence of optional integer and enum fields in the default 422 form', async () => {
    const optional = defineForm({
      ...form.definition,
      input: {
        ...form.definition.input,
        properties: { ...form.definition.input.properties, bonus: { type: 'integer' } },
      },
    });
    let executedInput: unknown;
    const handle = createFormHandler(optional, {
      ...options(),
      execute: ({ input }) => {
        executedInput = input;
        return { message: 'ok', state: 'sent' as const, privateNote: '' };
      },
    });
    const invalid = await handle(request({ ...valid, copies: '100' }));
    expect(invalid.status).toBe(422);
    const body = await invalid.text();
    expect(body).toContain('name="copies"');
    expect(body).not.toContain('name="bonus"');
    expect(body).not.toContain('name="channel"');
    const corrected = await handle(request(valid));
    expect(corrected.status).toBe(303);
    expect(executedInput).toEqual({ copies: -2, displayName: 'Ada' });

    const suppliedOptional = await handle(request({ ...valid, copies: '100', channel: 'paper', bonus: '2' }));
    const suppliedBody = await suppliedOptional.text();
    expect(suppliedBody).toContain('name="bonus"');
    expect(suppliedBody).toContain('name="channel"');
    expect(suppliedBody).toContain('value="paper"');
    expect(suppliedBody).toContain('value="2"');
  });

  it('rejects transport, structural, Origin and CSRF failures before execution', async () => {
    let executed = 0;
    const handle = createFormHandler(form, { ...options(), execute: () => { executed++; return { message: 'ok', state: 'sent' as const, privateNote: '' }; } });
    const cases: [Request, number][] = [
      [request({ ...valid, extra: 'x' }), 400],
      [request(new URLSearchParams(valid) + '&copies=2'), 400],
      [request({ ...valid, _bc_csrf: 'wrong' }), 403],
      [request(valid, { headers: { origin: 'http://foreign.test' } }), 403],
      [request(valid, { headers: { accept: 'application/json' } }), 406],
      [request(valid, { headers: { 'content-type': 'multipart/form-data' } }), 415],
      [request({ ...valid, displayName: 'x'.repeat(20_000) }), 413],
      [request(valid, {}, '/feedback?x=1'), 400],
      [request(valid, {}, '/other'), 404],
      [request({ ...valid, _bc_request: 'unexpected' }), 400],
    ];
    for (const [req, status] of cases) expect((await handle(req)).status).toBe(status);
    const method = await handle(new Request(origin + '/feedback'));
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('POST');
    expect(executed).toBe(0);
  });

  it('requires explicit authentication and current authorization', async () => {
    let executed = false;
    const unauthenticated = createFormHandler(form, { ...options(), authenticate: () => null });
    expect((await unauthenticated(request(valid))).status).toBe(401);
    const denied = createFormHandler(form, { ...options(), authorize: () => false, execute: () => { executed = true; throw new Error('no'); } });
    expect((await denied(request(valid))).status).toBe(404);
    expect(executed).toBe(false);
    const emptyToken = createFormHandler(form, { ...options(), csrfToken: () => '' });
    expect((await emptyToken(request({ ...valid, _bc_csrf: '' }))).status).toBe(403);
    expect(() => createFormHandler(form, { ...options(), allowedOrigins: [] })).toThrow();
  });

  it('rejects invalid public projections and external success redirects without leaking exceptions', async () => {
    const leaked = createFormHandler(form, { ...options(), project: (result) => result });
    const response = await leaked(request(valid));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('must not leave');
    const external = createFormHandler(form, { ...options(), success: () => ({ location: 'https://foreign.test/receipt' }) });
    expect((await external(request(valid))).status).toBe(500);
    const failure = createFormHandler(form, { ...options(), execute: () => { throw new FormHttpError(409, 'CHANGED'); } });
    expect((await failure(request(valid))).status).toBe(409);
  });

  it('passes verified protocol state to a custom invalid renderer', async () => {
    const handle = createFormHandler(form, { ...options(), invalid: ({ rawValues, issues, csrfToken, principal }) => {
      expect(rawValues.copies).toBe('100');
      expect(issues[0]?.field).toBe('copies');
      expect(csrfToken).toBe('synthetic-token');
      expect(principal.id).toBe('person');
      return '<p>custom invalid form</p>';
    } });
    const response = await handle(request({ ...valid, copies: '100' }));
    expect(response.status).toBe(422);
    expect(await response.text()).toBe('<p>custom invalid form</p>');
  });
});
