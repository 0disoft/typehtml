import { expect, test } from 'bun:test';
import { createFormHandler, defineForm } from '../../src/index.ts';
import { createSignedCsrf, createIdempotencyKey, executeIdempotent, idempotencyDigest, InMemoryIdempotencyStore } from '../../src/index.ts';

const form = defineForm({ id: 'secure.form', path: '/form', input: { type: 'object', additionalProperties: false, required: [], properties: { x: { type: 'string' } } }, output: { type: 'object', additionalProperties: false, required: [], properties: { x: { type: 'string' } } } });
const request = () => new Request('https://app.test/form', { method: 'POST', headers: { origin: 'https://app.test', 'content-type': 'application/x-www-form-urlencoded' }, body: '_bc_csrf=signed-token' });
const base = { allowedOrigins: ['https://app.test'], authenticate: () => ({ id: 'p' }), csrfToken: () => 'fresh-redraw-token', authorize: () => true, execute: () => ({}), project: () => ({}), success: () => ({ location: '/done' }) };

test('optional CSRF verification replaces equality without weakening the default', async () => {
  expect((await createFormHandler(form, base)(request())).status).toBe(403);
  const handle = createFormHandler(form, { ...base, verifyCsrf: ({ token, principal }) => token === 'signed-token' && principal.id === 'p' });
  expect((await handle(request())).status).toBe(303);
  expect((await createFormHandler(form, { ...base, verifyCsrf: () => false })(request())).status).toBe(403);
});

test('rate limiting runs after authentication and before body/CSRF/business hooks', async () => {
  const calls: string[] = [];
  const handle = createFormHandler(form, { ...base,
    authenticate: () => { calls.push('auth'); return { id: 'p' }; },
    rateLimit: ({ principal }) => { calls.push(principal.id); return { allow: false, retryAfterSeconds: 7 }; },
    csrfToken: () => { throw new Error('must not run'); },
  });
  const response = await handle(request());
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('7');
  expect(calls).toEqual(['auth', 'p']);
});

test('signed tokens integrate with the handler and remain session-bound', async () => {
  const csrf = createSignedCsrf({ secret: new Uint8Array(32).fill(7) });
  const token = csrf.issue('p');
  const handle = createFormHandler(form, { ...base, csrfToken: () => csrf.issue('p'), verifyCsrf: ({ token, principal }) => csrf.verify(token, principal.id) });
  const submit = (value: string) => new Request('https://app.test/form', { method: 'POST', headers: { origin: 'https://app.test', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _bc_csrf: value }) });
  expect((await handle(submit(token))).status).toBe(303);
  expect((await handle(submit(csrf.issue('other')))).status).toBe(403);
});

test('optional request keys support authorized replay and preserve original rejection by default', async () => {
  const key = createIdempotencyKey(); const store = new InMemoryIdempotencyStore(); let executions = 0;
  const submit = () => new Request('https://app.test/form', { method: 'POST', headers: { origin: 'https://app.test', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _bc_csrf: 'fresh-redraw-token', _bc_request: key }) });
  expect((await createFormHandler(form, base)(submit())).status).toBe(400);
  const handle = createFormHandler(form, { ...base, acceptRequestKey: true, execute: async ({ input, principal, request, requestKey }) => (await executeIdempotent({ store, scope: `${principal.id}:form`, key: requestKey!, inputDigest: idempotencyDigest(input), authorize: () => true, execute: () => { executions++; return {}; }, signal: request.signal })).value });
  expect((await handle(submit())).status).toBe(303);
  expect((await handle(submit())).status).toBe(303);
  expect(executions).toBe(1);
});

