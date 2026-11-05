import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { loadBoundaryContract } from '../../src/contract/load.ts';
import { SqliteOrderStore } from '../../src/adapter/sqlite/order-store.ts';
import { createOrderBindings } from '../../src/runtime/order-bindings.ts';
import { OrderCoordinator } from '../../src/runtime/order-coordinator.ts';
import type { Principal } from '../../src/runtime/order.ts';

const CONTRACT = join(import.meta.dir, '../../docs/design/v0.5/examples/order.boundary.json');
const principal: Principal = { subjectId: 'subject_1', tenantId: 'tenant_1', sessionId: 'session_1' };
const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'typehtml-backup-'));
  temporary.push(directory);
  return join(directory, 'orders.sqlite');
}

async function seeded(path: string) {
  const now = () => 1_000_000;
  const store = new SqliteOrderStore(path, { now });
  store.seedMembership('tenant_1', 'subject_1', true);
  store.seedProduct({
    id: 'p_100',
    tenantId: 'tenant_1',
    name: 'Backup product',
    revision: 7,
    active: true,
    priceMinor: 12000,
    currency: 'KRW',
  });
  const loaded = await loadBoundaryContract(CONTRACT);
  const coordinator = new OrderCoordinator({
    loaded,
    bindings: createOrderBindings(),
    storage: store,
    now,
  });
  return { store, coordinator };
}

describe('SQLite recovery', () => {
  it('returns the same receipt when the first response is lost after commit', async () => {
    const path = await databasePath();
    const { store, coordinator } = await seeded(path);
    const begin = await coordinator.beginDraft(principal, 'p_100');
    const first = await coordinator.submitIntent(principal, begin.intentId, {
      productId: 'p_100',
      quantity: '2',
    });
    const replay = await coordinator.submitIntent(principal, begin.intentId, {
      productId: 'p_100',
      quantity: '2',
    });
    expect(replay.location).toBe(first.location);
    expect(store.auditInconsistencies()).toEqual([]);
    store.close();
  });

  it('restores drafts and results from a VACUUM INTO backup', async () => {
    const path = await databasePath();
    const backup = join(join(path, '..'), 'backup.sqlite');
    const { store, coordinator } = await seeded(path);
    const begin = await coordinator.beginDraft(principal, 'p_100');
    const submit = await coordinator.submitIntent(principal, begin.intentId, {
      productId: 'p_100',
      quantity: '2',
    });
    const orderId = decodeURIComponent(submit.location.split('/').pop()!);
    const raw = new Database(path, { strict: true });
    raw.exec("VACUUM INTO '" + backup.replaceAll('\\', '/').replaceAll("'", "''") + "'");
    raw.close();
    store.close();

    const restored = await seeded(backup);
    const receipt = restored.coordinator.resolveReceipt(principal, orderId);
    expect(receipt).toEqual({ orderId, state: 'draft', totalMinor: 24000, currency: 'KRW' });
    expect(restored.store.auditInconsistencies()).toEqual([]);
    restored.store.close();
  });
});
