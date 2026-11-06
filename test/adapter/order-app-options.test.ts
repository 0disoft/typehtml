import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createOrderApp, type OrderAppOptions } from '../../src/adapter/hono/order-app.ts';
import { SqliteOrderStore } from '../../src/adapter/sqlite/order-store.ts';
import { loadBoundaryContract } from '../../src/contract/load.ts';
import { createOrderBindings } from '../../src/runtime/order-bindings.ts';
import { OrderCoordinator } from '../../src/runtime/order-coordinator.ts';
import { InMemorySessionStore } from '../../src/runtime/session.ts';

type MutableOptions = { -readonly [K in keyof OrderAppOptions]: OrderAppOptions[K] };
const origin = 'https://allowed.test';
const principal = { tenantId: 'tenant_1', subjectId: 'subject_1', sessionId: '' };

async function withApp(overrides: Partial<MutableOptions>, work: (fixture: {
  app: ReturnType<typeof createOrderApp>; options: MutableOptions; sessions: InMemorySessionStore;
}) => Promise<void>) {
  const loaded = await loadBoundaryContract(fileURLToPath(new URL('../../docs/design/v0.5/examples/order.boundary.json', import.meta.url)));
  const store = new SqliteOrderStore(':memory:');
  try {
    const sessions = new InMemorySessionStore();
    const options: MutableOptions = {
      loaded, coordinator: new OrderCoordinator({ loaded, storage: store, bindings: createOrderBindings() }),
      sessions, allowedOrigins: [origin], demo: { principal, productId: 'p_100' }, ...overrides,
    };
    await work({ app: createOrderApp(options), options, sessions });
  } finally { store.close(); }
}

describe('reference app configuration ownership', () => {
  it('keeps origin policy and cookie defaults stable without freezing the supplied array', async () => {
    const origins = [origin];
    await withApp({ allowedOrigins: origins }, async ({ app, sessions }) => {
      const login = await app.request('/login');
      expect(login.status).toBe(303);
      expect(login.headers.get('set-cookie')).toContain('; Secure');
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const id = cookie.slice(cookie.indexOf('=') + 1);
      origins.splice(0, 1, 'http://added.test');
      expect(Object.isFrozen(origins)).toBe(false);

      const foreign = await app.request('/logout', { method: 'POST', headers: { origin: origins[0]!, cookie } });
      expect(foreign.status).toBe(403);
      expect(sessions.get(id)).not.toBeNull();
      const allowed = await app.request('/logout', { method: 'POST', headers: { origin, cookie } });
      expect(allowed.status).toBe(303);
      expect(sessions.get(id)).toBeNull();
    });
  });

  it.each(['remove', 'replace'] as const)('keeps credential mode and the captured store after callers %s its option', async (change) => {
    const credentials = {
      calls: 0, active: false,
      async verify() { this.calls++; return this.active ? principal : null; },
    };
    await withApp({ credentials }, async ({ app, options }) => {
      if (change === 'remove') delete options.credentials;
      else options.credentials = { verify: async () => principal };
      const page = await app.request('/login');
      expect(page.status).toBe(200);
      expect(page.headers.get('set-cookie')).toBeNull();
      const login = () => app.request('/login', {
        method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ tenantId: principal.tenantId, subjectId: principal.subjectId, password: 'synthetic' }),
      });
      expect((await login()).status).toBe(401);
      credentials.active = true;
      expect((await login()).status).toBe(303);
      expect(credentials.calls).toBe(2);
      expect(Object.isFrozen(options)).toBe(false);
      expect(Object.isFrozen(credentials)).toBe(false);
    });
  });

  it('keeps the captured ingress hook and its original mutable receiver', async () => {
    await withApp({}, async ({ options }) => {
      const hooks = {
        ...options, calls: 0, blocked: true,
        requestLimit() {
          this.calls++;
          return this.blocked ? { allow: false as const, retryAfterSeconds: 2 } : { allow: true as const };
        },
      };
      const app = createOrderApp(hooks);
      hooks.requestLimit = () => ({ allow: true });
      const logout = () => app.request('/logout', { method: 'POST', headers: { origin } });
      const blocked = await logout();
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after')).toBe('2');
      hooks.blocked = false;
      expect((await logout()).status).toBe(401);
      expect(hooks.calls).toBe(2);
      expect(Object.isFrozen(hooks)).toBe(false);
    });
  });

  it('copies demo values while leaving the caller principal and demo editable', async () => {
    const callerPrincipal = { ...principal };
    const demo = { principal: callerPrincipal, productId: 'p_100' };
    await withApp({ demo }, async ({ app, sessions }) => {
      callerPrincipal.tenantId = 'changed';
      callerPrincipal.subjectId = 'changed';
      demo.productId = 'changed';
      const response = await app.request('/login');
      expect(response.headers.get('location')).toBe('/orders/new?productId=p_100');
      const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
      const id = cookie.slice(cookie.indexOf('=') + 1);
      expect(sessions.get(id)?.principal).toEqual({ ...principal, sessionId: id });
      expect(Object.isFrozen(callerPrincipal)).toBe(false);
      expect(Object.isFrozen(demo)).toBe(false);
    });
  });
});
