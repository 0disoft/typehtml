import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBoundaryContract } from '../../src/contract/load.ts';
import { SqliteOrderStore } from '../../src/adapter/sqlite/order-store.ts';
import { SqliteCredentialStore, SqliteSessionStore } from '../../src/adapter/sqlite/session-store.ts';
import { createOrderApp } from '../../src/adapter/hono/order-app.ts';
import { createOrderBindings } from '../../src/runtime/order-bindings.ts';
import { OrderCoordinator } from '../../src/runtime/order-coordinator.ts';
import type { Principal, Product } from '../../src/runtime/order.ts';

const CONTRACT = join(import.meta.dir, '../../docs/design/v0.5/examples/order.boundary.json');
const principal: Principal = { tenantId: 'tenant_1', subjectId: 'subject_1', sessionId: '' };
const product: Product = {
  id: 'p_100',
  tenantId: 'tenant_1',
  name: 'Session product',
  revision: 7,
  active: true,
  priceMinor: 12000,
  currency: 'KRW',
};
const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'typehtml-session-'));
  temporary.push(directory);
  return join(directory, 'app.sqlite');
}

describe('SQLite sessions and credentials', () => {
  it('shares a session and CSRF token across two instances', async () => {
    const path = await databasePath();
    const a = new SqliteSessionStore(path);
    const b = new SqliteSessionStore(path);
    const created = a.create(principal);
    const seen = b.get(created.id);
    expect(seen?.principal).toEqual({ ...principal, sessionId: created.id });
    expect(seen?.csrfToken).toBe(created.csrfToken);

    const rotated = a.rotate(created.id);
    expect(rotated).not.toBeNull();
    expect(b.get(created.id)).toBeNull();
    expect(b.get(rotated!.id)?.principal.subjectId).toBe('subject_1');
    a.close();
    b.close();
  });

  it('expires sessions and verifies password hashes', async () => {
    const path = await databasePath();
    let now = 1_000_000;
    const sessions = new SqliteSessionStore(path, { ttlSeconds: 60, now: () => now });
    const created = sessions.create(principal);
    now += 61_000;
    expect(sessions.get(created.id)).toBeNull();
    sessions.close();

    const credentials = new SqliteCredentialStore(path);
    await credentials.seed('tenant_1', 'subject_1', 'correct horse');
    expect(await credentials.verify('tenant_1', 'subject_1', 'wrong')).toBeNull();
    expect((await credentials.verify('tenant_1', 'subject_1', 'correct horse'))?.subjectId).toBe('subject_1');
    await credentials.seed('tenant_1', 'subject_1', 'correct horse', false);
    expect(await credentials.verify('tenant_1', 'subject_1', 'correct horse')).toBeNull();
    credentials.close();
  });

  it('logs in on one app instance and submits through another', async () => {
    const path = await databasePath();
    const order = new SqliteOrderStore(path);
    order.seedMembership('tenant_1', 'subject_1', true);
    order.seedProduct(product);
    const loaded = await loadBoundaryContract(CONTRACT);
    const coordinator = new OrderCoordinator({
      loaded,
      bindings: createOrderBindings(),
      storage: order,
      now: () => 1_000_000,
    });
    const sessionsA = new SqliteSessionStore(path);
    const sessionsB = new SqliteSessionStore(path);
    const credentialsA = new SqliteCredentialStore(path);
    await credentialsA.seed('tenant_1', 'subject_1', 'correct horse');
    credentialsA.close();
    const credentialsB = new SqliteCredentialStore(path);

    const appA = createOrderApp({
      loaded,
      coordinator,
      sessions: sessionsA,
      credentials: credentialsB,
      allowedOrigins: ['http://a.test'],
      demo: { principal, productId: 'p_100' },
    });
    const appB = createOrderApp({
      loaded,
      coordinator,
      sessions: sessionsB,
      credentials: credentialsB,
      allowedOrigins: ['http://b.test'],
      demo: { principal, productId: 'p_100' },
    });

    const loginPage = await appA.request('/login', { headers: { accept: 'text/html' } });
    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toContain('name="password"');

    const login = await appA.request('/login', {
      method: 'POST',
      headers: { origin: 'http://a.test', accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tenantId: 'tenant_1', subjectId: 'subject_1', password: 'correct horse' }).toString(),
    });
    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

    const start = await appB.request('/orders/new?productId=p_100', { headers: { cookie, accept: 'text/html' } });
    expect(start.status).toBe(200);
    const csrf = (await start.text()).match(/name="_bc_csrf" value="([^"]+)"/)?.[1];
    expect(csrf).toBeTruthy();

    const begin = await appB.request('/actions/orders/begin-draft', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://b.test',
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ _bc_csrf: csrf!, productId: 'p_100' }).toString(),
    });
    expect(begin.status).toBe(303);

    const logout = await appA.request('/logout', {
      method: 'POST',
      headers: { cookie, origin: 'http://a.test', accept: 'text/html' },
    });
    expect(logout.status).toBe(303);
    const after = await appB.request('/orders/new?productId=p_100', { headers: { cookie, accept: 'text/html' } });
    expect(after.status).toBe(401);

    sessionsA.close();
    sessionsB.close();
    credentialsB.close();
    order.close();
  });
});
