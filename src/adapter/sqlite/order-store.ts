import { Database } from 'bun:sqlite';
import type { OrderInput, Principal, Product, Draft } from '../../runtime/order.ts';
import type { Grant } from '../../runtime/order-bindings.ts';
import type {
  OrderReadTx,
  OrderStorage,
  OrderWriteTx,
  StoredIntent,
  StoredResult,
} from '../../runtime/order-storage.ts';

export class StoreBusyError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('SQLITE_BUSY');
    this.name = 'StoreBusyError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class StoreCommitError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreCommitError';
  }
}

export type OrderStoreOptions = Readonly<{
  busyRetryBudgetMs?: number;
  retryAfterSeconds?: number;
  busyMaxWaitMs?: number;
  now?: () => number;
}>;

const DEFAULT_BUSY_RETRY_BUDGET_MS = 5_000;
const DEFAULT_BUSY_MAX_WAIT_MS = 50;
const DEFAULT_RETRY_AFTER_SECONDS = 1;

type MembershipRow = { tenant_id: string; subject_id: string; active: number };
type ProductRow = {
  id: string;
  tenant_id: string;
  name: string;
  revision: number;
  active: number;
  price_minor: number;
  currency: 'KRW';
};
type IntentRow = {
  id: string;
  tenant_id: string;
  subject_id: string;
  action_id: string;
  product_id: string;
  resource_revision: number;
  behavior_hash: string;
  issued_at: number;
  expires_at: number;
  consumed_at: number | null;
};
type ResultRow = {
  intent_id: string;
  draft_id: string;
  behavior_hash: string;
  input_hash: string;
  completed_at: number;
  expires_at: number;
};
type DraftRow = {
  id: string;
  intent_id: string;
  tenant_id: string;
  subject_id: string;
  product_id: string;
  product_revision: number;
  quantity: number;
  total_minor: number;
  currency: 'KRW';
  state: 'draft';
};

function mapProduct(row: ProductRow): Product {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    revision: row.revision,
    active: row.active === 1,
    priceMinor: row.price_minor,
    currency: row.currency,
  };
}

function mapIntent(row: IntentRow): StoredIntent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    actionId: row.action_id,
    productId: row.product_id,
    resourceRevision: row.resource_revision,
    behaviorHash: row.behavior_hash,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

function mapResult(row: ResultRow): StoredResult {
  return {
    intentId: row.intent_id,
    draftId: row.draft_id,
    behaviorHash: row.behavior_hash,
    inputHash: row.input_hash,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

function mapDraft(row: DraftRow): Draft {
  return {
    orderId: row.id,
    intentId: row.intent_id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    productId: row.product_id,
    productRevision: row.product_revision,
    quantity: row.quantity,
    totalMinor: row.total_minor,
    currency: row.currency,
    state: row.state,
  };
}

function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || /SQLITE_BUSY/.test(error.message);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memberships (
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  PRIMARY KEY (tenant_id, subject_id)
) STRICT;

CREATE TABLE IF NOT EXISTS products (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  currency TEXT NOT NULL CHECK (currency = 'KRW'),
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS form_intents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  resource_revision INTEGER NOT NULL,
  behavior_hash TEXT NOT NULL CHECK (length(behavior_hash) = 64),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  consumed_at INTEGER,
  FOREIGN KEY (tenant_id, subject_id) REFERENCES memberships (tenant_id, subject_id)
) STRICT;

CREATE TABLE IF NOT EXISTS order_drafts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_revision INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  currency TEXT NOT NULL CHECK (currency = 'KRW'),
  state TEXT NOT NULL CHECK (state = 'draft'),
  UNIQUE (id, intent_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, subject_id) REFERENCES memberships (tenant_id, subject_id)
) STRICT;

CREATE TABLE IF NOT EXISTS action_results (
  intent_id TEXT PRIMARY KEY,
  behavior_hash TEXT NOT NULL CHECK (length(behavior_hash) = 64),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  draft_id TEXT NOT NULL UNIQUE,
  completed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > completed_at),
  FOREIGN KEY (intent_id) REFERENCES form_intents (id) ON DELETE CASCADE,
  FOREIGN KEY (draft_id, intent_id) REFERENCES order_drafts (id, intent_id)
) STRICT;

CREATE TABLE IF NOT EXISTS boundary_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (intent_id, action_id, outcome)
) STRICT;

CREATE INDEX IF NOT EXISTS form_intents_owner
  ON form_intents (tenant_id, subject_id, id);
CREATE INDEX IF NOT EXISTS action_results_expiry
  ON action_results (expires_at);
