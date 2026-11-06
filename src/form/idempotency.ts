import { createHash, randomBytes } from 'node:crypto';
import { escapeHtml } from './html.ts';

export type IdempotencyJson = null | boolean | number | string | readonly IdempotencyJson[] | { readonly [key: string]: IdempotencyJson };
export interface IdempotencyIdentity { readonly scope: string; readonly key: string; readonly inputDigest: string }
export interface IdempotencyClaim extends IdempotencyIdentity {
  readonly token: string;
  readonly now: number;
  readonly expiresAt: number;
}
export type IdempotencyClaimResult = Readonly<{ status: 'claimed' }> | Readonly<{ status: 'replay'; json: string; expiresAt: number }> |
  Readonly<{ status: 'busy' | 'conflict' | 'expired' | 'unknown' }>;
type MaybePromise<T> = T | Promise<T>;

/**
 * All methods must be atomic and durable for a production shared store. Completion is a token-fenced CAS.
 * Pending, uncertain and expired keys MUST NOT be reclaimed automatically, even after their TTL.
 * TTL limits replay, not the lifetime of the uniqueness tombstone. Operators own archival policy.
 */
export interface IdempotencyStore {
  claim(claim: IdempotencyClaim, signal?: AbortSignal): MaybePromise<IdempotencyClaimResult>;
  complete(identity: IdempotencyIdentity, token: string, json: string, signal?: AbortSignal): MaybePromise<boolean>;
  markUnknown(identity: IdempotencyIdentity, token: string, signal?: AbortSignal): MaybePromise<boolean>;
}

export class IdempotencyError extends Error {
  constructor(readonly status: 403 | 409 | 410 | 503, readonly code: string, options?: ErrorOptions) {
    super(code, options); this.name = 'IdempotencyError';
  }
}

export function assertIdempotencyIdentity(identity: IdempotencyIdentity): void {
  // UTF-8 stores replace lone surrogates, which would merge distinct JavaScript scopes.
  if (typeof identity.scope !== 'string' || identity.scope.length === 0 || identity.scope.length > 4096 || !identity.scope.isWellFormed()) throw new TypeError('invalid idempotency scope');
  if (typeof identity.key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(identity.key)) throw new TypeError('invalid idempotency key');
  if (typeof identity.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(identity.inputDigest)) throw new TypeError('invalid idempotency input digest');
}

export function assertIdempotencyClaim(claim: IdempotencyClaim): void {
  assertIdempotencyIdentity(claim);
  if (typeof claim.token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(claim.token)) throw new TypeError('invalid idempotency fencing token');
  if (!Number.isSafeInteger(claim.now) || claim.now < 0 || !Number.isSafeInteger(claim.expiresAt) || claim.expiresAt <= claim.now) throw new RangeError('invalid idempotency expiry');
}

/** Bounded canonical JSON; rejects lossy values, accessors and cycles before running any business effect. */
export function encodeIdempotencyValue(value: unknown): string {
  const ancestors = new Set<object>();
  const parts: string[] = [];
  let remainingBytes = 65_536;
  let nodes = 0;
  const append = (part: string): void => {
    const bytes = Buffer.byteLength(part);
    if (bytes > remainingBytes) throw new RangeError('idempotency JSON exceeds 64 KiB');
    remainingBytes -= bytes;
    parts.push(part);
  };
  const string = (item: string): void => {
    // JSON encoding cannot use fewer bytes than UTF-16 units, so reject huge keys before stringify.
    if (item.length > remainingBytes) throw new RangeError('idempotency JSON exceeds 64 KiB');
    append(JSON.stringify(item));
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 32) throw new RangeError('idempotency JSON is too complex');
    if (item === null || typeof item === 'boolean') { append(String(item)); return; }
    if (typeof item === 'string') { string(item); return; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) throw new TypeError('idempotency JSON requires finite numbers without negative zero');
      append(JSON.stringify(item)); return;
    }
    if (typeof item !== 'object' || ancestors.has(item)) throw new TypeError('idempotency value must be acyclic JSON');
    if (Object.getOwnPropertySymbols(item).length > 0) throw new TypeError('idempotency JSON cannot contain symbol keys');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        append('[');
        for (let i = 0; i < item.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
          if (descriptor === undefined || !('value' in descriptor)) throw new TypeError('idempotency JSON cannot contain array holes or accessors');
          if (i > 0) append(',');
          visit(descriptor.value, depth + 1);
        }
        if (Object.keys(item).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) throw new TypeError('idempotency arrays cannot have named properties');
        append(']'); return;
      }
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null) throw new TypeError('idempotency JSON requires plain objects');
      append('{');
      let first = true;
      for (const key of Object.keys(item).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!('value' in descriptor)) throw new TypeError('idempotency JSON cannot contain accessors');
        if (!first) append(',');
        first = false;
        string(key); append(':'); visit(descriptor.value, depth + 1);
      }
      append('}');
    } finally { ancestors.delete(item); }
  };
  visit(value, 0);
  return parts.join('');
}

