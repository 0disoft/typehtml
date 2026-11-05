import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteOrderStore } from '../../src/adapter/sqlite/order-store.ts';
import type { OrderReadTx, OrderWriteTx } from '../../src/runtime/order-storage.ts';
import type { Grant, GrantScope, GrantIssuer } from '../../src/runtime/order-bindings.ts';
import { hashValidatedInput } from '../../src/runtime/input.ts';
import type { Principal, Product } from '../../src/runtime/order.ts';

const principal: Principal = { tenantId: 't', subjectId: 's', sessionId: 'session' };
const product: Product = { id: 'p', tenantId: 't', name: 'product', revision: 1, active: true, priceMinor: 1000, currency: 'KRW' };
const input = { productId: 'p', quantity: 2 };
const scope: GrantScope = {
  principal, resourceId: 'p', resourceRevision: 1, operation: 'orders.createDraft',
  draftId: 'draft_grant', actionId: 'orders.createDraft', intentId: 'intent_grant',
  behaviorSha256: 'b'.repeat(64), inputHash: hashValidatedInput(input),
};

describe('SQLite transaction boundaries', () => {
  it('rejects asynchronous callbacks and invalidates escaped read and write handles', async () => {
    const store = new SqliteOrderStore(':memory:');
    let read!: OrderReadTx;
    let write!: OrderWriteTx;
    expect(() => store.read((tx) => {
      read = tx;
      return Promise.resolve(1);
    })).toThrow('ASYNC_ROLE_RESULT');
    await expect(store.immediate((tx) => {
      write = tx;
      return Promise.resolve(1);
    })).rejects.toThrow('ASYNC_ROLE_RESULT');
    expect(() => read.currentMember('t', 's')).toThrow('TRANSACTION_CLOSED');
    expect(() => write.currentMember('t', 's')).toThrow('TRANSACTION_CLOSED');
    expect((write as unknown as { db?: unknown }).db).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(write, 'db')).toBeUndefined();
    expect(Object.getPrototypeOf(write)).toBeNull();
    expect(store.read((tx) => tx.currentMember('t', 's'))).toBe(false);
    await expect(store.immediate(() => 1)).resolves.toBe(1);
    store.close();
  });

  it('force-closes and quarantines connections when rollback leaves an active transaction', async () => {
    for (const operation of ['read', 'write'] as const) {
      const directory = await mkdtemp(join(tmpdir(), 'typehtml-rollback-'));
      const filename = join(directory, 'orders.sqlite');
      const store = new SqliteOrderStore(filename);
      store.seedMembership('t', 's');
      const originalExec = Database.prototype.exec;
      const rollbackFault = spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database, sql: string) {
        if (sql === 'ROLLBACK') throw new Error('injected rollback I/O failure');
        return originalExec.call(this, sql);
      });
      try {
        const fail = (tx: OrderReadTx) => {
          tx.currentMember('t', 's');
          throw new Error('original work failure');
        };
        if (operation === 'read') expect(() => store.read(fail)).toThrow('SQLITE_ROLLBACK_FAILED');
        else await expect(store.immediate(fail)).rejects.toThrow('SQLITE_ROLLBACK_FAILED');
        expect(() => store.read(() => 1)).toThrow('SQLITE_CONNECTION_QUARANTINED');
        const independent = new Database(filename, { strict: true });
        try {
          independent.exec('BEGIN IMMEDIATE');
          originalExec.call(independent, 'ROLLBACK');
        } finally { independent.close(); }
      } finally {
        rollbackFault.mockRestore();
        store.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it('accepts only frozen identity-registered, single-use grants from its active transaction', async () => {
    const store = new SqliteOrderStore(':memory:');
    store.seedMembership('t', 's');
    store.seedProduct(product);
    let escapedGrant!: Grant;
    let unusedGrant!: Grant;
    let escapedIssuer!: GrantIssuer;
    await store.immediate((tx, issueGrant) => {
      tx.insertIntent({
        id: scope.intentId, tenantId: 't', subjectId: 's', actionId: scope.actionId,
        productId: 'p', resourceRevision: 1, behaviorHash: scope.behaviorSha256,
        issuedAt: 100, expiresAt: 200, consumedAt: null,
      });
      const args = { principal, input, product, now: 150 };
      expect(() => tx.insertDraftIfRevision({ ...args, grant: scope as Grant })).toThrow('GRANT_NOT_ACTIVE');
      escapedGrant = issueGrant(scope);
      unusedGrant = issueGrant({ ...scope, draftId: 'draft_unused' });
      escapedIssuer = issueGrant;
      expect(Object.isFrozen(escapedGrant)).toBe(true);
      expect(Object.isFrozen(escapedGrant.principal)).toBe(true);
      expect(() => tx.insertDraftIfRevision({ ...args, grant: { ...escapedGrant } })).toThrow('GRANT_NOT_ACTIVE');
      expect(tx.insertDraftIfRevision({ ...args, grant: escapedGrant })?.quantity).toBe(2);
      expect(() => tx.insertDraftIfRevision({ ...args, grant: escapedGrant })).toThrow('GRANT_NOT_ACTIVE');
    });
    expect(() => escapedIssuer(scope)).toThrow('TRANSACTION_CLOSED');
    await store.immediate((tx) => {
      expect(() => tx.insertDraftIfRevision({ principal, input, product, now: 150, grant: escapedGrant })).toThrow('GRANT_NOT_ACTIVE');
      expect(() => tx.insertDraftIfRevision({ principal, input, product, now: 150, grant: unusedGrant })).toThrow('GRANT_NOT_ACTIVE');
    });
    store.close();
  });

  it('binds the one-use grant to the validated input hash', async () => {
    const store = new SqliteOrderStore(':memory:');
    await store.immediate((tx, issueGrant) => {
      const grant = issueGrant(scope);
      expect(() => tx.insertDraftIfRevision({ principal, product, input: { ...input, quantity: 20 }, now: 150, grant }))
        .toThrow('GRANT_SCOPE_MISMATCH');
    });
    store.close();
  });

  it('rejects invalid retry settings that cannot enforce a bounded wait', () => {
    for (const options of [
      { busyRetryBudgetMs: Number.NaN }, { busyRetryBudgetMs: Infinity },
      { busyMaxWaitMs: 0 }, { retryAfterSeconds: -1 },
    ]) expect(() => new SqliteOrderStore(':memory:', options)).toThrow('INVALID_SQLITE_RETRY_OPTIONS');
  });
});
