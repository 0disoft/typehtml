import { describe, expect, it, spyOn } from 'bun:test';
import { InMemoryActionRateLimiter } from '../../src/adapter/hono/rate-limit.ts';

const context = {
  principal: { tenantId: 't', subjectId: 's', sessionId: 'session' },
  actionId: 'orders.createDraft',
  phase: 'submit' as const,
};

describe('reference account rate limiter', () => {
  it('examines at most one full set of buckets for repeated new keys before any bucket can expire', () => {
    const maxKeys = 8;
    const limiter = new InMemoryActionRateLimiter({ now: () => 0, maxKeys });
    for (let index = 0; index < maxKeys; index++) limiter.consume({ ...context, actionId: `filled_${index}` });
    const originalIterator = Map.prototype[Symbol.iterator];
    let examined = 0;
    const iterations = spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (this: Map<unknown, unknown>) {
      const iterator = originalIterator.call(this);
      const next = iterator.next.bind(iterator);
      iterator.next = () => {
        const result = next();
        if (!result.done) examined++;
        return result;
      };
      return iterator;
    });
    let denied = 0;
    try {
      // Keep this synchronous and restore instrumentation before assertions.
      for (let index = 0; index < 100; index++) {
        if (!limiter.consume({ ...context, actionId: `new_${index}` }).allow) denied++;
      }
    } finally { iterations.mockRestore(); }
    expect(denied).toBe(100);
    expect(examined).toBeLessThanOrEqual(maxKeys);
  });

  it('keeps renewed buckets active when the original oldest post reaches expiry', () => {
    let now = 0;
    const limiter = new InMemoryActionRateLimiter({ now: () => now, windowMs: 100, maxKeys: 2 });
    const first = { ...context, actionId: 'first' };
    const second = { ...context, actionId: 'second' };
    const third = { ...context, actionId: 'third' };
    expect(limiter.consume(first).allow).toBe(true);
    now = 50;
    expect(limiter.consume(second).allow).toBe(true);
    expect(limiter.consume(third)).toEqual({ allow: false, retryAfterSeconds: 1 });
    now = 75;
    expect(limiter.consume(first).allow).toBe(true);
    now = 100;
    expect(limiter.consume(third).allow).toBe(false);
    now = 149;
    expect(limiter.consume(third).allow).toBe(false);
    now = 150;
    expect(limiter.consume(third).allow).toBe(true);
    expect(limiter.consume(first).allow).toBe(true);
  });

  it('reclaims a refilled bucket at its next exact expiry after every previous bucket expired', () => {
    let now = 0;
    const limiter = new InMemoryActionRateLimiter({ now: () => now, windowMs: 100, maxKeys: 1 });
    const second = { ...context, actionId: 'second' };
    const third = { ...context, actionId: 'third' };
    expect(limiter.consume(context).allow).toBe(true);
    expect(limiter.consume(second).allow).toBe(false);
    now = 100;
    expect(limiter.consume(second).allow).toBe(true);
    now = 199;
    expect(limiter.consume(third).allow).toBe(false);
    now = 200;
    expect(limiter.consume(third).allow).toBe(true);
  });

  it.each([
    ['fractional', 0.5, 1.499, 1.5, 1],
    ['large', 9_007_199_254_740_996, 9_007_199_254_740_996, 9_007_199_254_740_998, 3],
  ] as const)('preserves the original subtraction-based expiry with a %s clock', (_kind, issuedAt, before, expiredAt, windowMs) => {
    let now: number = issuedAt;
    const limiter = new InMemoryActionRateLimiter({ now: () => now, windowMs, maxKeys: 1 });
    const next = { ...context, actionId: 'next' };
    expect(limiter.consume(context).allow).toBe(true);
    now = before;
    expect(limiter.consume(next).allow).toBe(false);
    now = expiredAt;
    expect(limiter.consume(next).allow).toBe(true);
  });

  it('shares the POST budget across sessions and begin/submit while isolating tenants', () => {
    const limiter = new InMemoryActionRateLimiter({ now: () => 0, maxPosts: 2 });
    expect(limiter.consume(context).allow).toBe(true);
    expect(limiter.consume({ ...context, phase: 'begin' }).allow).toBe(true);
    expect(limiter.consume({ ...context, principal: { ...context.principal, sessionId: 'other' } })).toEqual({
      allow: false, retryAfterSeconds: 60,
    });
    expect(limiter.consume({ ...context, principal: { ...context.principal, tenantId: 'other' } }).allow).toBe(true);
  });

  it('bounds active account storage and reclaims expired buckets without evicting active limits', () => {
    let now = 0;
    const limiter = new InMemoryActionRateLimiter({ now: () => now, maxKeys: 1, maxPosts: 1 });
    expect(limiter.consume(context).allow).toBe(true);
    expect(limiter.consume({ ...context, actionId: 'other' }).allow).toBe(false);
    expect(limiter.consume(context).allow).toBe(false);
    now = 60_000;
    expect(limiter.consume({ ...context, actionId: 'other' }).allow).toBe(true);
  });

  it('does not reset a budget when the supplied clock goes backwards', () => {
    let now = 1000;
    const limiter = new InMemoryActionRateLimiter({ now: () => now, maxPosts: 1 });
    limiter.consume(context);
    now = 0;
    expect(limiter.consume(context).allow).toBe(false);
  });
});
