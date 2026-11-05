/** Typed assembly example. Ports are supplied by the real application. No DB or auth is implemented here. */
import type { BindingRoleMap, FormState, PrincipalBase, TransactionHandle, Grant, StartState } from './binding-roles.js';
import type { OrderInput, PublicReceipt, OrderPageView } from './order-types.generated.js';
export type Product = {
  readonly id: string; readonly tenantId: string; readonly revision: number;
  readonly active: boolean; readonly priceMinor: number; readonly currency: 'KRW';
};
export type Draft = PublicReceipt & {
  readonly subjectId: string; readonly tenantId: string; readonly productId: string;
  readonly productRevision: number;
};
export interface OrderTx extends TransactionHandle {
  loadProduct: (tenantId: string, productId: string) => Product | null;
  currentMember: (tenantId: string, subjectId: string) => boolean;
  insertDraftIfRevision: (args: Readonly<{
    principal: PrincipalBase; input: OrderInput; product: Product;
    grant: Grant<PrincipalBase, Product>;
  }>) => Draft | null;
  readDraft: (tenantId: string, orderId: string) => Draft | null;
}
export type OrderTypes = {
  Input: OrderInput; Principal: PrincipalBase; Resource: Product; Result: Draft;
  Output: PublicReceipt; PageView: OrderPageView; Receipt: Draft; Tx: OrderTx;
};
export type OrderPorts = {
  requirePrincipal: BindingRoleMap<OrderTypes>['principal'];
  resolvePage: BindingRoleMap<OrderTypes>['resolvePage'];
  renderStart: (view: OrderPageView, state: StartState) => string;
  renderForm: (view: OrderPageView, state: FormState<OrderInput>) => string;
  renderReceipt: (view: PublicReceipt) => string;
};
function publicReceipt(draft: Draft): PublicReceipt {
  // Shape/type validation and escaped HTML rendering remain runtime responsibilities.
  return { orderId: draft.orderId, state: draft.state, totalMinor: draft.totalMinor, currency: draft.currency };
}
export function buildOrderBindings(ports: OrderPorts): BindingRoleMap<OrderTypes> {
  return {
    principal: ports.requirePrincipal,
    prepareIntent: ({ tx, principal, productId }) => {
      if (!tx.currentMember(principal.tenantId, principal.subjectId)) return null;
      const product = tx.loadProduct(principal.tenantId, productId);
      if (product === null || product.tenantId !== principal.tenantId || !product.active) return null;
      // The wrapper stores only ID/revision in the same transaction, then commits the intent.
      return product;
    },
    load: ({ tx, principal, input }) => {
      if (!tx.currentMember(principal.tenantId, principal.subjectId)) return null;
      return tx.loadProduct(principal.tenantId, input.productId);
    },
    authorize: ({ principal, resource }) => ({ allow: resource.tenantId === principal.tenantId && resource.active }),
    execute: ({ tx, principal, input, resource, grant }) => {
      // The real adapter must check grant identity/scope and affectedRows === 1.
      const draft = tx.insertDraftIfRevision({ principal, input, product: resource, grant });
      if (draft === null) throw new Error('REVISION_CONFLICT');
      return draft;
    },
    project: publicReceipt,
    loadReceipt: ({ tx, principal, orderId }) => {
      if (!tx.currentMember(principal.tenantId, principal.subjectId)) return null;
      return tx.readDraft(principal.tenantId, orderId);
    },
    authorizeReceipt: ({ principal, receipt }) => ({ allow: receipt.tenantId === principal.tenantId && receipt.subjectId === principal.subjectId }),
    projectReceipt: publicReceipt,
    resolvePage: ports.resolvePage,
    renderStart: ports.renderStart,
    renderForm: ports.renderForm,
    renderReceipt: ports.renderReceipt,
  } satisfies BindingRoleMap<OrderTypes>;
}
