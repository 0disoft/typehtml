import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { SqliteOrderStore } from '../../src/adapter/sqlite/order-store.ts';
import { SqliteSessionStore } from '../../src/adapter/sqlite/session-store.ts';

const hash = 'a'.repeat(64);
const oldCandidates = `SELECT i.id FROM form_intents AS i
  LEFT JOIN action_results AS r ON r.intent_id = i.id
  LEFT JOIN order_drafts AS d ON d.intent_id = i.id
  WHERE (i.consumed_at IS NULL AND r.intent_id IS NULL AND d.id IS NULL AND i.expires_at <= ?)
    OR (i.consumed_at IS NOT NULL AND r.intent_id IS NOT NULL AND d.id = r.draft_id
      AND r.behavior_hash = i.behavior_hash AND r.completed_at = i.consumed_at
      AND d.tenant_id = i.tenant_id AND d.subject_id = i.subject_id
      AND d.product_id = i.product_id AND d.product_revision = i.resource_revision
      AND r.expires_at <= ?)
  ORDER BY i.issued_at LIMIT ?`;

async function withDatabase(work: (filename: string) => Promise<void>): Promise<void> {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'typehtml-maintenance-'));
  try { await work(join(directory, 'maintenance.sqlite')); }
  finally {
    const target = await realpath(directory);
    if (resolve(dirname(target)) !== resolve(parent) || !basename(target).startsWith('typehtml-maintenance-')) {
      throw new Error('refusing cleanup outside the maintenance fixture');
    }
    await rm(target, { recursive: true, force: true });
  }
}

function insertIntent(db: Database, id: string, issuedAt: number, expiresAt: number, consumedAt: number | null = null): void {
  db.query(`INSERT INTO form_intents VALUES (?, 'tenant', 'subject', 'action', 'product', 1, ?, ?, ?, ?)`)
    .run(id, hash, issuedAt, expiresAt, consumedAt);
}

function insertDraft(db: Database, intentId: string): void {
  db.query(`INSERT INTO order_drafts VALUES (?, ?, 'tenant', 'subject', 'product', 1, 1, 1, 'KRW', 'draft')`)
    .run(`draft_${intentId}`, intentId);
}

function insertResult(db: Database, intentId: string, completedAt: number, expiresAt: number): void {
  db.query('INSERT INTO action_results VALUES (?, ?, ?, ?, ?, ?)')
    .run(intentId, hash, hash, `draft_${intentId}`, completedAt, expiresAt);
}

function seedOwner(store: SqliteOrderStore): void {
  store.seedMembership('tenant', 'subject');
  store.seedProduct({ tenantId: 'tenant', id: 'product', name: 'Product', revision: 1, active: true, priceMinor: 1, currency: 'KRW' });
}

function countSessions(db: Database): number {
  return (db.query('SELECT COUNT(*) AS count FROM auth_sessions').get() as { count: number }).count;
}

