import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { loadBoundaryContract } from '../../src/contract/load.ts';
import { SqliteOrderStore } from '../../src/adapter/sqlite/order-store.ts';
import { createOrderBindings, type OrderBindings } from '../../src/runtime/order-bindings.ts';
import { OrderCoordinator, OrderFailure } from '../../src/runtime/order-coordinator.ts';
import type { Principal, Product } from '../../src/runtime/order.ts';
import type { OrderStorage } from '../../src/runtime/order-storage.ts';

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

  it('applies current receipt authorization to successful POST replays', async () => {
    let allowed = true;
    const base = createOrderBindings();
    const { store, coordinator } = await setup({ bindings: {
      ...base,
      authorizeReceipt: () => ({ allow: allowed }),
    } });
    const { begin } = await beginAndSubmit(coordinator);
    allowed = false;
    await expect(coordinator.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '2' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(store.countAudit()).toBe(1);
    store.close();
  });

  it('rechecks expiry, membership, and revision before a missing-field 422', async () => {
    for (const change of ['expiry', 'membership', 'revision'] as const) {
      let now = 1_000_000;
      const { store, coordinator, loaded } = await setup({ now: () => now });
      const begin = await coordinator.beginDraft(principal, 'p_100');
      let reads = 0;
      const storage: OrderStorage = {
        read: (work) => {
          if (++reads === 2) {
            if (change === 'expiry') now += 86_400_000;
            if (change === 'membership') store.seedMembership('tenant_1', 'subject_1', false);
            if (change === 'revision') store.setProductRevision('tenant_1', 'p_100', 8, 13000);
          }
          return store.read(work);
        },
        immediate: (work) => store.immediate(work),
      };
      const fresh = new OrderCoordinator({ loaded, bindings: createOrderBindings(), storage, now: () => now });
      await expect(fresh.submitIntent(principal, begin.intentId, { productId: 'p_100' }))
        .rejects.toMatchObject({ status: { expiry: 410, membership: 404, revision: 409 }[change] });
      store.close();
    }
  });

  it('limits OPEN intents atomically and releases capacity after completion or expiry', async () => {
    let now = 1_000_000;
    const { store, loaded } = await setup({ now: () => now });
    const coordinator = new OrderCoordinator({
      loaded, bindings: createOrderBindings(), storage: store, now: () => now, maxOpenIntents: 1,
    });
    const first = await coordinator.beginDraft(principal, 'p_100');
    await expect(coordinator.beginDraft(principal, 'p_100'))
      .rejects.toMatchObject({ status: 429, code: 'OPEN_INTENT_LIMIT' });
    expect(store.countIntents()).toBe(1);
    await coordinator.submitIntent(principal, first.intentId, { productId: 'p_100', quantity: '2' });
    await coordinator.beginDraft(principal, 'p_100');
    now += 86_400_000;
    await expect(coordinator.beginDraft(principal, 'p_100')).resolves.toHaveProperty('intentId');
    store.close();
  });

  it('rejects a valid-looking projection for a different draft and rolls back', async () => {
    const { store, coordinator } = await setup({ bindings: {
      ...createOrderBindings(),
      project: () => ({ orderId: `draft_${crypto.randomUUID()}`, state: 'draft', totalMinor: 24000, currency: 'KRW' }),
    } });
    const begin = await coordinator.beginDraft(principal, 'p_100');
    await expect(coordinator.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '2' }))
      .rejects.toMatchObject({ status: 500, code: 'OUTPUT_INVALID' });
    expect(store.read((tx) => tx.readDraftByIntent(begin.intentId))).toBeNull();
    expect(store.countAudit()).toBe(0);
    store.close();
  });

  it('bounds raw echo even when called without the HTTP parser', async () => {
    const { store, coordinator } = await setup();
    const begin = await coordinator.beginDraft(principal, 'p_100');
    await expect(coordinator.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '1'.repeat(1025) }))
      .rejects.toMatchObject({ status: 422, formState: { rawValues: { productId: 'p_100' } } });
    store.close();
  });

  it('validates public page projections on both start and intent form reads', async () => {
    const { store, coordinator } = await setup();
    const begin = await coordinator.beginDraft(principal, 'p_100');
    store.seedProduct({ ...product(), name: 'x'.repeat(1000) });
    for (const target of [{ kind: 'product', productId: 'p_100' }, { kind: 'intent', intentId: begin.intentId }] as const) {
      expect(() => coordinator.resolvePage(principal, target))
        .toThrow(expect.objectContaining({ status: 500, code: 'PAGE_VIEW_INVALID' }));
    }
    store.close();
  });

  it('freezes validated input and authority facts before invoking application callbacks', async () => {
    const base = createOrderBindings();
    const { store, coordinator } = await setup({ bindings: {
      ...base,
      authorize: ({ principal: caller, input, resource }) => {
        expect(Object.isFrozen(caller)).toBe(true);
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(resource)).toBe(true);
        expect(() => { (input as { quantity: number }).quantity = 20; }).toThrow();
        return { allow: true };
      },
      execute: (context) => {
        expect(Object.isFrozen(context.grant)).toBe(true);
        expect(Object.isFrozen(context.grant.principal)).toBe(true);
        return base.execute(context);
      },
    } });
    const { begin, receipt } = await beginAndSubmit(coordinator);
    const draft = store.read((tx) => tx.readDraftByIntent(begin.intentId));
    expect(draft?.quantity).toBe(2);
    expect(coordinator.resolveReceipt(principal, receipt.location.split('/').pop()!).totalMinor).toBe(24000);
    await expect(coordinator.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '2' }))
      .resolves.toEqual(receipt);
    store.close();
  });

  it('rejects stateful public projection accessors without invoking them', async () => {
    let getterCalls = 0;
    const { store, coordinator } = await setup({ bindings: {
      ...createOrderBindings(),
      project: (draft) => ({
        orderId: draft.orderId, state: 'draft', currency: 'KRW',
        get totalMinor() { return ++getterCalls === 1 ? 24000 : -1; },
      }),
    } });
    const begin = await coordinator.beginDraft(principal, 'p_100');
    await expect(coordinator.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '2' }))
      .rejects.toMatchObject({ status: 500, code: 'OUTPUT_INVALID' });
    expect(getterCalls).toBe(0);
    expect(store.read((tx) => tx.readDraftByIntent(begin.intentId))).toBeNull();
    store.close();
  });
});