export function idempotencyDigest(input: unknown): string {
  return createHash('sha256').update(encodeIdempotencyValue(input)).digest('hex');
}

function decodeResult<T extends IdempotencyJson>(json: string): T {
  if (typeof json !== 'string' || json.length > 65_536) throw new RangeError('idempotency JSON exceeds 64 KiB');
  const value = JSON.parse(json) as T;
  encodeIdempotencyValue(value);
  return value;
}

export function createIdempotencyKey(): string { return randomBytes(32).toString('base64url'); }

export function idempotencyField(key = createIdempotencyKey()): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new TypeError('invalid idempotency key');
  return `<input type="hidden" name="_bc_request" value="${escapeHtml(key)}">`;
}

export interface ExecuteIdempotentOptions<T extends IdempotencyJson> extends IdempotencyIdentity {
  readonly store: IdempotencyStore;
  /** Rechecked for EVERY call, including replays; never cache an authorization decision. */
  readonly authorize: (signal?: AbortSignal) => MaybePromise<boolean>;
  readonly execute: (signal?: AbortSignal) => MaybePromise<T>;
  readonly signal?: AbortSignal;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly newToken?: () => string;
  /** Per-operation deadline, including host callbacks and remote stores. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

/** Bound an adapter that ignores cancellation too; late settlements cannot win the already-failed call. */
async function boundedOperation<T>(operation: (signal: AbortSignal) => MaybePromise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal!.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new IdempotencyError(503, 'IDEMPOTENCY_TIMEOUT', {
    cause: new DOMException('idempotency operation exceeded its deadline', 'TimeoutError'),
  })), timeoutMs);
  let stop: (() => void) | undefined;
  try {
    const result = operation(controller.signal);
    // Preserve a synchronous successful effect even if it observed a disconnect just before returning.
    if (result === null || (typeof result !== 'object' && typeof result !== 'function') || !('then' in result)) return result;
    return await new Promise<T>((resolve, reject) => {
      stop = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', stop, { once: true });
      Promise.resolve(result).then(resolve, reject);
      if (controller.signal.aborted) stop();
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (stop !== undefined) controller.signal.removeEventListener('abort', stop);
  }
}

/**
 * At-most-one automatic attempt: an exception/cancellation after claim leaves a blocked key, never a retry.
 * A crash between a host side effect and completion remains uncertain; this is NOT an exactly-once transaction.
 * Use a store-specific transaction with the business write when the two records share a database.
 */
export async function executeIdempotent<T extends IdempotencyJson>(options: ExecuteIdempotentOptions<T>): Promise<Readonly<{ value: T; replayed: boolean }>> {
  const identity = Object.freeze({ scope: options.scope, key: options.key, inputDigest: options.inputDigest });
  assertIdempotencyIdentity(identity);
  const { signal, store, authorize, execute } = options;
  const newToken = options.newToken ?? createIdempotencyKey;
  const clock = options.now ?? Date.now;
  signal?.throwIfAborted();
  const ttl = options.ttlMs ?? 86_400_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('invalid idempotency TTL or timeout');
  if (await boundedOperation(authorize, timeoutMs, signal) !== true) throw new IdempotencyError(403, 'IDEMPOTENCY_FORBIDDEN');
  signal?.throwIfAborted();
  // Authorization may perform I/O; start the acceptance lifetime only after it finishes.
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + ttl)) throw new RangeError('invalid idempotency clock or TTL');
  const currentTime = () => {
    const measured = clock();
    if (!Number.isSafeInteger(measured) || measured < now) throw new RangeError('invalid idempotency clock');
    return measured;
  };
  const token = newToken();
  const claim = Object.freeze({ ...identity, token, now, expiresAt: now + ttl });
  assertIdempotencyClaim(claim);
  const result = await boundedOperation((operationSignal) => store.claim(claim, operationSignal), timeoutMs, signal);
  if (result === null || typeof result !== 'object' || !Object.hasOwn(result, 'status')) throw new IdempotencyError(503, 'IDEMPOTENCY_CORRUPT_RESULT');
  if (result.status === 'replay') {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(result.expiresAt) || result.expiresAt < 1) throw new IdempotencyError(503, 'IDEMPOTENCY_CORRUPT_RESULT');
    if (currentTime() >= result.expiresAt) throw new IdempotencyError(410, 'IDEMPOTENCY_EXPIRED');
    let value: T;
    try { value = decodeResult<T>(result.json); }
    catch (cause) { throw new IdempotencyError(503, 'IDEMPOTENCY_CORRUPT_RESULT', { cause }); }
    return Object.freeze({ value, replayed: true });
  }
  if (result.status !== 'claimed') {
    signal?.throwIfAborted();
    if (result.status === 'expired') throw new IdempotencyError(410, 'IDEMPOTENCY_EXPIRED');
    if (!['busy', 'conflict', 'unknown'].includes(result.status)) throw new IdempotencyError(503, 'IDEMPOTENCY_CORRUPT_RESULT');
    throw new IdempotencyError(409, `IDEMPOTENCY_${result.status.toUpperCase()}`);
  }
  try {
    signal?.throwIfAborted();
    if (currentTime() >= claim.expiresAt) throw new IdempotencyError(410, 'IDEMPOTENCY_EXPIRED');
    const value = await boundedOperation(execute, timeoutMs, signal);
    const json = encodeIdempotencyValue(value);
    // Complete even if the caller disconnected after the effect, so a later authorized replay can recover.
    if (await boundedOperation((operationSignal) => store.complete(identity, token, json, operationSignal), timeoutMs) !== true) throw new IdempotencyError(503, 'IDEMPOTENCY_COMPLETION_UNCERTAIN');
    signal?.throwIfAborted();
    return Object.freeze({ value: JSON.parse(json) as T, replayed: false });
  } catch (error) {
    try { await boundedOperation((operationSignal) => store.markUnknown(identity, token, operationSignal), Math.min(timeoutMs, 1000)); }
    catch { /* Pending also blocks retries; preserve the original failure. */ }
    signal?.throwIfAborted();
    throw error;
  }
}

