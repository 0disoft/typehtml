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
  name: 'Socket product',
  revision: 7,
  active: true,
  priceMinor: 12000,
  currency: 'KRW',
};

describe('order demo over a real socket', () => {
  it('runs login, start, begin, submit, and receipt with fetch', async () => {
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
    const origins: string[] = [];
    const app = createOrderApp({
      loaded,
      coordinator,
      sessions,
      allowedOrigins: origins,
      demo: { principal, productId: 'p_100' },
    });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const base = 'http://127.0.0.1:' + String(server.port);
    origins.push(base);
    try {
      const login = await fetch(base + '/login', { redirect: 'manual' });
      expect(login.status).toBe(303);
      const setCookie = login.headers.get('set-cookie');
      expect(setCookie).not.toBeNull();
      const cookie = setCookie!.split(';')[0]!;

      const start = await fetch(base + '/orders/new?productId=p_100', { headers: { cookie } });
      expect(start.status).toBe(200);
      const startHtml = await start.text();
      const csrf = startHtml.match(/name="_bc_csrf" value="([^"]+)"/)?.[1];
      expect(csrf).toBeTruthy();

      const begin = await fetch(base + '/actions/orders/begin-draft', {
        method: 'POST',
        redirect: 'manual',
        headers: {
          cookie,
          origin: base,
          accept: 'text/html',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ _bc_csrf: csrf!, productId: 'p_100' }).toString(),
      });
      expect(begin.status).toBe(303);
      const intentLocation = begin.headers.get('location');
      expect(intentLocation).toContain('/orders/new?intent=');
      const intentId = decodeURIComponent(intentLocation!.split('intent=')[1]!);

      const form = await fetch(base + intentLocation!, { headers: { cookie } });
      expect(form.status).toBe(200);
      const formHtml = await form.text();
      expect(formHtml).toContain('name="_bc_request"');

      const submit = await fetch(base + '/actions/orders/create-draft', {
        method: 'POST',
        redirect: 'manual',
        headers: {
          cookie,
          origin: base,
          accept: 'text/html',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          _bc_csrf: csrf!,
          _bc_request: intentId,
          productId: 'p_100',
          quantity: '2',
        }).toString(),
      });
      expect(submit.status).toBe(303);
      const receiptLocation = submit.headers.get('location');
      expect(receiptLocation).toContain('/orders/drafts/');

      const receipt = await fetch(base + receiptLocation!, { headers: { cookie } });
      expect(receipt.status).toBe(200);
      const receiptHtml = await receipt.text();
      expect(receiptHtml).toContain('KRW 24000');
      expect(receiptHtml).toContain('draft');
    } finally {
      server.stop(true);
      store.close();
    }
  });
});
