import { Database } from 'bun:sqlite';
import { isAsyncFunction } from 'node:util/types';
import {
  assertIdempotencyClaim, assertIdempotencyIdentity, createIdempotencyKey, encodeIdempotencyValue, IdempotencyError,
  type IdempotencyClaim, type IdempotencyClaimResult, type IdempotencyIdentity, type IdempotencyJson, type IdempotencyStore,
} from '../../form/idempotency.ts';

interface Row { input_digest: string; token: string; expires_at: number; state: 'pending' | 'complete' | 'unknown'; outcome_json: string | null }

function isDeclaredAsync(callback: Function): boolean {
  // util/types does not recognize bound async functions, but their intrinsic tag is retained.
  return isAsyncFunction(callback) || Object.prototype.toString.call(callback) === '[object AsyncFunction]';
}

/** Durable token-fenced storage. Keys are never silently recycled; expired rows remain uniqueness tombstones. */
export class SqliteIdempotencyStore implements IdempotencyStore {
  private readonly db: Database;
  constructor(filename: string) {
    const db = new Database(filename, { strict: true });
    let ready = false;
    try {
      db.exec('PRAGMA busy_timeout = 1000');
      if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      db.exec(`CREATE TABLE IF NOT EXISTS typehtml_idempotency (
        scope TEXT NOT NULL, request_key TEXT NOT NULL, input_digest TEXT NOT NULL,
        token TEXT NOT NULL, expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'unknown')),
        outcome_json TEXT,
        PRIMARY KEY (scope, request_key),
        CHECK ((state = 'complete' AND outcome_json IS NOT NULL) OR (state != 'complete' AND outcome_json IS NULL))
      ) STRICT;`);
      ready = true;
    } finally { if (!ready) db.close(true); }
    this.db = db;
  }

  claim(claim: IdempotencyClaim, signal?: AbortSignal): IdempotencyClaimResult {
    signal?.throwIfAborted(); assertIdempotencyClaim(claim);
    return this.db.transaction(() => this.claimInsideTransaction(claim)).immediate();
  }

  private claimInsideTransaction(claim: IdempotencyClaim): IdempotencyClaimResult {
    const changed = this.db.query(`INSERT INTO typehtml_idempotency
      (scope, request_key, input_digest, token, expires_at, state, outcome_json)
      VALUES (?, ?, ?, ?, ?, 'pending', NULL) ON CONFLICT(scope, request_key) DO NOTHING`)
      .run(claim.scope, claim.key, claim.inputDigest, claim.token, claim.expiresAt).changes;
    if (changed === 1) return { status: 'claimed' };
    const row = this.db.query('SELECT input_digest, token, expires_at, state, outcome_json FROM typehtml_idempotency WHERE scope = ? AND request_key = ?')
      .get(claim.scope, claim.key) as Row | null;
    if (row === null) throw new IdempotencyError(503, 'IDEMPOTENCY_MISSING_RECORD');
    if (!/^[a-f0-9]{64}$/.test(row.input_digest) || !/^[A-Za-z0-9_-]{16,128}$/.test(row.token) ||
        !Number.isSafeInteger(row.expires_at) || row.expires_at < 1 || !['pending', 'complete', 'unknown'].includes(row.state) ||
        (row.state === 'complete' ? typeof row.outcome_json !== 'string' : row.outcome_json !== null)) {
      throw new IdempotencyError(503, 'IDEMPOTENCY_CORRUPT_RECORD');
    }
    if (row.input_digest !== claim.inputDigest) return { status: 'conflict' };
    if (claim.now >= row.expires_at) return { status: 'expired' };
    if (row.state === 'complete') return { status: 'replay', json: row.outcome_json!, expiresAt: row.expires_at };
    return { status: row.state === 'unknown' ? 'unknown' : 'busy' };
  }

