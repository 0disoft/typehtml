import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { defineForm, createFormHandler } from '../../src/index.ts';
import { assertRequestOrigin, prepareOriginPolicy, type OriginPolicy } from '../../src/runtime/negotiation.ts';
import { loadBoundaryContract } from '../../src/contract/load.ts';
import { SqliteOrderStore } from '../../src/adapter/sqlite/order-store.ts';
import { createOrderBindings } from '../../src/runtime/order-bindings.ts';
import { OrderCoordinator } from '../../src/runtime/order-coordinator.ts';
import { createOrderApp, InMemorySessionStore } from '../../src/adapter/hono/order-app.ts';

const origin = 'https://tenant0.example.test';
const origins = Array.from({ length: 1_000 }, (_, index) => `https://tenant${index}.example.test`);
const form = defineForm({
  id: 'origin.check', path: '/form',
  input: { type: 'object', additionalProperties: false, required: [], properties: { text: { type: 'string' } } },
  output: { type: 'object', additionalProperties: false, required: [], properties: { text: { type: 'string' } } },
});

function request(headers: Record<string, string> = { origin }, path = '/form'): Request {
  return new Request(origin + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
}

function outcome(policy: OriginPolicy, headers: Record<string, string>): string {
  try { assertRequestOrigin(request(headers), policy); return 'allowed'; }
  catch (error) { if (error instanceof Error) return error.message; throw error; }
}

/** Count only allowlist/request-origin URL parsing, excluding Request URL parsing. */
async function countOriginUrls(work: (count: () => number) => Promise<void>): Promise<void> {
  const original = globalThis.URL;
  const measured = new Set(origins);
  let constructions = 0;
  globalThis.URL = new Proxy(original, {
    construct(target, args, newTarget) {
      if (measured.has(args[0])) constructions++;
      return Reflect.construct(target, args, newTarget);
    },
  });
  try { await work(() => constructions); }
  finally { globalThis.URL = original; }
}

describe('prepared Origin policies', () => {
  test('owns a frozen snapshot while ordinary policies continue observing caller changes', () => {
    const supplied = { allowedOrigins: [origin] };
    const prepared = prepareOriginPolicy(supplied);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.allowedOrigins)).toBe(true);
    expect(Object.isFrozen(supplied.allowedOrigins)).toBe(false);
    expect(Reflect.set(prepared.allowedOrigins, 0, 'https://foreign.test')).toBe(false);
    supplied.allowedOrigins[0] = 'https://foreign.test';
    expect(outcome(prepared, { origin })).toBe('allowed');
    expect(outcome(prepared, { origin: 'https://foreign.test' })).toBe('ORIGIN_NOT_ALLOWED');
    expect(outcome(supplied, { origin })).toBe('ORIGIN_NOT_ALLOWED');
    expect(outcome(supplied, { origin: 'https://foreign.test' })).toBe('allowed');
    supplied.allowedOrigins.push(origin);
    expect(outcome(supplied, { origin })).toBe('allowed');
  });

  test('retains Origin, Referer and Fetch Metadata rejection codes and precedence', () => {
    const supplied = { allowedOrigins: [origin] };
    const prepared = prepareOriginPolicy(supplied);
    for (const [headers, expected] of [
      [{ origin }, 'allowed'],
      [{ referer: origin + '/account?x=1#fragment' }, 'allowed'],
      [{ origin, 'sec-fetch-site': 'same-origin' }, 'allowed'],
      [{ origin, 'sec-fetch-site': 'cross-site' }, 'CROSS_SITE_REQUEST'],
      [{ origin: 'null', 'sec-fetch-site': 'same-site' }, 'CROSS_SITE_REQUEST'],
      [{ origin: 'null' }, 'NULL_ORIGIN'],
      [{ origin: 'https://foreign.test' }, 'ORIGIN_NOT_ALLOWED'],
      [{ origin: origin + '/' }, 'INVALID_ORIGIN'],
      [{ origin: 'https://user:pass@tenant0.example.test' }, 'INVALID_ORIGIN'],
      [{ origin: origin + ', https://foreign.test' }, 'INVALID_ORIGIN'],
      [{ origin: 'not a URL' }, 'INVALID_ORIGIN'],
      [{ referer: 'https://foreign.test/account' }, 'REFERER_NOT_ALLOWED'],
      [{ referer: 'not a URL' }, 'REFERER_NOT_ALLOWED'],
      [{}, 'MISSING_ORIGIN_AND_REFERER'],
    ] as const) {
      expect(outcome(prepared, headers)).toBe(expected);
      expect(outcome(supplied, headers)).toBe(expected);
    }
  });

  test('retains request-time configuration failures ahead of request errors', () => {
    for (const invalid of [origin + '/', origin + '/path', 'file:///private', 'not a URL']) {
      const supplied = { allowedOrigins: [invalid] };
      let prepared!: OriginPolicy;
      expect(() => { prepared = prepareOriginPolicy(supplied); }).not.toThrow();
      expect(outcome(prepared, { origin: 'null', 'sec-fetch-site': 'cross-site' })).toBe('INVALID_ALLOWED_ORIGIN');
      expect(outcome(prepared, {})).toBe(outcome(supplied, {}));
    }
  });

  test('normalizes a generic handler allowlist once rather than once per request', async () => {
    const requests = Array.from({ length: 100 }, () => request());
    await countOriginUrls(async (count) => {
      const handle = createFormHandler(form, {
        allowedOrigins: origins, authenticate: () => null, csrfToken: () => 'unused',
        authorize: () => false, execute: () => ({}), project: () => ({}), success: () => ({ location: '/' }),
      });
      // Existing constructor validation and policy compilation each inspect the list once.
      expect(count()).toBe(2_000);
      for (const incoming of requests) expect((await handle(incoming)).status).toBe(401);
      expect(count()).toBe(2_100);
    });
  });

  test('reuses one prepared policy across reference app routes without moving authentication', async () => {
    const loaded = await loadBoundaryContract(fileURLToPath(new URL('../../docs/design/v0.5/examples/order.boundary.json', import.meta.url)));
    const store = new SqliteOrderStore(':memory:');
    const requests = Array.from({ length: 100 }, () => request({ origin }, '/logout'));
    try {
      await countOriginUrls(async (count) => {
        const app = createOrderApp({
          loaded, coordinator: new OrderCoordinator({ loaded, storage: store, bindings: createOrderBindings() }),
          sessions: new InMemorySessionStore(), allowedOrigins: origins, secureCookies: true,
        });
        expect(count()).toBe(1_000);
        for (const incoming of requests) expect((await app.fetch(incoming)).status).toBe(401);
        expect(count()).toBe(1_100);
        expect((await app.fetch(request({ origin: 'null' }, '/logout'))).status).toBe(403);
      });
    } finally { store.close(); }
  });

  test('does not move reference app invalid configuration errors ahead of route checks', async () => {
    const loaded = await loadBoundaryContract(fileURLToPath(new URL('../../docs/design/v0.5/examples/order.boundary.json', import.meta.url)));
    const store = new SqliteOrderStore(':memory:');
    try {
      const app = createOrderApp({
        loaded, coordinator: new OrderCoordinator({ loaded, storage: store, bindings: createOrderBindings() }),
        sessions: new InMemorySessionStore(), allowedOrigins: [origin + '/path'], secureCookies: true,
        credentials: { verify: async () => null },
      });
      expect((await app.fetch(new Request(origin + '/login'))).status).toBe(200);
      expect((await app.fetch(request({ origin: 'null', 'content-type': 'application/json' }, '/login'))).status).toBe(415);
      expect((await app.fetch(request({ origin: 'null' }, '/login'))).status).toBe(500);
    } finally { store.close(); }
  });
});
