import { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { Principal } from '../../runtime/order.ts';
import type { Session, SessionStore, CredentialStore } from '../../runtime/session.ts';

type SessionRow = {
  token_hash: string;
  subject_id: string;
  tenant_id: string;
  csrf_token: string;
  expires_at: number;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function token(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url');
}

/** Transfer connection ownership only after all authentication-store setup succeeds. */
function openAuthDatabase(filename: string, initialize: (db: Database) => void): Database {
  const db = new Database(filename, { strict: true });
  let initialized = false;
  try {
    initialize(db);
    initialized = true;
    return db;
  } finally {
    if (!initialized) db.close(true);
  }
}

export type SqliteSessionStoreOptions = Readonly<{
  ttlSeconds?: number;
  now?: () => number;
}>;

export type SessionPruneOptions = Readonly<{
  batchSize?: number;
  signal?: AbortSignal;
  yield?: (signal?: AbortSignal) => Promise<void>;
}>;

const DEFAULT_PRUNE_BATCH_SIZE = 100;
const MAX_PRUNE_BATCH_SIZE = 1000;

function pruneBatchSize(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PRUNE_BATCH_SIZE) {
    throw new RangeError(`session prune batch size must be an integer from 1 to ${MAX_PRUNE_BATCH_SIZE}`);
  }
  return limit;
}

export class SqliteSessionStore implements SessionStore {
  private readonly db: Database;
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  constructor(filename: string, options: SqliteSessionStoreOptions = {}) {
    this.ttlSeconds = options.ttlSeconds ?? 8 * 60 * 60;
    if (!Number.isSafeInteger(this.ttlSeconds) || this.ttlSeconds < 1) throw new Error('INVALID_SESSION_TTL');
    this.now = options.now ?? Date.now;
    this.db = openAuthDatabase(filename, (db) => {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA busy_timeout = 1000');
      if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
      db.exec(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        csrf_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
      `);
    });
  }

  get(id: string): Session | null {
    if (id.length === 0) return null;
    const row = this.db
      .query('SELECT token_hash, subject_id, tenant_id, csrf_token, expires_at FROM auth_sessions WHERE token_hash = ? AND expires_at > ?')
      .get(hashToken(id), this.now()) as SessionRow | null;
    if (row === null) return null;
    return {
      id,
      principal: { tenantId: row.tenant_id, subjectId: row.subject_id, sessionId: id },
      csrfToken: row.csrf_token,
    };
  }

  create(principal: Principal): Session {
    const id = token('sess_');
    const csrfToken = token('csrf_');
    const createdAt = this.now();
    this.db
      .query('INSERT INTO auth_sessions (token_hash, subject_id, tenant_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hashToken(id), principal.subjectId, principal.tenantId, csrfToken, createdAt, createdAt + this.ttlSeconds * 1000);
    return { id, principal: { ...principal, sessionId: id }, csrfToken };
  }

  rotate(id: string): Session | null {
    return this.db.transaction(() => {
      const current = this.get(id);
      if (current === null) return null;
      this.db.query('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(id));
      return this.create(current.principal);
    }).immediate();
  }

  revoke(id: string): void {
    this.db.query('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(id));
  }

  /** Deletes one bounded batch; the returned count describes this batch only. */
  pruneExpired(limit = DEFAULT_PRUNE_BATCH_SIZE): number {
    return this.pruneExpiredAt(this.now(), pruneBatchSize(limit));
  }

  /** Drains the initial expiry cutoff while releasing the writer and event loop between batches. */
  async pruneExpiredAsync(options: SessionPruneOptions = {}): Promise<number> {
    const batchSize = pruneBatchSize(options.batchSize ?? DEFAULT_PRUNE_BATCH_SIZE);
    const { signal } = options;
    const yieldBatch = options.yield ?? ((abortSignal) => yieldToLoop(undefined, { signal: abortSignal }));
    signal?.throwIfAborted();
    const cutoff = this.now();
    let total = 0;
    for (;;) {
      signal?.throwIfAborted();
      const deleted = this.pruneExpiredAt(cutoff, batchSize);
      total += deleted;
      if (deleted < batchSize) return total;
      try {
        await yieldBatch(signal);
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
    }
  }

  private pruneExpiredAt(cutoff: number, limit: number): number {
    const result = this.db.query(`DELETE FROM auth_sessions WHERE token_hash IN (
      SELECT token_hash FROM auth_sessions WHERE expires_at <= ?
      ORDER BY expires_at, rowid LIMIT ?
    )`).run(cutoff, limit);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}

type CredentialRow = { password_hash: string };

export class SqliteCredentialStore implements CredentialStore {
  private readonly db: Database;

  constructor(filename: string) {
    this.db = openAuthDatabase(filename, (db) => {
      db.exec('PRAGMA busy_timeout = 1000');
      if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
      db.exec(`
      CREATE TABLE IF NOT EXISTS auth_credentials (
        tenant_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        PRIMARY KEY (tenant_id, subject_id)
      ) STRICT;
      `);
    });
  }

  async seed(tenantId: string, subjectId: string, password: string, active = true): Promise<void> {
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });
    this.db
      .query(`
        INSERT INTO auth_credentials (tenant_id, subject_id, password_hash, active)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (tenant_id, subject_id) DO UPDATE SET password_hash = excluded.password_hash, active = excluded.active
      `)
      .run(tenantId, subjectId, passwordHash, active ? 1 : 0);
  }

  async verify(tenantId: string, subjectId: string, password: string): Promise<Principal | null> {
    const row = this.db
      .query('SELECT password_hash FROM auth_credentials WHERE tenant_id = ? AND subject_id = ? AND active = 1')
      .get(tenantId, subjectId) as CredentialRow | null;
    if (row === null) return null;
    let matches = false;
    try {
      matches = await Bun.password.verify(password, row.password_hash);
    } catch {
      matches = false;
    }
    if (!matches) return null;
    const current = this.db
      .query('SELECT password_hash FROM auth_credentials WHERE tenant_id = ? AND subject_id = ? AND active = 1')
      .get(tenantId, subjectId) as CredentialRow | null;
    if (current === null || current.password_hash !== row.password_hash) return null;
    return { tenantId, subjectId, sessionId: '' };
  }

  close(): void {
    this.db.close();
  }
}
