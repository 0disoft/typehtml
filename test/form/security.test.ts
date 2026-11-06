import { describe, expect, it, spyOn } from 'bun:test';
import { assertRateLimit, consumeRateLimit, createSignedCsrf, csrfField, InMemoryRateLimiter, RateLimitError, RateLimitUnavailableError } from '../../src/form/security.ts';

describe('signed session-bound CSRF tokens', () => {
  it('uses cryptographic defaults and binds tokens to the session and secret', () => {
    const csrf = createSignedCsrf({ secret: 's'.repeat(32) });
    const first = csrf.issue('session-a');
    expect(first).not.toBe(csrf.issue('session-a'));
    expect(csrf.verify(first, 'session-a')).toBe(true);
    expect(csrf.verify(first, 'session-b')).toBe(false);
    expect(createSignedCsrf({ secret: 't'.repeat(32) }).verify(first, 'session-a')).toBe(false);
    expect(() => csrf.assert(first, 'session-b')).toThrow('CSRF token does not match');
  });

  it('expires precisely at the boundary and rejects future-issued tokens', () => {
    let now = 100;
    const csrf = createSignedCsrf({ secret: 's'.repeat(32), ttlMs: 10, now: () => now, randomBytes: (n) => new Uint8Array(n) });
    const token = csrf.issue('session');
    now = 99; expect(csrf.verify(token, 'session')).toBe(false);
    now = 100; expect(csrf.verify(token, 'session')).toBe(true);
    now = 109; expect(csrf.verify(token, 'session')).toBe(true);
    now = 110; expect(csrf.verify(token, 'session')).toBe(false);
    now = 111; expect(csrf.verify(token, 'session')).toBe(false);
  });

  it('rejects tampering and malformed tokens without accepting alternate MAC encodings', () => {
    const csrf = createSignedCsrf({ secret: 's'.repeat(32), now: () => 100, randomBytes: (n) => new Uint8Array(n) });
    const token = csrf.issue('session');
    for (const value of ['', 'v1', token + 'x', token.replace('.100.', '.0100.'), token.replace('3600100', '3600101'), 'x'.repeat(10_000)]) {
      expect(csrf.verify(value, 'session')).toBe(false);
    }
    expect(csrfField('"<>&')).toBe('<input type="hidden" name="_bc_csrf" value="&quot;&lt;&gt;&amp;">');
  });

  it('copies the secret and rejects weak sources and overflow', () => {
    const secret = new Uint8Array(32).fill(1);
    const csrf = createSignedCsrf({ secret, now: () => 100 });
    const token = csrf.issue('session'); secret.fill(2);
    expect(csrf.verify(token, 'session')).toBe(true);
    expect(() => createSignedCsrf({ secret: 'small' })).toThrow();
    expect(() => createSignedCsrf({ secret, ttlMs: 0 })).toThrow();
    expect(() => createSignedCsrf({ secret, now: () => Number.MAX_SAFE_INTEGER }).issue('s')).toThrow('overflow');
    expect(() => createSignedCsrf({ secret, randomBytes: () => new Uint8Array(1) }).issue('s')).toThrow('32 bytes');
    expect(() => csrf.issue('')).toThrow();
  });
});

describe('bounded local fixed-window request limiter', () => {
  it('allows exactly the configured count and resets at expiry equality', () => {
    let now = 0;
    const limiter = new InMemoryRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    expect(limiter.consume('a')).toEqual({ allow: true });
    expect(limiter.consume('a')).toEqual({ allow: true });
    expect(limiter.consume('a')).toEqual({ allow: false, retryAfterSeconds: 1 });
    now = 999; expect(limiter.consume('a').allow).toBe(false);
    now = 1000; expect(limiter.consume('a').allow).toBe(true);
    expect(limiter.consume('a').allow).toBe(true);
    expect(limiter.consume('a').allow).toBe(false);
    now = 999; expect(limiter.consume('a').allow).toBe(false);
  });

  it('fails closed at capacity instead of evicting active principals', () => {
    let now = 0;
    const limiter = new InMemoryRateLimiter({ limit: 1, maxKeys: 1, windowMs: 100, now: () => now });
    expect(limiter.consume('a').allow).toBe(true);
    expect(limiter.consume('b').allow).toBe(false);
    expect(limiter.consume('a').allow).toBe(false);
    now = 100;
    expect(limiter.consume('b').allow).toBe(true);
  });

  it('propagates exact cancellation and validates external decisions', async () => {
    const controller = new AbortController(); const reason = new Error('cancel'); controller.abort(reason);
    expect(() => new InMemoryRateLimiter().consume('a', controller.signal)).toThrow(reason);
    await expect(assertRateLimit(new InMemoryRateLimiter(), 'a', controller.signal)).rejects.toBe(reason);
    await expect(assertRateLimit({ consume: () => ({ allow: false, retryAfterSeconds: 2 }) }, 'a')).rejects.toBeInstanceOf(RateLimitError);
    await expect(assertRateLimit({ consume: () => ({ allow: false, retryAfterSeconds: 0 }) }, 'a')).rejects.toMatchObject({
      code: 'RATE_LIMIT_UNAVAILABLE', cause: { message: 'invalid retry-after' },
    });
    for (const options of [{ limit: 0 }, { maxKeys: -1 }, { windowMs: NaN }]) expect(() => new InMemoryRateLimiter(options)).toThrow();
    expect(() => new InMemoryRateLimiter({ now: () => NaN }).consume('a')).toThrow('clock');
  });
});