`;

class SqliteReadTx implements OrderReadTx {
  protected readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  currentMember(tenantId: string, subjectId: string): boolean {
    const row = this.db
      .query('SELECT 1 AS present FROM memberships WHERE tenant_id = ? AND subject_id = ? AND active = 1')
      .get(tenantId, subjectId) as { present: number } | null;
    return row !== null;
  }

  loadProduct(tenantId: string, productId: string): Product | null {
    const row = this.db
      .query(
        `SELECT id, tenant_id, name, revision, active, price_minor, currency
           FROM products WHERE tenant_id = ? AND id = ?`,
      )
      .get(tenantId, productId) as ProductRow | null;
    return row === null ? null : mapProduct(row);
  }

  loadIntent(
    tenantId: string,
    subjectId: string,
    actionId: string,
    intentId: string,
  ): StoredIntent | null {
    const row = this.db
      .query(
        `SELECT id, tenant_id, subject_id, action_id, product_id, resource_revision,
                behavior_hash, issued_at, expires_at, consumed_at
           FROM form_intents
          WHERE tenant_id = ? AND subject_id = ? AND action_id = ? AND id = ?`,
      )
      .get(tenantId, subjectId, actionId, intentId) as IntentRow | null;
    return row === null ? null : mapIntent(row);
  }

  loadResult(intentId: string): StoredResult | null {
    const row = this.db
      .query(
        `SELECT intent_id, draft_id, behavior_hash, input_hash, completed_at, expires_at
           FROM action_results WHERE intent_id = ?`,
      )
      .get(intentId) as ResultRow | null;
    return row === null ? null : mapResult(row);
  }

  readDraft(tenantId: string, orderId: string): Draft | null {
    const row = this.db
      .query(
        `SELECT id, intent_id, tenant_id, subject_id, product_id, product_revision,
                quantity, total_minor, currency, state
           FROM order_drafts WHERE tenant_id = ? AND id = ?`,
      )
      .get(tenantId, orderId) as DraftRow | null;
    return row === null ? null : mapDraft(row);
  }

  readDraftByIntent(intentId: string): Draft | null {
    const row = this.db
      .query(
        `SELECT id, intent_id, tenant_id, subject_id, product_id, product_revision,
                quantity, total_minor, currency, state
           FROM order_drafts WHERE intent_id = ?`,
      )
      .get(intentId) as DraftRow | null;
    return row === null ? null : mapDraft(row);
  }
}

class SqliteWriteTx extends SqliteReadTx implements OrderWriteTx {
  insertIntent(intent: StoredIntent): void {
    this.db
      .query(
        `INSERT INTO form_intents
           (id, tenant_id, subject_id, action_id, product_id, resource_revision,
            behavior_hash, issued_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        intent.id,
        intent.tenantId,
        intent.subjectId,
        intent.actionId,
        intent.productId,
        intent.resourceRevision,
        intent.behaviorHash,
        intent.issuedAt,
        intent.expiresAt,
        intent.consumedAt,
      );
  }

  insertDraftIfRevision(args: Readonly<{
    principal: Principal;
    input: OrderInput;
    product: Product;
    grant: Grant;
    now: number;
  }>): Draft | null {
    const { principal, input, product, grant } = args;
    const orderId = grant.draftId;
    const result = this.db
      .query(
        `INSERT INTO order_drafts
           (id, intent_id, tenant_id, subject_id, product_id, product_revision,
            quantity, total_minor, currency, state)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'KRW', 'draft'
           FROM form_intents AS fi
           JOIN products AS p
             ON p.tenant_id = fi.tenant_id AND p.id = fi.product_id
           JOIN memberships AS m
             ON m.tenant_id = fi.tenant_id AND m.subject_id = fi.subject_id
          WHERE fi.id = ?
            AND fi.tenant_id = ?
            AND fi.subject_id = ?
            AND fi.action_id = ?
            AND fi.product_id = ?
            AND fi.behavior_hash = ?
            AND fi.issued_at <= ?
            AND fi.expires_at > ?
            AND fi.consumed_at IS NULL
            AND fi.resource_revision = ?
            AND p.revision = ?
            AND p.active = 1
            AND m.active = 1
            AND ? BETWEEN 1 AND 20`,
      )
      .run(
        orderId,
        grant.intentId,
        principal.tenantId,
        principal.subjectId,
        input.productId,
        product.revision,
        input.quantity,
        input.quantity * product.priceMinor,
        grant.intentId,
        principal.tenantId,
        principal.subjectId,
        grant.actionId,
        input.productId,
        grant.behaviorSha256,
        args.now,
        args.now,
        product.revision,
        product.revision,
        input.quantity,
      );
    if (result.changes !== 1) return null;
    return this.readDraftByIntent(grant.intentId);
  }

  consumeIntent(args: Readonly<{
    intentId: string;
    principal: Principal;
    behaviorHash: string;
    now: number;
  }>): boolean {
    const result = this.db
      .query(
        `UPDATE form_intents
            SET consumed_at = ?
          WHERE id = ?
            AND tenant_id = ?
            AND subject_id = ?
            AND behavior_hash = ?
            AND consumed_at IS NULL
            AND expires_at > ?`,
      )
      .run(
        args.now,
        args.intentId,
        args.principal.tenantId,
        args.principal.subjectId,
        args.behaviorHash,
        args.now,
      );
    return result.changes === 1;
  }

  insertResult(result: StoredResult): void {
    this.db
      .query(
        `INSERT INTO action_results
           (intent_id, behavior_hash, input_hash, draft_id, completed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.intentId,
        result.behaviorHash,
        result.inputHash,
        result.draftId,
        result.completedAt,
        result.expiresAt,
      );
  }

  insertAudit(args: Readonly<{
    intentId: string;
    actionId: string;
    outcome: string;
    createdAt: number;
  }>): void {
    this.db
      .query(
        `INSERT INTO boundary_audit (intent_id, action_id, outcome, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(args.intentId, args.actionId, args.outcome, args.createdAt);
  }
}

export type AuditFinding = Readonly<{
  intentId: string;
  reason:
    | 'OPEN_WITH_DURABLE_WORK'
    | 'CONSUMED_WITHOUT_RESULT'
    | 'RESULT_METADATA_MISMATCH'
    | 'DRAFT_SCOPE_MISMATCH';
}>;

export class SqliteOrderStore implements OrderStorage {
  private readonly db: Database;
  private readonly busyRetryBudgetMs: number;
  private readonly retryAfterSeconds: number;
  private readonly busyMaxWaitMs: number;
  readonly now: () => number;

  constructor(filename: string, options: OrderStoreOptions = {}) {
    this.db = new Database(filename, { create: true, strict: true, readwrite: true });
    this.busyRetryBudgetMs = options.busyRetryBudgetMs ?? DEFAULT_BUSY_RETRY_BUDGET_MS;
    this.retryAfterSeconds = options.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
    this.busyMaxWaitMs = options.busyMaxWaitMs ?? DEFAULT_BUSY_MAX_WAIT_MS;
    this.now = options.now ?? Date.now;
    this.configure();
    this.migrate();
  }

  private configure(): void {
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 0');
    if (this.db.filename !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');

    const foreignKeys = this.db.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
    if (foreignKeys.foreign_keys !== 1) throw new Error('SQLITE_PRAGMA_FOREIGN_KEYS');
    const busyTimeout = this.db.query('PRAGMA busy_timeout').get() as { timeout: number };
    if (busyTimeout.timeout !== 0) throw new Error('SQLITE_PRAGMA_BUSY_TIMEOUT');
    const synchronous = this.db.query('PRAGMA synchronous').get() as { synchronous: number };
    if (synchronous.synchronous !== 2) throw new Error('SQLITE_PRAGMA_SYNCHRONOUS');
    if (this.db.filename !== ':memory:') {
      const journal = this.db.query('PRAGMA journal_mode').get() as { journal_mode: string };
      if (journal.journal_mode !== 'wal') throw new Error('SQLITE_PRAGMA_JOURNAL_MODE');
    }
  }

  private migrate(): void {
    this.db.exec(SCHEMA);
  }

  read<T>(work: (tx: OrderReadTx) => T): T {
    this.db.exec('BEGIN');
    try {
      const value = work(new SqliteReadTx(this.db));
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  async immediate<T>(work: (tx: OrderWriteTx) => T): Promise<T> {
    const deadline = this.now() + this.busyRetryBudgetMs;
    while (true) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        break;
      } catch (error) {
        if (!isBusyError(error) || this.now() >= deadline) {
          if (isBusyError(error)) throw new StoreBusyError(this.retryAfterSeconds);
          throw error;
        }
        await Bun.sleep(Math.min(this.busyMaxWaitMs, Math.max(1, deadline - this.now())));
      }
    }
    try {
      const value = work(new SqliteWriteTx(this.db));
      try {
        this.db.exec('COMMIT');
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // Preserve the commit failure.
        }
        if (isBusyError(error)) throw new StoreBusyError(this.retryAfterSeconds);
        throw new StoreCommitError('SQLITE_COMMIT_FAILED', { cause: error });
      }
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  seedMembership(tenantId: string, subjectId: string, active = true): void {
    this.db
      .query(
        `INSERT INTO memberships (tenant_id, subject_id, active) VALUES (?, ?, ?)
         ON CONFLICT (tenant_id, subject_id) DO UPDATE SET active = excluded.active`,
      )
      .run(tenantId, subjectId, active ? 1 : 0);
  }

  seedProduct(product: Product): void {
    this.db
      .query(
        `INSERT INTO products (tenant_id, id, name, revision, active, price_minor, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           name = excluded.name,
           revision = excluded.revision,
           active = excluded.active,
           price_minor = excluded.price_minor,
           currency = excluded.currency`,
      )
      .run(
        product.tenantId,
        product.id,
        product.name,
        product.revision,
        product.active ? 1 : 0,
        product.priceMinor,
        product.currency,
      );
  }

  countIntents(): number {
    const row = this.db.query('SELECT COUNT(*) AS count FROM form_intents').get() as { count: number };
    return row.count;
  }

  countAudit(): number {
    const row = this.db.query('SELECT COUNT(*) AS count FROM boundary_audit').get() as { count: number };
    return row.count;
  }

  setProductRevision(tenantId: string, productId: string, revision: number, priceMinor: number): void {
    this.db
      .query('UPDATE products SET revision = ?, price_minor = ? WHERE tenant_id = ? AND id = ?')
      .run(revision, priceMinor, tenantId, productId);
  }

  /** Bounded normal-retention cleanup. Inconsistent lifecycle rows are preserved. */
  async cleanupExpired(now = this.now(), limit = 100): Promise<number> {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.immediate(() => {
      const result = this.db
        .query(
          `DELETE FROM form_intents
            WHERE id IN (
              SELECT i.id FROM form_intents AS i
              LEFT JOIN action_results AS r ON r.intent_id = i.id
              LEFT JOIN order_drafts AS d ON d.intent_id = i.id
              WHERE (i.consumed_at IS NULL AND r.intent_id IS NULL AND d.id IS NULL
                     AND i.expires_at <= ?)
                 OR (i.consumed_at IS NOT NULL AND r.intent_id IS NOT NULL AND d.id = r.draft_id
                     AND r.behavior_hash = i.behavior_hash AND r.completed_at = i.consumed_at
                     AND d.tenant_id = i.tenant_id AND d.subject_id = i.subject_id
                     AND d.product_id = i.product_id AND r.expires_at <= ?)
              ORDER BY i.issued_at LIMIT ?
            )`,
        )
        .run(now, now, bounded);
      return result.changes;
    });
  }

  /** Operator-only diagnostic; never surface these reasons in an unauthenticated response. */
  auditInconsistencies(limit = 100): readonly AuditFinding[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.read(() =>
      this.db
        .query(
          `SELECT intent_id, reason FROM (
             SELECT i.id AS intent_id,
               CASE
                 WHEN i.consumed_at IS NULL AND (r.intent_id IS NOT NULL OR d.id IS NOT NULL)
                   THEN 'OPEN_WITH_DURABLE_WORK'
                 WHEN i.consumed_at IS NOT NULL AND (r.intent_id IS NULL OR d.id IS NULL)
                   THEN 'CONSUMED_WITHOUT_RESULT'
                 WHEN r.intent_id IS NOT NULL AND (r.draft_id IS NOT d.id
                   OR r.behavior_hash IS NOT i.behavior_hash OR r.completed_at IS NOT i.consumed_at)
                   THEN 'RESULT_METADATA_MISMATCH'
                 WHEN d.id IS NOT NULL AND (d.tenant_id IS NOT i.tenant_id
                   OR d.subject_id IS NOT i.subject_id OR d.product_id IS NOT i.product_id)
                   THEN 'DRAFT_SCOPE_MISMATCH'
               END AS reason,
               i.issued_at
             FROM form_intents AS i
             LEFT JOIN action_results AS r ON r.intent_id = i.id
             LEFT JOIN order_drafts AS d ON d.intent_id = i.id
           ) WHERE reason IS NOT NULL ORDER BY issued_at LIMIT ?`,
        )
        .all(bounded) as { intent_id: string; reason: AuditFinding['reason'] }[],
    ).map((row) => ({ intentId: row.intent_id, reason: row.reason }));
  }

  close(): void {
    this.db.close();
  }
}
