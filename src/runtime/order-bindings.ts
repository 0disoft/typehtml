import type { Principal, Product, Draft, PublicReceipt, OrderInput } from './order.ts';
import { toPublicReceipt } from './order.ts';
import type { OrderReadTx, OrderWriteTx } from './order-storage.ts';
import type { SyncResult } from './sync.ts';

export type Decision = Readonly<{ allow: true }> | Readonly<{ allow: false }>;

export type Grant = Readonly<{
  principal: Principal;
  resourceId: string;
  resourceRevision: number;
  operation: 'orders.createDraft';
  draftId: string;
  actionId: string;
  intentId: string;
  behaviorSha256: string;
  inputHash: string;
}>;

export interface OrderBindings {
  prepareIntent(
    context: Readonly<{ tx: OrderWriteTx; principal: Principal; productId: string }>,
  ): SyncResult<Product | null>;
  load(
    context: Readonly<{ tx: OrderReadTx; principal: Principal; input: OrderInput }>,
  ): SyncResult<Product | null>;
  authorize(
    context: Readonly<{ principal: Principal; input: OrderInput; resource: Product }>,
  ): SyncResult<Decision>;
  execute(
    context: Readonly<{
      tx: OrderWriteTx;
      principal: Principal;
      input: OrderInput;
      resource: Product;
      grant: Grant;
      now: number;
    }>,
  ): SyncResult<Draft>;
  project(result: Draft): SyncResult<PublicReceipt>;
  loadReceipt(
    context: Readonly<{ tx: OrderReadTx; principal: Principal; orderId: string }>,
  ): SyncResult<Draft | null>;
  authorizeReceipt(
    context: Readonly<{ principal: Principal; receipt: Draft }>,
  ): SyncResult<Decision>;
  projectReceipt(receipt: Draft): SyncResult<PublicReceipt>;
}

export function createOrderBindings(): OrderBindings {
  return {
    prepareIntent: ({ tx, principal, productId }) => {
      if (!tx.currentMember(principal.tenantId, principal.subjectId)) return null;
      const product = tx.loadProduct(principal.tenantId, productId);
      if (product === null || product.tenantId !== principal.tenantId || !product.active) return null;
      return product;
    },
    load: ({ tx, principal, input }) => {
      if (!tx.currentMember(principal.tenantId, principal.subjectId)) return null;
      return tx.loadProduct(principal.tenantId, input.productId);
    },
    authorize: ({ principal, resource }) => ({
      allow: resource.tenantId === principal.tenantId && resource.active,
    }),
    execute: ({ tx, principal, input, resource, grant, now }) => {
      if (
        grant.principal.subjectId !== principal.subjectId ||
        grant.principal.tenantId !== principal.tenantId ||
        grant.resourceId !== resource.id ||
        grant.resourceRevision !== resource.revision ||
        grant.operation !== 'orders.createDraft'
      ) {
        throw new Error('GRANT_SCOPE_MISMATCH');
      }
      const draft = tx.insertDraftIfRevision({ principal, input, product: resource, grant, now });
      if (draft === null) throw new Error('REVISION_CONFLICT');
      return draft;
    },
    project: (result) => toPublicReceipt(result),
    loadReceipt: ({ tx, principal, orderId }) => {
      if (!tx.currentMember(principal.tenantId, principal.subjectId)) return null;
      return tx.readDraft(principal.tenantId, orderId);
    },
    authorizeReceipt: ({ principal, receipt }) => ({
      allow: receipt.tenantId === principal.tenantId && receipt.subjectId === principal.subjectId,
    }),
    projectReceipt: (receipt) => toPublicReceipt(receipt),
  };
}
