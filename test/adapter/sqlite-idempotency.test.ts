import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteIdempotencyStore } from '../../src/adapter/sqlite/idempotency-store.ts';
import { executeIdempotent, idempotencyDigest, type IdempotencyClaim } from '../../src/form/idempotency.ts';

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function filename(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), 'typehtml-idempotency-')); temporary.push(directory); return join(directory, 'app.sqlite'); }
const claim: IdempotencyClaim = { scope: 'tenant/user/checkout', key: 'request_1234567890', inputDigest: idempotencyDigest({ q: 1 }), token: 'fence_12345678901', now: 100, expiresAt: 200 };

describe('durable generic SQLite idempotency', () => {
  it('shares atomic claims, fencing, replays and expiry tombstones across connections and restarts', async () => {
    const file = await filename(); const a = new SqliteIdempotencyStore(file); const b = new SqliteIdempotencyStore(file);
    try {
      expect(a.claim(claim)).toEqual({ status: 'claimed' });
      expect(b.claim({ ...claim, token: 'other_12345678901' })).toEqual({ status: 'busy' });
      expect(b.complete(claim, 'other_12345678901', '"wrong"')).toBe(false);
      expect(a.complete(claim, claim.token, '{"receipt":"r1"}')).toBe(true);
      expect(b.claim(claim)).toEqual({ status: 'replay', json: '{"receipt":"r1"}', expiresAt: 200 });
      expect(b.claim({ ...claim, inputDigest: idempotencyDigest({ q: 2 }) })).toEqual({ status: 'conflict' });
      expect(b.claim({ ...claim, now: 200, expiresAt: 300 })).toEqual({ status: 'expired' });
    } finally { a.close(); b.close(); }
    const reopened = new SqliteIdempotencyStore(file);
    try { expect(reopened.claim({ ...claim, now: 201, expiresAt: 300 })).toEqual({ status: 'expired' }); }
    finally { reopened.close(); }
  });

  it('persists uncertainty and never reexecutes a failed external effect', async () => {
    const file = await filename(); let effects = 0; const a = new SqliteIdempotencyStore(file);
    const options = { ...claim, store: a, authorize: () => true, now: () => 100, execute: () => { effects++; throw new Error('unknown external commit'); } };
    try { await expect(executeIdempotent(options)).rejects.toThrow('unknown external commit'); } finally { a.close(); }
    const b = new SqliteIdempotencyStore(file);
    try { await expect(executeIdempotent({ ...options, store: b })).rejects.toMatchObject({ code: 'IDEMPOTENCY_UNKNOWN' }); expect(effects).toBe(1); }
    finally { b.close(); }
  });

  it('rejects ill-formed UTF-16 scopes before SQLite replaces them with one UTF-8 identity', () => {
    const store = new SqliteIdempotencyStore(':memory:');
    try {
      expect(() => store.claim({ ...claim, scope: 'tenant\ud800' })).toThrow('scope');
      expect(() => store.claim({ ...claim, scope: 'tenant\ud801' })).toThrow('scope');
      expect(store.claim({ ...claim, scope: 'tenant/한/😀' }).status).toBe('claimed');
    } finally { store.close(); }
  });

  it('commits same-database business writes and replay records in one transaction', async () => {
    const file = await filename(); const store = new SqliteIdempotencyStore(file); let executions = 0; let authorizations = 0;
    const options = { ...claim, now: () => 100, authorize: () => { authorizations++; return true; }, execute: (db: import('bun:sqlite').Database) => {
      executions++; db.exec('CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY) STRICT');
      db.query('INSERT INTO receipts VALUES (?)').run('r1');
      return { receipt: 'r1' };
    } };
    try {
      expect(store.executeAtomic(options)).toEqual({ value: { receipt: 'r1' }, replayed: false });
      expect(store.executeAtomic(options)).toEqual({ value: { receipt: 'r1' }, replayed: true });
      expect(executions).toBe(1); expect(authorizations).toBe(2);
      expect(() => store.executeAtomic({ ...options, authorize: () => false })).toThrow('FORBIDDEN');
    } finally { store.close(); }
  });

  it('rolls back same-database effects and claims together on failure or cancellation', async () => {
    const store = new SqliteIdempotencyStore(await filename());
    let calls = 0;
    const options = { ...claim, now: () => 100, authorize: () => true, execute: (db: import('bun:sqlite').Database) => {
      calls++; db.exec('CREATE TABLE rolled_back (id INTEGER) STRICT'); throw new Error('rollback');
    } };
    try {
      expect(() => store.executeAtomic(options)).toThrow('rollback');
      const controller = new AbortController(); const reason = new Error('cancel');
      expect(() => store.executeAtomic({ ...options, signal: controller.signal, execute: (db) => { db.exec('CREATE TABLE rolled_back (id INTEGER) STRICT'); controller.abort(reason); return 'receipt'; } })).toThrow(reason);
      expect(store.executeAtomic({ ...options, execute: (db) => { db.exec('CREATE TABLE rolled_back (id INTEGER) STRICT'); return 'receipt'; } })).toEqual({ value: 'receipt', replayed: false });
      expect(calls).toBe(1);
    } finally { store.close(); }
  });

  it('rejects native async callbacks before they can start an unrollbackable continuation', async () => {
    const store = new SqliteIdempotencyStore(await filename()); let calls = 0;
    const options = { ...claim, now: () => 100, authorize: () => true, execute: () => 'receipt' };
    try {
      expect(() => store.executeAtomic({ ...options, execute: (async () => { calls++; await Promise.resolve(); return 'late'; }) as never })).toThrow('synchronous');
      expect(() => store.executeAtomic({ ...options, authorize: (async () => { calls++; return true; }) as never })).toThrow('synchronous');
      expect(() => store.executeAtomic({ ...options, execute: (async () => { calls++; await Promise.resolve(); return 'late'; }).bind(null) as never })).toThrow('synchronous');
      expect(() => store.executeAtomic({ ...options, authorize: (async () => { calls++; return true; }).bind(null) as never })).toThrow('synchronous');
      expect(calls).toBe(0);
      expect(store.executeAtomic(options).value).toBe('receipt');
    } finally { store.close(); }
  });

  it('checks current permissions inside the same immediate transaction on execution and replay', async () => {
    const file = await filename(); const store = new SqliteIdempotencyStore(file); const db = new Database(file, { strict: true });
    db.exec('CREATE TABLE permissions (allowed INTEGER NOT NULL) STRICT; INSERT INTO permissions VALUES (1); PRAGMA busy_timeout=0;');
    let transaction: Database | undefined; let executions = 0; let checks = 0;
    const options = { ...claim, now: () => 100, authorize: (current: Database) => {
      transaction = current; checks++;
      expect(current.inTransaction).toBe(true);
      expect(() => db.query('UPDATE permissions SET allowed = 0').run()).toThrow();
      return (current.query('SELECT allowed FROM permissions').get() as { allowed: number }).allowed === 1;
    }, execute: (current: Database) => {
      expect(current === transaction).toBe(true); expect(current.inTransaction).toBe(true); executions++; return 'receipt';
    } };
    try {
      expect(store.executeAtomic(options)).toEqual({ value: 'receipt', replayed: false });
      expect(store.executeAtomic(options)).toEqual({ value: 'receipt', replayed: true });
      db.query('UPDATE permissions SET allowed = 0').run();
      expect(() => store.executeAtomic(options)).toThrow('IDEMPOTENCY_FORBIDDEN');
      expect(executions).toBe(1); expect(checks).toBe(3);
    } finally { db.close(); store.close(); }
  });

  it('captures callback references and timing policy before authorization can mutate caller options', () => {
    const store = new SqliteIdempotencyStore(':memory:'); let executions = 0; let lateCalls = 0;
    const options = { ...claim, now: () => 100, ttlMs: 10, authorize: () => {
      options.execute = (async () => { lateCalls++; await Promise.resolve(); return 'late'; }) as never;
      options.now = () => 1000; options.ttlMs = 0;
      return true;
    }, execute: () => { executions++; return 'original'; } };
    try {
      expect(store.executeAtomic(options)).toEqual({ value: 'original', replayed: false });
      expect(executions).toBe(1); expect(lateCalls).toBe(0);
      expect(store.claim({ ...claim, now: 109, expiresAt: 200 })).toMatchObject({ status: 'replay', expiresAt: 110 });
    } finally { store.close(); }
  });

  it('rejects corrupt durable states and malformed cached outcomes without executing effects', async () => {
    const file = await filename(); const store = new SqliteIdempotencyStore(file); const db = new Database(file, { strict: true });
    const options = { ...claim, now: () => 100, authorize: () => true, execute: () => { throw new Error('must not execute'); } };
    try {
      store.claim(claim); store.complete(claim, claim.token, '"receipt"');
      db.query('UPDATE typehtml_idempotency SET outcome_json = ?').run('broken');
      expect(() => store.executeAtomic(options)).toThrow('IDEMPOTENCY_CORRUPT_RESULT');
      db.exec('PRAGMA ignore_check_constraints = ON');
      db.query('UPDATE typehtml_idempotency SET state = ?').run('alien');
      expect(() => store.claim(claim)).toThrow('IDEMPOTENCY_CORRUPT_RECORD');
    } finally { db.close(); store.close(); }
  });

  it('closes the database if constructor setup fails', async () => {
    let opened: Database | undefined;
    const original = Database.prototype.exec;
    const setup = spyOn(Database.prototype, 'exec').mockImplementation(function(this: Database, sql: string) {
      if (sql.includes('CREATE TABLE IF NOT EXISTS typehtml_idempotency')) { opened = this; throw new Error('setup failed'); }
      return Reflect.apply(original, this, [sql]);
    });
    try {
      expect(() => new SqliteIdempotencyStore(':memory:')).toThrow('setup failed');
      expect(opened).toBeDefined();
      expect(() => opened!.query('SELECT 1').get()).toThrow();
    } finally { setup.mockRestore(); }
  });
});
