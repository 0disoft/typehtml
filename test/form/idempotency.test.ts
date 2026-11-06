import { describe, expect, it, spyOn } from 'bun:test';
import {
  createIdempotencyKey, encodeIdempotencyValue, executeIdempotent, idempotencyDigest, idempotencyField,
  InMemoryIdempotencyStore, type ExecuteIdempotentOptions, type IdempotencyClaim, type IdempotencyJson,
} from '../../src/form/idempotency.ts';

const key = 'request_1234567890';
const digest = idempotencyDigest({ quantity: 1 });
const claim: IdempotencyClaim = { scope: 'tenant/user/action', key, inputDigest: digest, token: 'fence_12345678901', now: 100, expiresAt: 200 };

function options<T extends IdempotencyJson>(execute: () => T | Promise<T>): ExecuteIdempotentOptions<T> {
  return { store: new InMemoryIdempotencyStore(), scope: claim.scope, key, inputDigest: digest, authorize: () => true, execute, now: () => 100 };
}

describe('generic idempotent effect boundary', () => {
  it('runs one effect, snapshots the returned value, and reauthorizes each replay', async () => {
    let effects = 0; let authorizations = 0; const receipt = { location: '/receipt/1' };
    const input = { ...options(() => { effects++; return receipt; }), authorize: () => { authorizations++; return true; } };
    const first = await executeIdempotent(input); receipt.location = '/corrupted';
    const second = await executeIdempotent(input);
    expect(first).toEqual({ replayed: false, value: { location: '/receipt/1' } });
    expect(second).toEqual({ replayed: true, value: { location: '/receipt/1' } });
    expect(effects).toBe(1); expect(authorizations).toBe(2);
    await expect(executeIdempotent({ ...input, authorize: () => false })).rejects.toMatchObject({ status: 403 });
    await expect(executeIdempotent({ ...input, inputDigest: idempotencyDigest({ quantity: 2 }) })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects simultaneous submissions without running their effects', async () => {
    let release!: () => void; let effects = 0;
    const input = options(async () => { effects++; await new Promise<void>((resolve) => { release = resolve; }); return 'receipt'; });
    const pending = executeIdempotent(input);
    await Promise.resolve(); await Promise.resolve();
    await expect(executeIdempotent(input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_BUSY' });
    release(); await pending; expect(effects).toBe(1);
  });

  it('blocks ambiguous failures forever rather than retrying after a lease or TTL', async () => {
    const error = new Error('commit acknowledgement lost'); let effects = 0;
    const input = options(() => { effects++; throw error; });
    await expect(executeIdempotent(input)).rejects.toBe(error);
    await expect(executeIdempotent(input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_UNKNOWN' });
    await expect(executeIdempotent({ ...input, now: () => 86_400_100 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_EXPIRED' });
    expect(effects).toBe(1);
  });

  it('keeps uncertain completion blocked even when the store acknowledgement fails', async () => {
    const store = new InMemoryIdempotencyStore();
    const input = { ...options(() => 'receipt'), store: {
      claim: store.claim.bind(store), markUnknown: store.markUnknown.bind(store),
      complete: () => { throw new Error('storage offline'); },
    } };
    await expect(executeIdempotent(input)).rejects.toThrow('storage offline');
    await expect(executeIdempotent(input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_UNKNOWN' });
  });

  it('completes a successful in-flight effect after cancellation so replay can recover', async () => {
    const controller = new AbortController(); const reason = new Error('disconnect');
    const input = { ...options(() => { controller.abort(reason); return 'receipt'; }), signal: controller.signal };
    await expect(executeIdempotent(input)).rejects.toBe(reason);
    expect(await executeIdempotent({ ...input, signal: undefined })).toEqual({ value: 'receipt', replayed: true });
    const never = options(() => { throw new Error('must not run'); });
    await expect(executeIdempotent({ ...never, signal: controller.signal })).rejects.toBe(reason);
    expect(await executeIdempotent({ ...never, execute: () => 'fresh' })).toEqual({ value: 'fresh', replayed: false });
  });

  it('does not change callbacks or identity during asynchronous authorization', async () => {
    let release!: (allowed: boolean) => void;
    const auth = new Promise<boolean>((resolve) => { release = resolve; });
    const input = { ...options<string>(() => 'original'), authorize: () => auth };
    const pending = executeIdempotent(input);
    input.execute = () => 'mutated'; input.scope = 'changed'; release(true);
    expect(await pending).toEqual({ value: 'original', replayed: false });
  });

  it('starts the acceptance lifetime after asynchronous authorization', async () => {
    let now = 100; let calls = 0;
    const input = { ...options(() => { calls++; return 'receipt'; }), ttlMs: 10, now: () => now, authorize: async () => { now = 1000; return true; } };
    expect(await executeIdempotent(input)).toEqual({ value: 'receipt', replayed: false });
    expect(calls).toBe(1);
  });

  it('does not run an effect when a slow claim exhausts its acceptance lifetime', async () => {
    let now = 100; let calls = 0; const store = new InMemoryIdempotencyStore();
    const input = { ...options(() => { calls++; return 'receipt'; }), ttlMs: 10, now: () => now, store: {
      claim: async (value: IdempotencyClaim) => { const result = store.claim(value); now = 110; return result; },
      complete: store.complete.bind(store), markUnknown: store.markUnknown.bind(store),
    } };
    await expect(executeIdempotent(input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_EXPIRED' });
    expect(calls).toBe(0);
    expect(store.claim({ ...claim, now: 110, expiresAt: 200 }).status).toBe('expired');
  });

  it('does not return a cached outcome if it expires during a remote claim', async () => {
    let now = 100; const store = new InMemoryIdempotencyStore(); store.claim(claim); store.complete(claim, claim.token, '"receipt"');
    const input = { ...options(() => 'must not execute'), now: () => now, store: {
      claim: async (value: IdempotencyClaim) => { const result = store.claim(value); now = 200; return result; },
      complete: store.complete.bind(store), markUnknown: store.markUnknown.bind(store),
    } };
    await expect(executeIdempotent(input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_EXPIRED' });
  });

  it('times out a remote store that ignores cancellation without retrying its claim', async () => {
    const store = new InMemoryIdempotencyStore(); let claims = 0; let effects = 0;
    const input = { ...options(() => { effects++; return 'receipt'; }), timeoutMs: 2, store: {
      claim: (value: IdempotencyClaim) => { claims++; store.claim(value); return new Promise<never>(() => {}); },
      complete: store.complete.bind(store), markUnknown: store.markUnknown.bind(store),
    } };
    await expect(executeIdempotent(input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_TIMEOUT', cause: { name: 'TimeoutError' } });
    expect(claims).toBe(1); expect(effects).toBe(0);
    await expect(executeIdempotent({ ...input, store })).rejects.toMatchObject({ code: 'IDEMPOTENCY_BUSY' });
  });

  it('bounds a stalled effect, leaving late success unable to reopen the key', async () => {
    let release!: (value: string) => void; let effects = 0;
    const input = { ...options(() => { effects++; return new Promise<string>((resolve) => { release = resolve; }); }), timeoutMs: 2 };
    await expect(executeIdempotent(input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_TIMEOUT' });
    release('late receipt'); await Promise.resolve();
    await expect(executeIdempotent(input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_UNKNOWN' });
    expect(effects).toBe(1);
  });

  it('returns the exact abort reason when an authorization callback ignores its signal', async () => {
    const controller = new AbortController(); const reason = { disconnected: true };
    const input = { ...options(() => 'must not execute'), signal: controller.signal, authorize: () => new Promise<boolean>(() => {}) };
    const pending = executeIdempotent(input); controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('bounds uncertainty cleanup and preserves the original error', async () => {
    const error = new Error('external failure'); const store = new InMemoryIdempotencyStore();
    const input = { ...options(() => { throw error; }), timeoutMs: 2, store: {
      claim: store.claim.bind(store), complete: store.complete.bind(store), markUnknown: () => new Promise<never>(() => {}),
    } };
    await expect(executeIdempotent(input)).rejects.toBe(error);
    await expect(executeIdempotent({ ...input, store })).rejects.toMatchObject({ code: 'IDEMPOTENCY_BUSY' });
  });

  it('cleans all deadline timers after success, cancellation and timeout', async () => {
    const originalSet = globalThis.setTimeout; const originalClear = globalThis.clearTimeout;
    const active = new Set<ReturnType<typeof setTimeout>>();
    const armed = spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const timer = originalSet(...args); active.add(timer); return timer;
    }) as typeof setTimeout);
    const cleared = spyOn(globalThis, 'clearTimeout').mockImplementation(((timer: ReturnType<typeof setTimeout>) => {
      active.delete(timer); originalClear(timer);
    }) as typeof clearTimeout);
    try {
      await executeIdempotent(options(() => 'receipt')); expect(active.size).toBe(0);
      const controller = new AbortController();
      const pending = executeIdempotent({ ...options(() => 'no'), signal: controller.signal, authorize: () => new Promise<boolean>(() => {}) });
      controller.abort('cancel'); await expect(pending).rejects.toBe('cancel'); expect(active.size).toBe(0);
      await expect(executeIdempotent({ ...options(() => new Promise<never>(() => {})), timeoutMs: 2 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_TIMEOUT' });
      expect(active.size).toBe(0);
    } finally { armed.mockRestore(); cleared.mockRestore(); }
  });

  it('fails closed on corrupt remote states and result encodings', async () => {
    const store = new InMemoryIdempotencyStore();
    for (const result of [null, { status: 'alien' }, { status: 'replay', expiresAt: NaN, json: '1' }, { status: 'replay', expiresAt: 200, json: 'broken' }]) {
      await expect(executeIdempotent({ ...options(() => 'must not execute'), store: {
        claim: () => result as never, complete: store.complete.bind(store), markUnknown: store.markUnknown.bind(store),
      } })).rejects.toMatchObject({ status: 503 });
    }
    for (const timeoutMs of [0, NaN, 2_147_483_648]) await expect(executeIdempotent({ ...options(() => 'no'), timeoutMs })).rejects.toThrow('timeout');
  });
});

describe('atomic local store and bounded JSON', () => {
  it('fences stale completion and preserves expired uniqueness tombstones', () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.claim(claim)).toEqual({ status: 'claimed' });
    expect(store.complete(claim, 'wrong_token', '"receipt"')).toBe(false);
    expect(store.complete(claim, claim.token, '"receipt"')).toBe(true);
    expect(store.markUnknown(claim, claim.token)).toBe(false);
    expect(store.claim({ ...claim, now: 199, expiresAt: 300 })).toEqual({ status: 'replay', json: '"receipt"', expiresAt: 200 });
    expect(store.claim({ ...claim, now: 200, expiresAt: 300 })).toEqual({ status: 'expired' });
    expect(store.claim({ ...claim, now: 201, expiresAt: 300 })).toEqual({ status: 'expired' });
  });

  it('does not evict tombstones to make capacity', () => {
    const store = new InMemoryIdempotencyStore({ maxRecords: 1 }); store.claim(claim);
    expect(() => store.claim({ ...claim, key: 'different_request_key' })).toThrow('IDEMPOTENCY_CAPACITY');
    expect(() => new InMemoryIdempotencyStore({ maxRecords: 0 })).toThrow();
  });

  it('canonicalizes input digests, retains array order, and rejects lossy input', () => {
    expect(idempotencyDigest({ a: 1, b: ['x', 2] })).toBe(idempotencyDigest({ b: ['x', 2], a: 1 }));
    expect(idempotencyDigest([1, 2])).not.toBe(idempotencyDigest([2, 1]));
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const accessor = Object.defineProperty({}, 'x', { enumerable: true, get() { throw new Error('must not invoke'); } });
    for (const value of [NaN, Infinity, -0, undefined, 1n, new Date(), cycle, [, 1], accessor, { x: undefined }, Symbol('x')]) {
      expect(() => encodeIdempotencyValue(value)).toThrow();
    }
    expect(() => encodeIdempotencyValue('a'.repeat(65_537))).toThrow('64 KiB');
    expect(() => encodeIdempotencyValue('한'.repeat(22_000))).toThrow('64 KiB');
    expect(() => encodeIdempotencyValue(new Array(10_001).fill(0))).toThrow('complex');
    expect(createIdempotencyKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(idempotencyField(key)).toContain(`name="_bc_request" value="${key}"`);
    expect(() => idempotencyField('<unsafe>')).toThrow();
  });

  it('preserves the original failure if uncertainty marking also fails', async () => {
    const error = new Error('effect failure'); const store = new InMemoryIdempotencyStore();
    const input = { ...options(() => { throw error; }), store: {
      claim: store.claim.bind(store), complete: store.complete.bind(store), markUnknown: () => { throw new Error('offline'); },
    } };
    await expect(executeIdempotent(input)).rejects.toBe(error);
    await expect(executeIdempotent(input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_BUSY' });
  });
});
