import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { loadBoundaryContract } from '../../src/contract/load.ts';
import { SqliteOrderStore } from '../../src/adapter/sqlite/order-store.ts';
import { createOrderBindings, type OrderBindings } from '../../src/runtime/order-bindings.ts';
import { OrderCoordinator, OrderFailure } from '../../src/runtime/order-coordinator.ts';
import type { Principal, Product } from '../../src/runtime/order.ts';

const CONTRACT = resolve(import.meta.dir, '../../docs/design/v0.5/examples/order.boundary.json');

const principal: Principal = { subjectId: 'subject_1', tenantId: 'tenant_1', sessionId: 'session_1' };

function product(revision = 7, priceMinor = 12000, active = true): Product {
  return {
    id: 'p_100',
    tenantId: 'tenant_1',
    name: 'Sample product',
    revision,
    active,
    priceMinor,
    currency: 'KRW',
  };
}

async function setup(options: Readonly<{ now?: () => number; product?: Product; bindings?: OrderBindings }> = {}) {
  const current = options.now ?? (() => 1_000_000);
  const store = new SqliteOrderStore(':memory:', { now: current });
  store.seedMembership('tenant_1', 'subject_1', true);
  store.seedProduct(options.product ?? product());
  const loaded = await loadBoundaryContract(CONTRACT);
  const coordinator = new OrderCoordinator({
    loaded,
    bindings: options.bindings ?? createOrderBindings(),
    storage: store,
    now: current,
  });
  return { store, coordinator, loaded };
}

async function beginAndSubmit(coordinator: OrderCoordinator) {
  const begin = await coordinator.beginDraft(principal, 'p_100');
  const receipt = await coordinator.submitIntent(principal, begin.intentId, {
    productId: 'p_100',
    quantity: '2',
  });
  return { begin, receipt };
}

