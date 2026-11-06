import { describe, expect, it } from 'bun:test';
import { assertRateLimit, createSignedCsrf, csrfField, InMemoryRateLimiter, RateLimitError } from '../../src/form/security.ts';

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
    await expect(assertRateLimit({ consume: () => ({ allow: false, retryAfterSeconds: 0 }) }, 'a')).rejects.toThrow('retry-after');
    for (const options of [{ limit: 0 }, { maxKeys: -1 }, { windowMs: NaN }]) expect(() => new InMemoryRateLimiter(options)).toThrow();
    expect(() => new InMemoryRateLimiter({ now: () => NaN }).consume('a')).toThrow('clock');
  });
});
