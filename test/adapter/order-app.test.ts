import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { loadBoundaryContract } from '../../src/contract/load.ts';
import { SqliteOrderStore } from '../../src/adapter/sqlite/order-store.ts';
import { createOrderBindings } from '../../src/runtime/order-bindings.ts';
import { OrderCoordinator, OrderFailure } from '../../src/runtime/order-coordinator.ts';
import { createOrderApp, InMemorySessionStore, type OrderAppOptions } from '../../src/adapter/hono/order-app.ts';
import { InMemoryActionRateLimiter } from '../../src/adapter/hono/rate-limit.ts';
import { validateBoundaryContract } from '../../src/contract/validate.ts';
import { computeBehaviorSha256 } from '../../src/contract/behavior.ts';
import type { Principal, Product } from '../../src/runtime/order.ts';

const CONTRACT = resolve(import.meta.dir, '../../docs/design/v0.5/examples/order.boundary.json');
const principal: Principal = { subjectId: 'subject_1', tenantId: 'tenant_1', sessionId: 'session_1' };
const product: Product = {
  id: 'p_100',
  tenantId: 'tenant_1',
  name: 'Sample <product>',
  revision: 7,
  active: true,
  priceMinor: 12000,
  currency: 'KRW',
};
const ORIGIN = 'http://localhost';
const FORM = 'application/x-www-form-urlencoded';

async function setup(options: Partial<Pick<OrderAppOptions, 'rateLimiter' | 'requestLimit'>> = {}) {
  const now = () => 1_000_000;
  const store = new SqliteOrderStore(':memory:', { now });
  store.seedMembership('tenant_1', 'subject_1', true);
  store.seedProduct(product);
  const loaded = await loadBoundaryContract(CONTRACT);
  const coordinator = new OrderCoordinator({
    loaded,
    bindings: createOrderBindings(),
    storage: store,
    now,
  });
  const sessions = new InMemorySessionStore();
  const app = createOrderApp({
    loaded,
    coordinator,
    sessions,
    allowedOrigins: [ORIGIN],
    demo: { principal, productId: 'p_100' },
    ...options,
  });
  const login = await app.request('/login', { redirect: 'manual' });
  const setCookie = login.headers.get('set-cookie');
  if (setCookie === null) throw new Error('missing session cookie');
  const cookie = setCookie.split(';')[0]!;
  const session = sessions.get(cookie.slice(cookie.indexOf('=') + 1));
  if (session === null) throw new Error('missing session');
  return { app, store, coordinator, loaded, sessions, session, cookie };
}

