import type { Principal } from '../../runtime/order.ts';

export type RateLimitDecision =
  | Readonly<{ allow: true }>
  | Readonly<{ allow: false; retryAfterSeconds: number }>;

export type ActionRateLimitContext = Readonly<{
  principal: Principal;
  actionId: string;
  phase: 'begin' | 'submit';
}>;

/** A service may supply a shared account limiter without changing the coordinator. */
export interface ActionRateLimiter {
  consume(context: ActionRateLimitContext): RateLimitDecision | Promise<RateLimitDecision>;
}

type Bucket = { posts: number[]; begins: number[] };

/** Bounded, single-process reference limiter; it is not shared across app instances. */
export class InMemoryActionRateLimiter implements ActionRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maxPosts: number;
  private readonly maxBegins: number;
  private readonly maxKeys: number;
  private lastTime = 0;
  private nextPruneCutoff = -Infinity;

  constructor(options: Readonly<{
    now?: () => number;
    windowMs?: number;
    maxPosts?: number;
    maxBegins?: number;
    maxKeys?: number;
  }> = {}) {
    this.now = options.now ?? (() => performance.now());
    this.windowMs = options.windowMs ?? 60_000;
    this.maxPosts = options.maxPosts ?? 30;
    this.maxBegins = options.maxBegins ?? 10;
    this.maxKeys = options.maxKeys ?? 10_000;
    for (const value of [this.windowMs, this.maxPosts, this.maxBegins, this.maxKeys]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('INVALID_RATE_LIMIT_OPTIONS');
    }
  }

  consume(context: ActionRateLimitContext): RateLimitDecision {
    const measured = this.now();
    if (!Number.isFinite(measured) || measured < 0) throw new Error('INVALID_RATE_LIMIT_CLOCK');
    const now = Math.max(this.lastTime, measured);
    this.lastTime = now;
    const cutoff = now - this.windowMs;
    const key = JSON.stringify([context.principal.tenantId, context.principal.subjectId, context.actionId]);
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys && cutoff >= this.nextPruneCutoff) {
        this.nextPruneCutoff = Infinity;
        for (const [candidateKey, candidate] of this.buckets) {
          const lastPost = candidate.posts.at(-1) ?? -Infinity;
          if (lastPost <= cutoff) this.buckets.delete(candidateKey);
          else this.nextPruneCutoff = Math.min(this.nextPruneCutoff, lastPost);
        }
      }
      if (this.buckets.size >= this.maxKeys) return { allow: false, retryAfterSeconds: 1 };
      bucket = { posts: [], begins: [] };
      this.buckets.set(key, bucket);
    }
    bucket.posts = bucket.posts.filter((time) => time > cutoff);
    bucket.begins = bucket.begins.filter((time) => time > cutoff);
    let retryAt = 0;
    if (bucket.posts.length >= this.maxPosts) retryAt = bucket.posts[0]! + this.windowMs;
    if (context.phase === 'begin' && bucket.begins.length >= this.maxBegins) {
      retryAt = Math.max(retryAt, bucket.begins[0]! + this.windowMs);
    }
    if (retryAt > now) {
      return { allow: false, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)) };
    }
    bucket.posts.push(now);
    if (context.phase === 'begin') bucket.begins.push(now);
    // A lower bound stays safe when existing buckets receive newer posts.
    this.nextPruneCutoff = Math.min(this.nextPruneCutoff, now);
    return { allow: true };
  }
}