describe('order coordinator and SQLite adapter', () => {
  it('runs start, begin, invalid retry, valid submit, and replay', async () => {
    const { store, coordinator } = await setup();
    const start = coordinator.resolvePage(principal, { kind: 'product', productId: 'p_100' });
    expect(start.kind).toBe('start');

    const begin = await coordinator.beginDraft(principal, 'p_100');
    expect(begin.location).toContain(begin.intentId);
    const form = coordinator.resolvePage(principal, { kind: 'intent', intentId: begin.intentId });
    expect(form.kind).toBe('form');
    if (form.kind === 'form') expect(form.view.productName).toBe('Sample product');

    let invalid: unknown;
    try {
      await coordinator.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '21' });
    } catch (error) {
      invalid = error;
    }
    expect(invalid).toBeInstanceOf(OrderFailure);
    expect((invalid as OrderFailure).status).toBe(422);
    expect((invalid as OrderFailure).formState?.rawValues.quantity).toBe('21');

    const receipt = await coordinator.submitIntent(principal, begin.intentId, {
      productId: 'p_100',
      quantity: '2',
    });
    expect(receipt.location).toMatch(/^\/orders\/drafts\/draft_/);
    const orderId = receipt.location.split('/').pop()!;
    const view = coordinator.resolveReceipt(principal, orderId);
    expect(view).toEqual({ orderId, state: 'draft', totalMinor: 24000, currency: 'KRW' });
    expect(coordinator.resolvePage(principal, { kind: 'intent', intentId: begin.intentId }).kind).toBe('receipt');

    const replay = await coordinator.submitIntent(principal, begin.intentId, {
      productId: 'p_100',
      quantity: '2',
    });
    expect(replay.location).toBe(receipt.location);
    await expect(
      coordinator.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '3' }),
    ).rejects.toMatchObject({ status: 409, code: 'COMPLETED_INPUT_CONFLICT' });
    expect(store.read((tx) => tx.loadIntent('tenant_1', 'subject_1', 'orders.createDraft', begin.intentId))?.consumedAt).toBe(1_000_000);
  });

  it('rejects unknown keys before touching the intent', async () => {
    const { coordinator } = await setup();
    const begin = await coordinator.beginDraft(principal, 'p_100');
    await expect(
      coordinator.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '2', extra: '1' }),
    ).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_FIELD' });
  });

  it('treats an expired intent as 410 and a changed revision as 409', async () => {
    let now = 1_000_000;
    const { store, coordinator } = await setup({ now: () => now });
    const begin = await coordinator.beginDraft(principal, 'p_100');
    now += 86_400_000;
    await expect(
      coordinator.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '2' }),
    ).rejects.toMatchObject({ status: 410, code: 'INTENT_EXPIRED' });

    now = 2_000_000;
    const second = await coordinator.beginDraft(principal, 'p_100');
    store.setProductRevision('tenant_1', 'p_100', 8, 13000);
    await expect(
      coordinator.submitIntent(principal, second.intentId, { productId: 'p_100', quantity: '2' }),
    ).rejects.toMatchObject({ status: 409, code: 'QUOTE_CHANGED' });
  });

  it('keeps a completed receipt readable after later revision changes', async () => {
    const { store, coordinator } = await setup();
    const { receipt } = await beginAndSubmit(coordinator);
    const orderId = receipt.location.split('/').pop()!;
    store.setProductRevision('tenant_1', 'p_100', 9, 15000);
    expect(coordinator.resolveReceipt(principal, orderId).totalMinor).toBe(24000);
  });

  it('does not create an intent on start or repeated form reads', async () => {
    const { store, coordinator } = await setup();
    expect(coordinator.resolvePage(principal, { kind: 'product', productId: 'p_100' }).kind).toBe('start');
    expect(store.countIntents()).toBe(0);
    const begin = await coordinator.beginDraft(principal, 'p_100');
    expect(store.countIntents()).toBe(1);
    expect(coordinator.resolvePage(principal, { kind: 'intent', intentId: begin.intentId }).kind).toBe('form');
    expect(coordinator.resolvePage(principal, { kind: 'intent', intentId: begin.intentId }).kind).toBe('form');
    expect(store.countIntents()).toBe(1);
  });

  it('rolls back the draft, consumed intent, result, and audit when projection fails', async () => {
    const base = createOrderBindings();
    const broken: OrderBindings = {
      ...base,
      project: () => ({ orderId: 'not-a-draft-id', state: 'draft', totalMinor: 24000, currency: 'KRW' }),
    };
    const { store, coordinator } = await setup({ bindings: broken });
    const begin = await coordinator.beginDraft(principal, 'p_100');
    await expect(
      coordinator.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '2' }),
    ).rejects.toThrow('OUTPUT_INVALID');
    expect(store.read((tx) => tx.loadIntent('tenant_1', 'subject_1', 'orders.createDraft', begin.intentId))?.consumedAt).toBeNull();
    expect(store.read((tx) => tx.readDraftByIntent(begin.intentId))).toBeNull();
    expect(store.read((tx) => tx.loadResult(begin.intentId))).toBeNull();
    expect(store.countAudit()).toBe(0);
  });

  it('reports consumed-without-result as a state failure', async () => {
    const { store, coordinator, loaded } = await setup();
    const begin = await coordinator.beginDraft(principal, 'p_100');
    store.immediate((tx) => tx.consumeIntent({
      intentId: begin.intentId,
      principal,
      behaviorHash: loaded.behaviorSha256,
      now: 1_000_000,
    }));
    expect(coordinator.resolvePage(principal, { kind: 'intent', intentId: begin.intentId })).toEqual({
      kind: 'failure',
      status: 500,
      code: 'INTENT_STATE_INVALID',
    });
  });

  it('rejects missing membership and inactive products', async () => {
    const { store, coordinator } = await setup({ product: product(7, 12000, false) });
    await expect(coordinator.beginDraft(principal, 'p_100')).rejects.toMatchObject({ status: 404 });
    const other: Principal = { ...principal, subjectId: 'subject_2' };
    expect(coordinator.resolvePage(other, { kind: 'product', productId: 'p_100' }).kind).toBe('failure');
    expect(store.read((tx) => tx.currentMember('tenant_1', 'subject_2'))).toBe(false);
  });
});