describe('bounded SQLite maintenance', () => {
  it('upgrades old databases and uses expiry ranges when old live rows precede expired work', async () => {
    await withDatabase(async (filename) => {
      let store = new SqliteOrderStore(filename);
      const raw = new Database(filename, { strict: true });
      try {
        seedOwner(store);
        raw.exec('DROP INDEX form_intents_issued; DROP INDEX form_intents_open_expiry');
        raw.transaction(() => {
          for (let i = 0; i < 1000; i++) insertIntent(raw, `live_${i}`, 0, 1000);
          for (let i = 0; i < 10; i++) insertIntent(raw, `expired_${i}`, i + 1, 100);
        }).immediate();
        store.close();
        store = new SqliteOrderStore(filename);
        const expected = raw.query(oldCandidates).all(100, 100, 5) as { id: string }[];
        const observed = spyOn(Database.prototype, 'query');
        let sql: string[];
        try {
          expect(await store.cleanupExpired(100, 5)).toBe(5);
          sql = observed.mock.calls.map(([query]) => query);
        } finally { observed.mockRestore(); }
        for (const { id } of expected) expect(raw.query('SELECT 1 FROM form_intents WHERE id = ?').get(id)).toBeNull();
        expect(store.countIntents()).toBe(1005);
        const probe = sql.find((query) => query.includes('SELECT rowid AS row_order'))!;
        const fallback = sql.find((query) => query.includes('UNION ALL'))!;
        expect(probe).toBeDefined();
        expect(fallback).toBeDefined();
        const probePlan = raw.query(`EXPLAIN QUERY PLAN ${probe}`).all(5, 100, 100) as { detail: string }[];
        expect(probePlan.map(({ detail }) => detail).join('\n')).toContain('USING INDEX form_intents_issued');
        const fallbackPlan = raw.query(`EXPLAIN QUERY PLAN ${fallback}`).all(100, 100, 5) as { detail: string }[];
        const details = fallbackPlan.map(({ detail }) => detail).join('\n');
        expect(details).toContain('SEARCH i USING INDEX form_intents_open_expiry (expires_at<?)');
        expect(details).toContain('SEARCH r USING INDEX action_results_expiry (expires_at<?)');
        expect(await store.cleanupExpired(99)).toBe(0);
      } finally { raw.close(); store.close(); }
    });
  });

  it('deletes the earliest dense-expiry batch without scanning the full expiry ranges, retaining issued-at ties', async () => {
    await withDatabase(async (filename) => {
      const store = new SqliteOrderStore(filename);
      const raw = new Database(filename, { strict: true });
      try {
        seedOwner(store);
        raw.transaction(() => {
          for (let i = 0; i < 1000; i++) insertIntent(raw, `expired_${i}`, Math.floor(i / 3), 2000);
        }).immediate();
        const expected = raw.query(oldCandidates).all(2000, 2000, 100) as { id: string }[];
        const observed = spyOn(Database.prototype, 'query');
        try {
          expect(await store.cleanupExpired(2000)).toBe(100);
          expect(observed.mock.calls.some(([query]) => query.includes('UNION ALL'))).toBe(false);
        } finally { observed.mockRestore(); }
        for (const { id } of expected) expect(raw.query('SELECT 1 FROM form_intents WHERE id = ?').get(id)).toBeNull();
        expect(store.countIntents()).toBe(900);
      } finally { raw.close(); store.close(); }
    });
  });

  it('merges OPEN and completed expiry in original order while preserving live work and corrupt evidence', async () => {
    await withDatabase(async (filename) => {
      const store = new SqliteOrderStore(filename);
      const raw = new Database(filename, { strict: true });
      try {
        seedOwner(store);
        insertIntent(raw, 'open_expired', -10, 50);
        insertIntent(raw, 'open_edge', 1, 100);
        insertIntent(raw, 'open_live', 2, 101);
        for (const [id, issuedAt, resultExpiry, completedAt] of [
          ['completed', -10, 100, 30], ['result_live', -20, 101, 30], ['corrupt', -30, 100, 31],
        ] as const) {
          insertIntent(raw, id, issuedAt, 40, 30);
          insertDraft(raw, id);
          insertResult(raw, id, completedAt, resultExpiry);
        }
        insertIntent(raw, 'open_with_draft', -40, 50);
        insertDraft(raw, 'open_with_draft');
        insertIntent(raw, 'consumed_without_result', -50, 50, 30);
        const expected = raw.query(oldCandidates).all(100, 100, 2) as { id: string }[];
        expect(expected.map(({ id }) => id)).toEqual(['open_expired', 'completed']);
        expect(await store.cleanupExpired(100, 2)).toBe(2);
        for (const { id } of expected) expect(raw.query('SELECT 1 FROM form_intents WHERE id = ?').get(id)).toBeNull();
        expect(raw.query('SELECT 1 FROM order_drafts WHERE intent_id = ?').get('completed')).not.toBeNull();
        expect(raw.query('SELECT 1 FROM action_results WHERE intent_id = ?').get('completed')).toBeNull();
        expect(await store.cleanupExpired(100)).toBe(1);
        expect((raw.query('SELECT id FROM form_intents ORDER BY id').all() as { id: string }[]).map(({ id }) => id))
          .toEqual(['consumed_without_result', 'corrupt', 'open_live', 'open_with_draft', 'result_live']);
      } finally { raw.close(); store.close(); }
    });
  });

  it('limits the default session prune to 100 expired rows and honors exact expiry and explicit batch sizes', async () => {
    await withDatabase(async (filename) => {
      let now = 0;
      const sessions = new SqliteSessionStore(filename, { ttlSeconds: 1, now: () => now });
      const raw = new Database(filename, { strict: true });
      try {
        for (let i = 0; i < 105; i++) sessions.create({ tenantId: 'tenant', subjectId: 'subject', sessionId: '' });
        now = 999;
        expect(sessions.pruneExpired()).toBe(0);
        now = 1000;
        expect(sessions.pruneExpired()).toBe(100);
        expect(countSessions(raw)).toBe(5);
        expect(sessions.pruneExpired(2)).toBe(2);
        expect(countSessions(raw)).toBe(3);
        for (const limit of [0, -1, 1.5, NaN, Infinity, 1001]) expect(() => sessions.pruneExpired(limit)).toThrow(RangeError);
        expect(countSessions(raw)).toBe(3);
        expect(sessions.pruneExpired()).toBe(3);
      } finally { raw.close(); sessions.close(); }
    });
  });

  it('drains a fixed expiry cutoff in separate batches while yielding with no writer lock held', async () => {
    await withDatabase(async (filename) => {
      let now = 0;
      const sessions = new SqliteSessionStore(filename, { ttlSeconds: 1, now: () => now });
      const raw = new Database(filename, { strict: true });
      try {
        for (let i = 0; i < 5; i++) sessions.create({ tenantId: 'tenant', subjectId: 'subject', sessionId: '' });
        now = 1000;
        sessions.create({ tenantId: 'tenant', subjectId: 'later', sessionId: '' });
        let yields = 0;
        expect(await sessions.pruneExpiredAsync({ batchSize: 2, yield: async () => {
          yields++;
          now = 3000;
          raw.exec('BEGIN IMMEDIATE');
          raw.exec('ROLLBACK');
        } })).toBe(5);
        expect(yields).toBe(2);
        expect(countSessions(raw)).toBe(1);
        expect(sessions.pruneExpired()).toBe(1);
      } finally { raw.close(); sessions.close(); }
    });
  });

  it('propagates cancellation and yield failures after committing only completed batches', async () => {
    await withDatabase(async (filename) => {
      let now = 0;
      const sessions = new SqliteSessionStore(filename, { ttlSeconds: 1, now: () => now });
      const raw = new Database(filename, { strict: true });
      try {
        for (let i = 0; i < 5; i++) sessions.create({ tenantId: 'tenant', subjectId: 'subject', sessionId: '' });
        now = 1000;
        const reason = new Error('maintenance cancelled');
        const alreadyAborted = AbortSignal.abort(reason);
        await expect(sessions.pruneExpiredAsync({ signal: alreadyAborted })).rejects.toBe(reason);
        expect(countSessions(raw)).toBe(5);
        const controller = new AbortController();
        await expect(sessions.pruneExpiredAsync({ batchSize: 2, signal: controller.signal, yield: async (signal) => {
          expect(signal).toBe(controller.signal);
          controller.abort(reason);
        } })).rejects.toBe(reason);
        expect(countSessions(raw)).toBe(3);
        const failure = new Error('yield failed');
        await expect(sessions.pruneExpiredAsync({ batchSize: 1, yield: async () => { throw failure; } })).rejects.toBe(failure);
        expect(countSessions(raw)).toBe(2);
        let eventLoopRan = false;
        setImmediate(() => { eventLoopRan = true; });
        expect(await sessions.pruneExpiredAsync({ batchSize: 1 })).toBe(2);
        expect(eventLoopRan).toBe(true);
        expect(countSessions(raw)).toBe(0);
      } finally { raw.close(); sessions.close(); }
    });
  });
});