describe('write candidate orchestration', () => {
  it('preserves role and persistence order with owned frozen facts and exact result metadata', async () => {
    const { store, loaded } = await setup();
    const base = createOrderBindings();
    const phases: string[] = [];
    const caller = { ...principal };
    const fields = { productId: 'p_100', quantity: '2' };
    const loadedProduct = product();
    let loadContext: object;
    let authorizationContext: object;
    let executedDraft: ReturnType<OrderBindings['execute']> | undefined;
    const bindings: OrderBindings = {
      ...base,
      load: (context) => {
        phases.push('load');
        loadContext = context;
        expect(context.principal).not.toBe(caller);
        expect(Object.isFrozen(context.principal)).toBe(true);
        expect(Object.isFrozen(context.input)).toBe(true);
        return loadedProduct;
      },
      authorize: (context) => {
        phases.push('authorize');
        authorizationContext = context;
        expect(context).not.toBe(loadContext);
        expect(context.resource).not.toBe(loadedProduct);
        expect(Object.isFrozen(context.resource)).toBe(true);
        return base.authorize(context);
      },
      execute: (context) => {
        phases.push('execute');
        expect(context).not.toBe(authorizationContext);
        executedDraft = base.execute(context);
        return executedDraft;
      },
      project: (draft) => {
        phases.push('project');
        expect(draft).not.toBe(executedDraft);
        expect(Object.isFrozen(draft)).toBe(true);
        return base.project(draft);
      },
    };
    const storage: OrderStorage = {
      read: (work) => store.read(work),
      immediate: (work) => store.immediate((tx, issueGrant) => work(new Proxy(tx, {
        get(target, key) {
          const method = Reflect.get(target, key);
          if (typeof method !== 'function') return method;
          return (...args: unknown[]) => {
            if (['consumeIntent', 'insertResult', 'insertAudit'].includes(String(key))) phases.push(String(key));
            return Reflect.apply(method, target, args);
          };
        },
      }), (scope) => { phases.push('grant'); return issueGrant(scope); })),
    };
    const coordinator = new OrderCoordinator({ loaded, bindings, storage, now: () => 1_000_123 });
    try {
      const begin = await coordinator.beginDraft(caller, 'p_100');
      const receipt = await coordinator.submitIntent(caller, begin.intentId, fields);
      expect(phases).toEqual(['load', 'authorize', 'grant', 'execute', 'consumeIntent', 'project', 'insertResult', 'insertAudit']);
      expect(store.read((tx) => tx.loadResult(begin.intentId))).toEqual({
        intentId: begin.intentId,
        draftId: receipt.location.split('/').pop()!,
        behaviorHash: loaded.behaviorSha256,
        // bc-input/1: productId is a string and the decoded quantity is integer 2.
        inputHash: 'aae8be4dbbccaeeff6889697852a2c1f5f900e06d14a01830fd2f5d49024bf26',
        completedAt: 1_000_123,
        expiresAt: 87_400_123,
      });
      expect(caller).toEqual(principal);
      expect(fields).toEqual({ productId: 'p_100', quantity: '2' });
      expect(loadedProduct).toEqual(product());
      expect(executedDraft).toEqual(store.read((tx) => tx.readDraftByIntent(begin.intentId))!);
      for (const external of [caller, fields, loadedProduct, executedDraft]) expect(Object.isFrozen(external)).toBe(false);
    } finally { store.close(); }
  });

  it.each(['load', 'authorize', 'execute', 'project', 'draft snapshot'] as const)(
    'keeps REVISION_CONFLICT mapping scoped to execute (%s)', async (phase) => {
      const base = createOrderBindings();
      const failure = new Error('REVISION_CONFLICT');
      const { store, coordinator } = await setup({ bindings: {
        ...base,
        load: (context) => { if (phase === 'load') throw failure; return base.load(context); },
        authorize: (context) => { if (phase === 'authorize') throw failure; return base.authorize(context); },
        execute: (context) => {
          if (phase === 'execute') throw failure;
          const draft = base.execute(context);
          return phase === 'draft snapshot' ? { ...draft, get quantity(): number { throw failure; } } : draft;
        },
        project: (draft) => { if (phase === 'project') throw failure; return base.project(draft); },
      } });
      try {
        const begin = await coordinator.beginDraft(principal, 'p_100');
        const submitted = coordinator.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '2' });
        if (phase === 'execute') await expect(submitted).rejects.toMatchObject({ status: 409, code: 'QUOTE_CHANGED' });
        else await expect(submitted).rejects.toBe(failure);
        expect(store.read((tx) => tx.loadIntent('tenant_1', 'subject_1', 'orders.createDraft', begin.intentId))?.consumedAt).toBeNull();
        expect(store.read((tx) => tx.readDraftByIntent(begin.intentId))).toBeNull();
        expect(store.read((tx) => tx.loadResult(begin.intentId))).toBeNull();
        expect(store.countAudit()).toBe(0);
      } finally { store.close(); }
    },
  );

  it('reports a failed consume before projection and rolls the executed draft back', async () => {
    const { store, coordinator, loaded } = await setup();
    const begin = await coordinator.beginDraft(principal, 'p_100');
    let executions = 0;
    let projections = 0;
    const base = createOrderBindings();
    const storage: OrderStorage = {
      read: (work) => store.read(work),
      immediate: (work) => store.immediate((tx, issueGrant) => work(new Proxy(tx, {
        get(target, key) { return key === 'consumeIntent' ? () => false : Reflect.get(target, key); },
      }), issueGrant)),
    };
    const candidate = new OrderCoordinator({
      loaded, storage, now: () => 1_000_000,
      bindings: {
        ...base,
        execute: (context) => { executions++; return base.execute(context); },
        project: () => { projections++; throw new Error('projection must not run'); },
      },
    });
    try {
      await expect(candidate.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '2' }))
        .rejects.toMatchObject({ status: 409, code: 'CAS_CONFLICT' });
      expect(executions).toBe(1);
      expect(projections).toBe(0);
      expect(store.read((tx) => tx.loadIntent('tenant_1', 'subject_1', 'orders.createDraft', begin.intentId))?.consumedAt).toBeNull();
      expect(store.read((tx) => tx.readDraftByIntent(begin.intentId))).toBeNull();
      expect(store.read((tx) => tx.loadResult(begin.intentId))).toBeNull();
      expect(store.countAudit()).toBe(0);
      await expect(coordinator.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '2' }))
        .resolves.toHaveProperty('location');
      expect(store.countAudit()).toBe(1);
    } finally { store.close(); }
  });

  it('reads the recovery snapshot before sampling its clock without executing work again', async () => {
    const { store, coordinator, loaded } = await setup();
    const begin = await coordinator.beginDraft(principal, 'p_100');
    const phases: string[] = [];
    let recovering = false;
    let executions = 0;
    const base = createOrderBindings();
    const storage: OrderStorage = {
      read: (work) => store.read(work),
      immediate: async (work) => {
        await store.immediate(work);
        throw Object.assign(new Error('lost commit acknowledgement'), { name: 'StoreCommitError' });
      },
      recoverRead: (work) => {
        recovering = true;
        return store.read((tx) => work(new Proxy(tx, {
          get(target, key) {
            const method = Reflect.get(target, key);
            if (typeof method !== 'function') return method;
            return (...args: unknown[]) => { phases.push(String(key)); return Reflect.apply(method, target, args); };
          },
        })));
      },
    };
    const candidate = new OrderCoordinator({
      loaded, storage,
      bindings: { ...base, execute: (context) => { executions++; return base.execute(context); } },
      now: () => { if (recovering) phases.push('clock'); return 1_000_000; },
    });
    try {
      const receipt = await candidate.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '2' });
      expect(phases.slice(0, 6)).toEqual(['loadIntent', 'loadResult', 'readDraftByIntent', 'loadProduct', 'currentMember', 'clock']);
      expect(executions).toBe(1);
      expect(store.countAudit()).toBe(1);
      await expect(coordinator.submitIntent(principal, begin.intentId, { productId: 'p_100', quantity: '2' }))
        .resolves.toEqual(receipt);
    } finally { store.close(); }
  });
});