function formBody(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function encodedBody(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function post(app: ReturnType<typeof createOrderApp>, path: string, cookie: string, body: string) {
  return postRaw(app, path, cookie, body, { origin: ORIGIN });
}

function postRaw(
  app: ReturnType<typeof createOrderApp>,
  path: string,
  cookie: string,
  body: string | ArrayBuffer,
  headers: Record<string, string>,
) {
  return app.request(path, {
    method: 'POST',
    headers: {
      cookie,
      accept: 'text/html',
      'content-type': FORM,
      ...headers,
    },
    body,
  });
}

async function begin(app: ReturnType<typeof createOrderApp>, cookie: string, csrfToken: string) {
  const response = await post(
    app,
    '/actions/orders/begin-draft',
    cookie,
    formBody({ _bc_csrf: csrfToken, productId: 'p_100' }),
  );
  if (response.status !== 303) throw new Error('failed to begin: ' + response.status);
  const location = response.headers.get('location');
  if (location === null) throw new Error('missing intent location');
  return decodeURIComponent(location.split('intent=')[1]!);
}

describe('Hono order adapter', () => {
  it('honors contract page, action, and receipt routes throughout the flow', async () => {
    const { store, loaded, sessions, session, cookie } = await setup();
    const value = structuredClone(loaded.value) as any;
    value.page.path = '/checkout/new';
    value.page.intentInitialization.path = '/actions/checkout/begin';
    value.page.intentInitialization.location = '/checkout/new?intent={intentId}';
    value.http.path = '/actions/checkout/submit';
    value.response.receipt.path = '/checkout/receipts/:orderId';
    const custom = { ...loaded, value, contract: validateBoundaryContract(value), behaviorSha256: computeBehaviorSha256(value) };
    const coordinator = new OrderCoordinator({ loaded: custom, storage: store, bindings: createOrderBindings(), now: () => 1_000_000 });
    const app = createOrderApp({ loaded: custom, coordinator, sessions, allowedOrigins: [ORIGIN] });
    expect((await app.request('/checkout/new?productId=p_100', { headers: { cookie } })).status).toBe(200);
    const started = await post(app, '/actions/checkout/begin', cookie,
      formBody({ _bc_csrf: session.csrfToken, productId: 'p_100' }));
    const location = started.headers.get('location')!;
    expect(location).toStartWith('/checkout/new?intent=');
    expect((await app.request(location, { headers: { cookie } })).status).toBe(200);
    const submitted = await post(app, '/actions/checkout/submit', cookie, formBody({
      _bc_csrf: session.csrfToken, _bc_request: new URL(location, ORIGIN).searchParams.get('intent')!, productId: 'p_100', quantity: '2',
    }));
    const receipt = submitted.headers.get('location')!;
    expect(receipt).toStartWith('/checkout/receipts/draft_');
    expect((await app.request(location, { headers: { cookie } })).headers.get('location')).toBe(receipt);
    expect((await app.request(receipt, { headers: { cookie } })).status).toBe(200);
  });

  it('rejects ambiguous and unsupported page query modes', async () => {
    const { app, cookie, store } = await setup();
    for (const query of ['productId=p_100&productId=other', 'intent=a&intent=b', 'intent=a&productId=p_100', 'productId=p_100&extra=1', 'intent=']) {
      expect((await app.request(`/orders/new?${query}`, { headers: { cookie } })).status).toBe(400);
    }
    expect(store.countIntents()).toBe(0);
  });

  it('rejects unsupported methods and transport headers before authentication or mutation', async () => {
    const { app, store } = await setup();
    const method = await app.request('/actions/orders/create-draft', { method: 'PUT' });
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('POST');
    const type = await app.request('/actions/orders/create-draft', { method: 'POST', headers: { 'content-type': 'multipart/form-data' } });
    expect(type.status).toBe(415);
    const length = await app.request('/actions/orders/create-draft', { method: 'POST', headers: {
      'content-type': FORM, 'content-length': '20000',
    } });
    expect(length.status).toBe(413);
    expect(store.countIntents()).toBe(0);
  });

  it('uses strict bounded credential parsing and invalidates the previous login epoch', async () => {
    const { loaded, coordinator, sessions, cookie, session } = await setup();
    let calls = 0;
    const app = createOrderApp({ loaded, coordinator, sessions, allowedOrigins: [ORIGIN], secureCookies: true,
      credentials: { verify: async () => { calls++; return principal; } } });
    const invalid = await post(app, '/login', cookie, 'tenantId=t&subjectId=s&password=a&password=b');
    expect(invalid.status).toBe(400);
    expect(calls).toBe(0);
    const oversized = await post(app, '/login', cookie, `tenantId=t&subjectId=s&password=${'x'.repeat(20_000)}`);
    expect(oversized.status).toBe(413);
    expect(calls).toBe(0);
    const valid = await post(app, '/login', cookie, 'tenantId=t&subjectId=s&password=a');
    expect(valid.status).toBe(303);
    expect(valid.headers.get('set-cookie')).toContain('; Secure');
    expect(sessions.get(session.id)).toBeNull();
    expect(calls).toBe(1);
  });

  it('rejects undeclared begin fields without issuing an intent', async () => {
    const { app, cookie, session, store } = await setup();
    const response = await post(app, '/actions/orders/begin-draft', cookie,
      formBody({ _bc_csrf: session.csrfToken, productId: 'p_100', customerId: 'attacker' }));
    expect(response.status).toBe(400);
    expect(store.countIntents()).toBe(0);
  });

  it('connects preserved invalid input to an error summary and description', async () => {
    const { app, cookie, session } = await setup();
    const intentId = await begin(app, cookie, session.csrfToken);
    const response = await post(app, '/actions/orders/create-draft', cookie,
      formBody({ _bc_csrf: session.csrfToken, _bc_request: intentId, productId: 'p_100', quantity: '1e1' }));
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain('type="text"');
    expect(body).toContain('value="1e1"');
    expect(body).toContain('pattern="([1-9]|1[0-9]|20)"');
    expect(body).toContain('href="#quantity"');
    expect(body).toContain('aria-describedby="quantity-hint quantity-error"');
    expect(body).toContain('id="quantity-error"');
  });

  for (const change of ['revoke', 'revision', 'complete'] as const) {
    it(`uses the final page state after an invalid submission: ${change}`, async () => {
      const { app, cookie, session, coordinator, store } = await setup();
      const intentId = await begin(app, cookie, session.csrfToken);
      const submit = coordinator.submitIntent.bind(coordinator);
      coordinator.submitIntent = async (...args) => {
        try { return await submit(...args); } catch (error) {
          if (error instanceof OrderFailure && error.status === 422) {
            if (change === 'revoke') store.seedMembership('tenant_1', 'subject_1', false);
            if (change === 'revision') store.seedProduct({ ...product, revision: 8 });
            if (change === 'complete') await submit(session.principal, intentId, { productId: 'p_100', quantity: '2' });
          }
          throw error;
        }
      };
      const response = await post(app, '/actions/orders/create-draft', cookie,
        formBody({ _bc_csrf: session.csrfToken, _bc_request: intentId, productId: 'p_100', quantity: '21' }));
      expect(response.status).toBe(change === 'revoke' ? 404 : 409);
      const body = await response.text();
      expect(body).not.toContain('id="create-draft"');
      expect(body).not.toContain('value="21"');
      if (change === 'complete') expect(body).toContain('/orders/drafts/draft_');
    });
  }

  it('limits begin requests before issuance and permits the same session after the window', async () => {
    let time = 0;
    const limiter = new InMemoryActionRateLimiter({ now: () => time, maxBegins: 1 });
    const { app, cookie, session, store } = await setup({ rateLimiter: limiter });
    await begin(app, cookie, session.csrfToken);
    const limited = await post(app, '/actions/orders/begin-draft', cookie,
      formBody({ _bc_csrf: session.csrfToken, productId: 'p_100' }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(store.countIntents()).toBe(1);
    time = 60_000;
    await begin(app, cookie, session.csrfToken);
    expect(store.countIntents()).toBe(2);
  });

  it('applies the host ingress hook before reading a rejected request body', async () => {
    const { app, cookie, store } = await setup({ requestLimit: () => ({ allow: false, retryAfterSeconds: 2 }) });
    const response = await post(app, '/actions/orders/begin-draft', cookie, 'malformed=%');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(store.countIntents()).toBe(0);
  });

  it('serves a start page and escapes product text', async () => {
    const { app, cookie } = await setup();
    const response = await app.request('/orders/new?productId=p_100', {
      headers: { cookie, accept: 'text/html' },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('Sample &lt;product&gt;');
    expect(body).toContain('_bc_csrf');
  });

  it('creates no intent for start GET, HEAD, or prefetch and one for begin POST', async () => {
    const { app, cookie, session, store } = await setup();
    const prefetch = await app.request('/orders/new?productId=p_100', {
      headers: { cookie, accept: 'text/html', 'sec-purpose': 'prefetch' },
    });
    expect(prefetch.status).toBe(200);
    expect(store.countIntents()).toBe(0);
    const head = await app.request('/orders/new?productId=p_100', {
      method: 'HEAD',
      headers: { cookie, accept: 'text/html' },
    });
    expect(head.status).toBe(200);
    expect(store.countIntents()).toBe(0);
    const started = await post(
      app,
      '/actions/orders/begin-draft',
      cookie,
      formBody({ _bc_csrf: session.csrfToken, productId: 'p_100' }),
    );
    expect(started.status).toBe(303);
    expect(store.countIntents()).toBe(1);
  });

  it('runs begin, invalid retry, valid submit, and receipt through HTTP', async () => {
    const { app, cookie, session, store } = await setup();
    const before = store.read((tx) => tx.currentMember('tenant_1', 'subject_1'));
    expect(before).toBe(true);

    const begin = await post(
      app,
      '/actions/orders/begin-draft',
      cookie,
      formBody({ _bc_csrf: session.csrfToken, productId: 'p_100' }),
    );
    expect(begin.status).toBe(303);
    const location = begin.headers.get('location');
    expect(location).toContain('/orders/new?intent=');
    const intentId = decodeURIComponent(location!.split('intent=')[1]!);

    const form = await app.request(location!, { headers: { cookie, accept: 'text/html' } });
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('_bc_request');

    const invalid = await post(
      app,
      '/actions/orders/create-draft',
      cookie,
      formBody({ _bc_csrf: session.csrfToken, _bc_request: intentId, productId: 'p_100', quantity: '21' }),
    );
    expect(invalid.status).toBe(422);
    expect(await invalid.text()).toContain('aria-invalid="true"');

    const valid = await post(
      app,
      '/actions/orders/create-draft',
      cookie,
      formBody({ _bc_csrf: session.csrfToken, _bc_request: intentId, productId: 'p_100', quantity: '2' }),
    );
    expect(valid.status).toBe(303);
    const receiptLocation = valid.headers.get('location')!;
    const receipt = await app.request(receiptLocation, { headers: { cookie, accept: 'text/html' } });
    expect(receipt.status).toBe(200);
    const body = await receipt.text();
    expect(body).toContain('KRW 24000');
    expect(body).not.toContain('<product>');
  });

  it('rejects JSON accept, null origin, duplicate entries, and unknown fields', async () => {
    const { app, cookie, session } = await setup();
    const begin = await post(
      app,
      '/actions/orders/begin-draft',
      cookie,
      formBody({ _bc_csrf: session.csrfToken, productId: 'p_100' }),
    );
    const location = begin.headers.get('location')!;
    const intentId = decodeURIComponent(location.split('intent=')[1]!);

    const json = await app.request('/orders/new?intent=' + encodeURIComponent(intentId), {
      headers: { cookie, accept: 'application/json' },
    });
    expect(json.status).toBe(406);

    const nullOrigin = await app.request('/actions/orders/create-draft', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'null',
        accept: 'text/html',
        'content-type': FORM,
      },
      body: formBody({ _bc_csrf: session.csrfToken, _bc_request: intentId, productId: 'p_100', quantity: '2' }),
    });
    expect(nullOrigin.status).toBe(403);

    const duplicate = await post(
      app,
      '/actions/orders/create-draft',
      cookie,
      `_bc_csrf=${session.csrfToken}&_bc_request=${intentId}&productId=p_100&quantity=2&quantity=3`,
    );
    expect(duplicate.status).toBe(400);

    const unknown = await post(
      app,
      '/actions/orders/create-draft',
      cookie,
      formBody({
        _bc_csrf: session.csrfToken,
        _bc_request: intentId,
        productId: 'p_100',
        quantity: '2',
        extra: 'x',
      }),
    );
    expect(unknown.status).toBe(400);
  });

  it('does not accept a POST without a session', async () => {
    const { app } = await setup();
    const response = await app.request('/actions/orders/begin-draft', {
      method: 'POST',
      headers: { origin: ORIGIN, accept: 'text/html', 'content-type': FORM },
      body: formBody({ _bc_csrf: 'x', productId: 'p_100' }),
    });
    expect(response.status).toBe(401);
  });
});

describe('request-case matrix', () => {
  const malformed: readonly { case: string; body: string; status: number }[] = [
    { case: 'duplicate', body: 'quantity=1&quantity=2', status: 400 },
    { case: 'unknown-owner', body: 'ownerId=someone', status: 400 },
    { case: 'proto', body: '__proto__=x', status: 400 },
    { case: 'unknown-reserved', body: '_bc_admin=1', status: 400 },
    { case: 'legacy-reserved', body: '_th_request=old', status: 400 },
    { case: 'malformed-percent', body: 'quantity=%G1', status: 400 },
    { case: 'encoded-duplicate', body: 'quantity=1&%71uantity=2', status: 400 },
    { case: 'exponent', body: 'quantity=1e1', status: 422 },
    { case: 'empty-quantity', body: 'quantity=', status: 422 },
  ];

  for (const item of malformed) {
    it('returns ' + item.status + ' for ' + item.case, async () => {
      const { app, cookie, session } = await setup();
      const intentId = await begin(app, cookie, session.csrfToken);
      const response = await post(
        app,
        '/actions/orders/create-draft',
        cookie,
        '_bc_csrf=' + session.csrfToken +
          '&_bc_request=' + encodeURIComponent(intentId) +
          '&productId=p_100&' + item.body,
      );
      expect(response.status).toBe(item.status);
    });
  }

  it('rejects bad CSRF, multipart, invalid UTF-8, and oversized bodies', async () => {
    const { app, cookie, session } = await setup();
    const intentId = await begin(app, cookie, session.csrfToken);

    const csrf = await post(
      app,
      '/actions/orders/create-draft',
      cookie,
      formBody({ _bc_csrf: 'wrong', _bc_request: intentId, productId: 'p_100', quantity: '2' }),
    );
    expect(csrf.status).toBe(403);

    const multipart = await app.request('/actions/orders/create-draft', {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, accept: 'text/html', 'content-type': 'multipart/form-data' },
      body: 'x',
    });
    expect(multipart.status).toBe(415);

    const invalidUtf8 = await postRaw(
      app,
      '/actions/orders/create-draft',
      cookie,
      encodedBody(
        '_bc_csrf=' + session.csrfToken +
          '&_bc_request=' + encodeURIComponent(intentId) +
          '&productId=%FF',
      ),
      { origin: ORIGIN },
    );
    expect(invalidUtf8.status).toBe(400);

    const oversized = await post(
      app,
      '/actions/orders/create-draft',
      cookie,
      formBody({
        _bc_csrf: session.csrfToken,
        _bc_request: intentId,
        productId: 'p_100',
        quantity: '2',
        padding: 'x'.repeat(17_000),
      }),
    );
    expect(oversized.status).toBe(413);
  });

  it('returns 410 for an unknown intent', async () => {
    const { app, cookie, session } = await setup();
    const response = await post(
      app,
      '/actions/orders/create-draft',
      cookie,
      formBody({
        _bc_csrf: session.csrfToken,
        _bc_request: 'intent_00000000-0000-0000-0000-000000000000',
        productId: 'p_100',
        quantity: '2',
      }),
    );
    expect(response.status).toBe(410);
  });

  it('replays the same receipt but rejects different committed input', async () => {
    const { app, cookie, session } = await setup();
    const intentId = await begin(app, cookie, session.csrfToken);
    const fieldset = (quantity: string) =>
      formBody({ _bc_csrf: session.csrfToken, _bc_request: intentId, productId: 'p_100', quantity });
    expect((await post(app, '/actions/orders/create-draft', cookie, fieldset('2'))).status).toBe(303);
    expect((await post(app, '/actions/orders/create-draft', cookie, fieldset('2'))).status).toBe(303);
    expect((await post(app, '/actions/orders/create-draft', cookie, fieldset('3'))).status).toBe(409);
    expect((await post(app, '/actions/orders/create-draft', cookie, fieldset('not-an-integer'))).status).toBe(409);
  });

  it('rejects a product from another tenant', async () => {
    const { app, cookie, session, store } = await setup();
    store.seedProduct({ ...product, id: 'p_200', tenantId: 'tenant_2', revision: 1 });
    const response = await post(
      app,
      '/actions/orders/begin-draft',
      cookie,
      formBody({ _bc_csrf: session.csrfToken, productId: 'p_200' }),
    );
    expect(response.status).toBe(404);
  });

  it('accepts same-origin Referer without Origin and rejects no source', async () => {
    const { app, cookie, session } = await setup();
    const referer = await postRaw(
      app,
      '/actions/orders/begin-draft',
      cookie,
      formBody({ _bc_csrf: session.csrfToken, productId: 'p_100' }),
      { referer: ORIGIN + '/orders/new?productId=p_100' },
    );
    expect(referer.status).toBe(303);

    const missing = await postRaw(
      app,
      '/actions/orders/begin-draft',
      cookie,
      formBody({ _bc_csrf: session.csrfToken, productId: 'p_100' }),
      {},
    );
    expect(missing.status).toBe(403);
  });

  it('revokes receipt access after membership is deactivated', async () => {
    const { app, cookie, session, store } = await setup();
    const intentId = await begin(app, cookie, session.csrfToken);
    const submit = await post(
      app,
      '/actions/orders/create-draft',
      cookie,
      formBody({ _bc_csrf: session.csrfToken, _bc_request: intentId, productId: 'p_100', quantity: '2' }),
    );
    expect(submit.status).toBe(303);
    const location = submit.headers.get('location')!;
    store.seedMembership('tenant_1', 'subject_1', false);
    expect((await app.request(location, { headers: { cookie, accept: 'text/html' } })).status).toBe(404);
  });
});
