import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { loadBoundaryContract } from '../../src/contract/load.ts';
import { SqliteOrderStore } from '../../src/adapter/sqlite/order-store.ts';
import { createOrderBindings, type OrderBindings } from '../../src/runtime/order-bindings.ts';
import { OrderCoordinator } from '../../src/runtime/order-coordinator.ts';
import type { OrderStorage } from '../../src/runtime/order-storage.ts';

const CONTRACT = resolve(import.meta.dir, '../../docs/design/v0.5/examples/order.boundary.json');
const principal = { tenantId: 'tenant_1', subjectId: 'subject_1', sessionId: 'session_1' };
const fields = { productId: 'p_100', quantity: '2' };

function gatedStorage(store: SqliteOrderStore) {
  let next: { entered: () => void; resume: Promise<void> } | undefined;
  const storage: OrderStorage = {
    read: (work) => store.read(work),
    async immediate(work) {
      const waiting = next;
      next = undefined;
      if (waiting !== undefined) { waiting.entered(); await waiting.resume; }
      return store.immediate(work);
    },
  };
  return {
    storage,
    pauseNext() {
      let entered!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>((resolve) => { entered = resolve; });
      const resume = new Promise<void>((resolve) => { release = resolve; });
      next = { entered, resume };
      return { arrived, release };
    },
  };
}

async function setup(bindings: OrderBindings) {
  const loaded = await loadBoundaryContract(CONTRACT);
  const store = new SqliteOrderStore(':memory:');
  store.seedMembership(principal.tenantId, principal.subjectId);
  store.seedProduct({ id: 'p_100', tenantId: principal.tenantId, name: 'Product', revision: 7,
    active: true, priceMinor: 12000, currency: 'KRW' });
  const gated = gatedStorage(store);
  const coordinator = new OrderCoordinator({ loaded, bindings, storage: gated.storage, now: () => 1_000_000 });
  return { store, coordinator, gated };
}

class StatefulBindings implements OrderBindings {
  #calls: string[] = [];
  private readonly base = createOrderBindings();
  allowed = true;

  get calls(): readonly string[] { return this.#calls; }
  private record(role: string) { this.#calls.push(role); }
  prepareIntent(context: Parameters<OrderBindings['prepareIntent']>[0]) {
    this.record('prepareIntent'); return this.base.prepareIntent(context);
  }
  load(context: Parameters<OrderBindings['load']>[0]) {
    this.record('load'); return this.base.load(context);
  }
  authorize(context: Parameters<OrderBindings['authorize']>[0]) {
    this.record('authorize'); return this.allowed ? this.base.authorize(context) : { allow: false as const };
  }
  execute(context: Parameters<OrderBindings['execute']>[0]) {
    this.record('execute'); return this.base.execute(context);
  }
  project(result: Parameters<OrderBindings['project']>[0]) {
    this.record('project'); return this.base.project(result);
  }
  loadReceipt(context: Parameters<OrderBindings['loadReceipt']>[0]) {
    this.record('loadReceipt'); return this.base.loadReceipt(context);
  }
  authorizeReceipt(context: Parameters<OrderBindings['authorizeReceipt']>[0]) {
    this.record('authorizeReceipt'); return this.base.authorizeReceipt(context);
  }
  projectReceipt(receipt: Parameters<OrderBindings['projectReceipt']>[0]) {
    this.record('projectReceipt'); return this.base.projectReceipt(receipt);
  }
}

describe('coordinator binding ownership', () => {
  it.each([true, false])('retains authorize when the caller replaces it during acquisition (allowed=%s)', async (allowed) => {
    const bindings = createOrderBindings();
    bindings.authorize = () => allowed ? { allow: true } : { allow: false };
    const { store, coordinator, gated } = await setup(bindings);
    let gate: ReturnType<typeof gated.pauseNext> | undefined;
    let pending: ReturnType<OrderCoordinator['submitIntent']> | undefined;
    try {
      const intent = await coordinator.beginDraft(principal, 'p_100');
      gate = gated.pauseNext();
      pending = coordinator.submitIntent(principal, intent.intentId, fields);
      await gate.arrived;
      bindings.authorize = () => allowed ? { allow: false } : { allow: true };
      gate.release();
      if (allowed) await expect(pending).resolves.toHaveProperty('kind', 'receipt');
      else await expect(pending).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(store.countAudit()).toBe(allowed ? 1 : 0);
      expect(Object.isFrozen(bindings)).toBe(false);
    } finally {
      gate?.release();
      await pending?.catch(() => undefined);
      store.close();
    }
  });

  it('captures inherited methods while preserving their original stateful receiver and phase order', async () => {
    const bindings = new StatefulBindings();
    expect(Object.hasOwn(bindings, 'prepareIntent')).toBe(false);
    const { store, coordinator } = await setup(bindings);
    try {
      for (const role of ['prepareIntent', 'load', 'authorize', 'execute', 'project',
        'loadReceipt', 'authorizeReceipt', 'projectReceipt'] as const) {
        Object.defineProperty(bindings, role, { configurable: true, writable: true,
          value: () => { throw new Error(`replaced ${role}`); } });
      }
      const intent = await coordinator.beginDraft(principal, 'p_100');
      const result = await coordinator.submitIntent(principal, intent.intentId, fields);
      const orderId = decodeURIComponent(result.location.split('/').at(-1)!);
      expect(coordinator.resolveReceipt(principal, orderId).orderId).toBe(orderId);
      expect(bindings.calls).toEqual(['prepareIntent', 'load', 'authorize', 'execute', 'project',
        'loadReceipt', 'authorizeReceipt', 'projectReceipt']);
      expect(Object.isFrozen(bindings)).toBe(false);
    } finally { store.close(); }
  });

  it('keeps receiver state live and rechecks database membership after acquisition', async () => {
    const bindings = new StatefulBindings();
    const { store, coordinator, gated } = await setup(bindings);
    let gate: ReturnType<typeof gated.pauseNext> | undefined;
    let pending: ReturnType<OrderCoordinator['submitIntent']> | undefined;
    try {
      const denied = await coordinator.beginDraft(principal, 'p_100');
      bindings.allowed = false;
      await expect(coordinator.submitIntent(principal, denied.intentId, fields))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      bindings.allowed = true;
      const revoked = await coordinator.beginDraft(principal, 'p_100');
      gate = gated.pauseNext();
      pending = coordinator.submitIntent(principal, revoked.intentId, fields);
      await gate.arrived;
      store.seedMembership(principal.tenantId, principal.subjectId, false);
      gate.release();
      await expect(pending).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(store.countAudit()).toBe(0);
      expect(Object.isFrozen(store)).toBe(false);
    } finally {
      gate?.release();
      await pending?.catch(() => undefined);
      store.close();
    }
  });
});
