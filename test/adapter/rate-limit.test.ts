import { describe, expect, it } from 'bun:test';
import { InMemoryActionRateLimiter } from '../../src/adapter/hono/rate-limit.ts';

const context = {
  principal: { tenantId: 't', subjectId: 's', sessionId: 'session' },
  actionId: 'orders.createDraft',
  phase: 'submit' as const,
};

describe('reference account rate limiter', () => {
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
