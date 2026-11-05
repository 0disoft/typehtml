import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadBoundaryContract } from '../../src/contract/load.ts';
import { SqliteOrderStore, StoreBusyError } from '../../src/adapter/sqlite/order-store.ts';
import { createOrderBindings } from '../../src/runtime/order-bindings.ts';
import { OrderCoordinator } from '../../src/runtime/order-coordinator.ts';
import type { Principal, Product } from '../../src/runtime/order.ts';

const CONTRACT = resolve(import.meta.dir, '../../docs/design/v0.5/examples/order.boundary.json');
const principal: Principal = { subjectId: 'subject_1', tenantId: 'tenant_1', sessionId: 'session_1' };
const product: Product = {
  id: 'p_100',
  tenantId: 'tenant_1',
  name: 'Contended product',
  revision: 7,
  active: true,
  priceMinor: 12000,
  currency: 'KRW',
};

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temporaryDatabase(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typehtml-'));
  temporary.push(dir);
  return join(dir, 'orders.sqlite');
}

describe('SQLite writer contention', () => {
  it('bounds lock retries even when the business clock is frozen', async () => {
    const filename = await temporaryDatabase();
    const store = new SqliteOrderStore(filename, { now: () => 1_000_000, busyRetryBudgetMs: 20, busyMaxWaitMs: 5 });
    const blocker = new Database(filename, { strict: true });
    blocker.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    try {
      await expect(store.immediate(() => 1)).rejects.toBeInstanceOf(StoreBusyError);
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
      store.close();
    }
  });

  it('fails the second writer with StoreBusyError and recovers after release', async () => {
    const filename = await temporaryDatabase();
    const first = new SqliteOrderStore(filename, { busyRetryBudgetMs: 100, busyMaxWaitMs: 10 });
    first.seedMembership('tenant_1', 'subject_1', true);
    first.seedProduct(product);
    const second = new SqliteOrderStore(filename, { busyRetryBudgetMs: 100, busyMaxWaitMs: 10 });
    const loaded = await loadBoundaryContract(CONTRACT);
    const coordinator = new OrderCoordinator({
      loaded,
      bindings: createOrderBindings(),
      storage: second,
      now: () => Date.now(),
    });

    const begin = await coordinator.beginDraft(principal, 'p_100');
    const blocker = new Database(filename, { strict: true });
    blocker.exec('PRAGMA busy_timeout = 0');
    blocker.exec('BEGIN IMMEDIATE');
    try {
      await expect(second.immediate(() => 1)).rejects.toBeInstanceOf(StoreBusyError);
      await expect(
        coordinator.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '2' }),
      ).rejects.toMatchObject({ status: 503, code: 'BUSY', retryAfterSeconds: 1 });
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }

    const receipt = await coordinator.submitIntent(principal, begin.intentId, {
      productId: 'p_100',
      quantity: '2',
    });
    expect(receipt.location).toMatch(/^\/orders\/drafts\/draft_/);
    second.close();
    first.close();
  });

  it('preserves an OPEN intent that already has durable work and audits it', async () => {
    let now = 1_000_000;
    const filename = await temporaryDatabase();
    const store = new SqliteOrderStore(filename, { now: () => now });
    store.seedMembership('tenant_1', 'subject_1', true);
    store.seedProduct(product);
    const loaded = await loadBoundaryContract(CONTRACT);
    const coordinator = new OrderCoordinator({
      loaded,
      bindings: createOrderBindings(),
      storage: store,
      now: () => now,
    });
    const open = await coordinator.beginDraft(principal, 'p_100');
    const raw = new Database(filename, { strict: true });
    raw
      .query(
        `INSERT INTO order_drafts
           (id, intent_id, tenant_id, subject_id, product_id, product_revision,
            quantity, total_minor, currency, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('draft_corrupt', open.intentId, 'tenant_1', 'subject_1', 'p_100', 7, 2, 24000, 'KRW', 'draft');
    raw.close();

    now += 86_400_000;
    expect(await store.cleanupExpired()).toBe(0);
    expect(store.auditInconsistencies()).toEqual([
      { intentId: open.intentId, reason: 'OPEN_WITH_DURABLE_WORK' },
    ]);
    store.close();
  });

  it('cleans only consistent expiry and keeps drafts after intent retention', async () => {
    let now = 1_000_000;
    const store = new SqliteOrderStore(':memory:', { now: () => now });
    store.seedMembership('tenant_1', 'subject_1', true);
    store.seedProduct(product);
    const loaded = await loadBoundaryContract(CONTRACT);
    const coordinator = new OrderCoordinator({
      loaded,
      bindings: createOrderBindings(),
      storage: store,
      now: () => now,
    });

    const open = await coordinator.beginDraft(principal, 'p_100');
    now += 86_400_000;
    expect(await store.cleanupExpired()).toBe(1);
    expect(store.read((tx) => tx.loadIntent('tenant_1', 'subject_1', 'orders.createDraft', open.intentId))).toBeNull();

    now = 2_000_000;
    const completed = await coordinator.beginDraft(principal, 'p_100');
    const receipt = await coordinator.submitIntent(principal, completed.intentId, {
      productId: 'p_100',
      quantity: '2',
    });
    const orderId = receipt.location.split('/').pop()!;
    now = 2_000_000 + 86_400_000;
    expect(await store.cleanupExpired()).toBe(1);
    expect(store.read((tx) => tx.readDraft('tenant_1', orderId))).not.toBeNull();
    expect(() => coordinator.resolveReceipt(principal, orderId)).toThrow(
      expect.objectContaining({ status: 410, code: 'RESULT_EXPIRED' }),
    );
  });

  it('rejects corrupt receipt metadata and preserves its evidence during expiry cleanup', async () => {
    let now = 1_000_000;
    const filename = await temporaryDatabase();
    const store = new SqliteOrderStore(filename, { now: () => now });
    store.seedMembership('tenant_1', 'subject_1', true);
    store.seedProduct(product);
    const loaded = await loadBoundaryContract(CONTRACT);
    const coordinator = new OrderCoordinator({ loaded, bindings: createOrderBindings(), storage: store, now: () => now });
    const begin = await coordinator.beginDraft(principal, 'p_100');
    const receipt = await coordinator.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '2' });
    const raw = new Database(filename, { strict: true });
    raw.query('UPDATE action_results SET completed_at = completed_at + 1 WHERE intent_id = ?').run(begin.intentId);
    raw.close();
    expect(() => coordinator.resolveReceipt(principal, receipt.location.split('/').pop()!))
      .toThrow(expect.objectContaining({ status: 500, code: 'INTENT_STATE_INVALID' }));
    now += 86_400_000;
    expect(await store.cleanupExpired()).toBe(0);
    expect(store.auditInconsistencies()).toEqual([{ intentId: begin.intentId, reason: 'RESULT_METADATA_MISMATCH' }]);
    store.close();
  });
});
