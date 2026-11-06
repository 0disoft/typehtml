import { createHmac, randomBytes as platformRandomBytes, timingSafeEqual } from 'node:crypto';
import { CsrfError } from '../runtime/csrf.ts';
import { escapeHtml } from './html.ts';

export interface SignedCsrfOptions {
  /** At least 32 secret bytes, supplied by the host's secret manager. */
  readonly secret: string | Uint8Array;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`invalid ${name}`);
  return value;
}

function clock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('invalid security clock');
  return value;
}

/** Signed, session-bound tokens. The host still owns authentication, cookies and key rotation. */
export function createSignedCsrf(options: SignedCsrfOptions): Readonly<{
  issue(sessionId: string): string;
  verify(token: string, sessionId: string): boolean;
  assert(token: string, sessionId: string): void;
}> {
  const secret = Buffer.from(typeof options.secret === 'string' ? new TextEncoder().encode(options.secret) : options.secret);
  if (secret.length < 32) throw new RangeError('CSRF secret must contain at least 32 bytes');
  const ttl = positiveInteger(options.ttlMs ?? 3_600_000, 'CSRF ttl');
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? platformRandomBytes;
  const session = (id: string) => typeof id === 'string' && id.length > 0 && id.length <= 4096;
  const signature = (id: string, issued: number, expires: number, nonce: string) => createHmac('sha256', secret)
    .update(JSON.stringify(['typehtml-csrf/1', id, issued, expires, nonce])).digest();
  const verify = (token: string, sessionId: string): boolean => {
    if (typeof token !== 'string' || token.length > 256 || !session(sessionId)) return false;
    const parts = /^v1\.(0|[1-9][0-9]*)\.([1-9][0-9]*)\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (parts === null) return false;
    const issued = Number(parts[1]);
    const expires = Number(parts[2]);
    if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(expires) || expires <= issued || expires - issued > ttl) return false;
    const measured = clock(now);
    if (measured < issued || measured >= expires) return false;
    const received = Buffer.from(parts[4]!, 'base64url');
    if (received.length !== 32 || received.toString('base64url') !== parts[4]) return false;
    return timingSafeEqual(received, signature(sessionId, issued, expires, parts[3]!));
  };
  return Object.freeze({
    issue(sessionId: string): string {
      if (!session(sessionId)) throw new TypeError('a stable authenticated session ID is required');
      const issued = clock(now);
      const expires = issued + ttl;
      if (!Number.isSafeInteger(expires)) throw new RangeError('CSRF expiry overflow');
      const bytes = random(32);
      if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new TypeError('CSRF random source must return 32 bytes');
      const nonce = Buffer.from(bytes).toString('base64url');
      return `v1.${issued}.${expires}.${nonce}.${signature(sessionId, issued, expires, nonce).toString('base64url')}`;
    },
    verify,
    assert(token: string, sessionId: string): void { if (!verify(token, sessionId)) throw new CsrfError(); },
  });
}

export function csrfField(token: string): string {
  return `<input type="hidden" name="_bc_csrf" value="${escapeHtml(token)}">`;
}

export type RequestRateLimitDecision = Readonly<{ allow: true }> | Readonly<{ allow: false; retryAfterSeconds: number }>;

/** Shared implementations must consume atomically. Keys should include the authenticated principal and action. */
export interface RequestRateLimiter {
  consume(key: string, signal?: AbortSignal): RequestRateLimitDecision | Promise<RequestRateLimitDecision>;
}

export class RateLimitError extends Error {
  readonly status = 429;
  readonly code = 'RATE_LIMITED';
  constructor(readonly retryAfterSeconds: number) {
    super('request rate limit exceeded'); positiveInteger(retryAfterSeconds, 'retry-after'); this.name = 'RateLimitError';
  }
}

export class RateLimitUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'RATE_LIMIT_UNAVAILABLE';
  constructor(options?: ErrorOptions) { super('request rate limit service unavailable', options); this.name = 'RateLimitUnavailableError'; }
}

/** Bounds remote adapters even when they ignore their signal; failures are never treated as permission. */
export async function consumeRateLimit(
  limiter: RequestRateLimiter, key: string, options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {},
): Promise<RequestRateLimitDecision> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (typeof key !== 'string' || key.length === 0 || key.length > 4096) throw new TypeError('invalid rate limit key');
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('invalid rate limit timeout');
  const controller = new AbortController();
  const abort = () => controller.abort(signal!.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new RateLimitUnavailableError({
    cause: new DOMException('rate limit operation exceeded its deadline', 'TimeoutError'),
  })), timeoutMs);
  let stop: (() => void) | undefined;
  try {
    const pending = limiter.consume(key, controller.signal);
    const decision = await new Promise<RequestRateLimitDecision>((resolve, reject) => {
      stop = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', stop, { once: true });
      Promise.resolve(pending).then(resolve, reject);
      if (controller.signal.aborted) stop();
    });
    signal?.throwIfAborted();
    if (decision === null || typeof decision !== 'object' || typeof decision.allow !== 'boolean') throw new TypeError('invalid rate limit decision');
    if (decision.allow) return Object.freeze({ allow: true });
    positiveInteger(decision.retryAfterSeconds, 'retry-after');
    return Object.freeze({ allow: false, retryAfterSeconds: decision.retryAfterSeconds });
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof RateLimitUnavailableError) throw cause;
    throw new RateLimitUnavailableError({ cause });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (stop !== undefined) controller.signal.removeEventListener('abort', stop);
  }
}

/** Bounded fixed windows, local to this process. Use a shared atomic store across replicas. */
export class InMemoryRateLimiter implements RequestRateLimiter {
  private readonly buckets = new Map<string, { count: number; expires: number }>();
  private readonly now: () => number;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private lastTime = 0;

  constructor(options: Readonly<{ limit?: number; windowMs?: number; maxKeys?: number; now?: () => number }> = {}) {
    this.limit = positiveInteger(options.limit ?? 30, 'rate limit');
    this.windowMs = positiveInteger(options.windowMs ?? 60_000, 'rate window');
    this.maxKeys = positiveInteger(options.maxKeys ?? 10_000, 'rate capacity');
    this.now = options.now ?? (() => Math.floor(performance.now()));
  }

  consume(key: string, signal?: AbortSignal): RequestRateLimitDecision {
    signal?.throwIfAborted();
    if (typeof key !== 'string' || key.length === 0 || key.length > 4096) throw new TypeError('invalid rate limit key');
    const measured = clock(this.now);
    const now = this.lastTime = Math.max(this.lastTime, measured);
    let bucket = this.buckets.get(key);
    if (bucket !== undefined && bucket.expires <= now) { this.buckets.delete(key); bucket = undefined; }
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) {
        // Fixed windows are inserted in monotonic expiry order; active capacity costs one probe.
        for (const [candidate, value] of this.buckets) {
          if (value.expires > now) break;
          this.buckets.delete(candidate);
        }
      }
      if (this.buckets.size >= this.maxKeys) return { allow: false, retryAfterSeconds: 1 };
      const expires = now + this.windowMs;
      if (!Number.isSafeInteger(expires)) throw new RangeError('rate window overflow');
      bucket = { count: 0, expires };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= this.limit) return { allow: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.expires - now) / 1000)) };
    bucket.count++;
    return { allow: true };
  }
}

export async function assertRateLimit(
  limiter: RequestRateLimiter, key: string, signal?: AbortSignal, options: Readonly<{ timeoutMs?: number }> = {},
): Promise<void> {
  const decision = await consumeRateLimit(limiter, key, { ...options, signal });
  if (decision.allow) return;
  throw new RateLimitError(decision.retryAfterSeconds);
}