describe('bounded remote rate limit adapter', () => {
  it('validates and snapshots external decisions', async () => {
    const allowed = await consumeRateLimit({ consume: () => ({ allow: true }) }, 'key');
    const original = { allow: false as const, retryAfterSeconds: 3 };
    const denied = await consumeRateLimit({ consume: async () => original }, 'key');
    original.retryAfterSeconds = 99;
    expect(allowed).toEqual({ allow: true }); expect(denied).toEqual({ allow: false, retryAfterSeconds: 3 });
    expect(Object.isFrozen(denied)).toBe(true);
    for (const result of [null, {}, { allow: 'true' }, { allow: false, retryAfterSeconds: -1 }, { allow: false, retryAfterSeconds: Infinity }]) {
      await expect(consumeRateLimit({ consume: () => result as never }, 'key')).rejects.toBeInstanceOf(RateLimitUnavailableError);
    }
  });

  it('preserves the underlying failure as cause and never retries', async () => {
    const cause = new Error('connection refused'); let calls = 0;
    await expect(consumeRateLimit({ consume: async () => { calls++; throw cause; } }, 'key')).rejects.toMatchObject({
      status: 503, code: 'RATE_LIMIT_UNAVAILABLE', cause,
    });
    expect(calls).toBe(1);
    await expect(consumeRateLimit({ consume: () => { throw cause; } }, 'key')).rejects.toMatchObject({ cause });
  });

  it('times out an adapter that ignores cancellation and aborts the signal supplied to it', async () => {
    let signal: AbortSignal | undefined; let calls = 0;
    await expect(consumeRateLimit({ consume: (_key, passed) => { calls++; signal = passed; return new Promise<never>(() => {}); } }, 'key', { timeoutMs: 2 })).rejects.toMatchObject({
      status: 503, cause: { name: 'TimeoutError' },
    });
    expect(signal?.aborted).toBe(true); expect(calls).toBe(1);
    await expect(assertRateLimit({ consume: () => new Promise<never>(() => {}) }, 'key', undefined, { timeoutMs: 2 })).rejects.toBeInstanceOf(RateLimitUnavailableError);
  });

  it('returns the exact request cancellation reason without waiting for the adapter', async () => {
    const controller = new AbortController(); const reason = { cancelled: true };
    const pending = consumeRateLimit({ consume: () => new Promise<never>(() => {}) }, 'key', { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    let called = false;
    await expect(consumeRateLimit({ consume: () => { called = true; return { allow: true }; } }, 'key', { signal: controller.signal })).rejects.toBe(reason);
    expect(called).toBe(false);
  });

  it('cleans deadline timers after success, failure and cancellation', async () => {
    const originalSet = globalThis.setTimeout; const originalClear = globalThis.clearTimeout;
    const active = new Set<ReturnType<typeof setTimeout>>();
    const armed = spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const timer = originalSet(...args); active.add(timer); return timer;
    }) as typeof setTimeout);
    const cleared = spyOn(globalThis, 'clearTimeout').mockImplementation(((timer: ReturnType<typeof setTimeout>) => {
      active.delete(timer); originalClear(timer);
    }) as typeof clearTimeout);
    try {
      await consumeRateLimit({ consume: () => ({ allow: true }) }, 'key'); expect(active.size).toBe(0);
      await expect(consumeRateLimit({ consume: () => new Promise<never>(() => {}) }, 'key', { timeoutMs: 2 })).rejects.toBeInstanceOf(RateLimitUnavailableError);
      expect(active.size).toBe(0);
      const controller = new AbortController();
      const pending = consumeRateLimit({ consume: () => new Promise<never>(() => {}) }, 'key', { signal: controller.signal });
      controller.abort('cancel'); await expect(pending).rejects.toBe('cancel'); expect(active.size).toBe(0);
    } finally { armed.mockRestore(); cleared.mockRestore(); }
    for (const timeoutMs of [0, NaN, 2_147_483_648]) await expect(consumeRateLimit(new InMemoryRateLimiter(), 'key', { timeoutMs })).rejects.toThrow('timeout');
  });
});
