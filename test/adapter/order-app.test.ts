import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { loadBoundaryContract } from '../../src/contract/load.ts';
import { SqliteOrderStore } from '../../src/adapter/sqlite/order-store.ts';
import { createOrderBindings } from '../../src/runtime/order-bindings.ts';
import { OrderCoordinator } from '../../src/runtime/order-coordinator.ts';
import { createOrderApp, InMemorySessionStore } from '../../src/adapter/hono/order-app.ts';
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

async function setup() {
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
  });
  const login = await app.request('/login', { redirect: 'manual' });
  const setCookie = login.headers.get('set-cookie');
  if (setCookie === null) throw new Error('missing session cookie');
  const cookie = setCookie.split(';')[0]!;
  const session = sessions.get(cookie.slice(cookie.indexOf('=') + 1));
  if (session === null) throw new Error('missing session');
  return { app, store, session, cookie };
}

function formBody(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function post(app: ReturnType<typeof createOrderApp>, path: string, cookie: string, body: string) {
  return app.request(path, {
    method: 'POST',
    headers: {
      cookie,
      origin: ORIGIN,
      accept: 'text/html',
      'content-type': FORM,
    },
    body,
  });
}

describe('Hono order adapter', () => {
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