interface MemoryRecord { readonly digest: string; readonly token: string; readonly expiresAt: number; status: 'pending' | 'complete' | 'unknown'; json?: string }

/** Test/development store, bounded and process-local; do not use for durable effects or across replicas. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly maxRecords: number;
  constructor(options: Readonly<{ maxRecords?: number }> = {}) {
    this.maxRecords = options.maxRecords ?? 10_000;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords <= 0) throw new RangeError('invalid idempotency capacity');
  }
  private key(identity: IdempotencyIdentity): string { return JSON.stringify([identity.scope, identity.key]); }
  claim(claim: IdempotencyClaim, signal?: AbortSignal): IdempotencyClaimResult {
    signal?.throwIfAborted(); assertIdempotencyClaim(claim);
    const key = this.key(claim);
    const current = this.records.get(key);
    if (current !== undefined) {
      if (current.digest !== claim.inputDigest) return { status: 'conflict' };
      if (claim.now >= current.expiresAt) return { status: 'expired' };
      if (current.status === 'complete') return { status: 'replay', json: current.json!, expiresAt: current.expiresAt };
      return { status: current.status === 'unknown' ? 'unknown' : 'busy' };
    }
    if (this.records.size >= this.maxRecords) throw new IdempotencyError(503, 'IDEMPOTENCY_CAPACITY');
    this.records.set(key, { digest: claim.inputDigest, token: claim.token, expiresAt: claim.expiresAt, status: 'pending' });
    return { status: 'claimed' };
  }
  complete(identity: IdempotencyIdentity, token: string, json: string, signal?: AbortSignal): boolean {
    signal?.throwIfAborted(); assertIdempotencyIdentity(identity);
    const canonical = encodeIdempotencyValue(decodeResult(json));
    const current = this.records.get(this.key(identity));
    if (current === undefined || current.status !== 'pending' || current.token !== token || current.digest !== identity.inputDigest) return false;
    current.json = canonical; current.status = 'complete'; return true;
  }
  markUnknown(identity: IdempotencyIdentity, token: string, signal?: AbortSignal): boolean {
    signal?.throwIfAborted(); assertIdempotencyIdentity(identity);
    const current = this.records.get(this.key(identity));
    if (current === undefined || current.status !== 'pending' || current.token !== token || current.digest !== identity.inputDigest) return false;
    current.status = 'unknown'; return true;
  }
}