  complete(identity: IdempotencyIdentity, token: string, json: string, signal?: AbortSignal): boolean {
    signal?.throwIfAborted(); assertIdempotencyIdentity(identity);
    if (typeof json !== 'string' || json.length > 65_536) throw new RangeError('idempotency JSON exceeds 64 KiB');
    const canonical = encodeIdempotencyValue(JSON.parse(json));
    return this.db.query(`UPDATE typehtml_idempotency SET state = 'complete', outcome_json = ?
      WHERE scope = ? AND request_key = ? AND input_digest = ? AND token = ? AND state = 'pending'`)
      .run(canonical, identity.scope, identity.key, identity.inputDigest, token).changes === 1;
  }

  markUnknown(identity: IdempotencyIdentity, token: string, signal?: AbortSignal): boolean {
    signal?.throwIfAborted(); assertIdempotencyIdentity(identity);
    return this.db.query(`UPDATE typehtml_idempotency SET state = 'unknown'
      WHERE scope = ? AND request_key = ? AND input_digest = ? AND token = ? AND state = 'pending'`)
      .run(identity.scope, identity.key, identity.inputDigest, token).changes === 1;
  }

  /**
   * Same-database atomic alternative: business writes and the cached outcome commit together.
   * authorize and execute MUST be synchronous, and execute MUST only affect this SQLite transaction.
   * External effects cannot be rolled back by SQLite; use an outbox for those effects.
   */
  executeAtomic<T extends IdempotencyJson>(options: IdempotencyIdentity & Readonly<{
    authorize: (db: Database) => boolean;
    execute: (db: Database) => T;
    signal?: AbortSignal;
    ttlMs?: number;
    now?: () => number;
    newToken?: () => string;
  }>): Readonly<{ value: T; replayed: boolean }> {
    const identity = Object.freeze({ scope: options.scope, key: options.key, inputDigest: options.inputDigest });
    assertIdempotencyIdentity(identity);
    const { signal, authorize, execute } = options;
    const clock = options.now ?? Date.now;
    const newToken = options.newToken ?? createIdempotencyKey;
    const ttl = options.ttlMs ?? 86_400_000;
    signal?.throwIfAborted();
    if (isDeclaredAsync(execute) || isDeclaredAsync(authorize)) throw new TypeError('executeAtomic callbacks must be synchronous');
    return this.db.transaction(() => {
      signal?.throwIfAborted();
      // The permission read shares the write transaction's current snapshot and lock, including replay.
      if (Reflect.apply(authorize, options, [this.db]) !== true) throw new IdempotencyError(403, 'IDEMPOTENCY_FORBIDDEN');
      signal?.throwIfAborted();
      const token = newToken();
      if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new RangeError('invalid idempotency TTL');
      const now = clock();
      const claim = { ...identity, token, now, expiresAt: now + ttl };
      assertIdempotencyClaim(claim);
      const result = this.claimInsideTransaction(claim);
      if (result.status === 'replay') {
        signal?.throwIfAborted();
        let value: T;
        try {
          if (result.json.length > 65_536) throw new RangeError('idempotency JSON exceeds 64 KiB');
          value = JSON.parse(result.json) as T;
          encodeIdempotencyValue(value);
        } catch (cause) { throw new IdempotencyError(503, 'IDEMPOTENCY_CORRUPT_RESULT', { cause }); }
        signal?.throwIfAborted();
        return Object.freeze({ value, replayed: true });
      }
      if (result.status === 'expired') throw new IdempotencyError(410, 'IDEMPOTENCY_EXPIRED');
      if (result.status !== 'claimed') throw new IdempotencyError(409, `IDEMPOTENCY_${result.status.toUpperCase()}`);
      signal?.throwIfAborted();
      const value = Reflect.apply(execute, options, [this.db]) as T;
      const json = encodeIdempotencyValue(value);
      signal?.throwIfAborted();
      if (!this.complete(identity, token, json)) throw new IdempotencyError(503, 'IDEMPOTENCY_COMPLETION_UNCERTAIN');
      return Object.freeze({ value: JSON.parse(json) as T, replayed: false });
    }).immediate();
  }

  close(): void { this.db.close(); }
}
