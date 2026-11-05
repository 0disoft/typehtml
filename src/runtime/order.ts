export type Principal = Readonly<{
  subjectId: string;
  tenantId: string;
  sessionId: string;
}>;

export type Product = Readonly<{
  id: string;
  tenantId: string;
  name: string;
  revision: number;
  active: boolean;
  priceMinor: number;
  currency: 'KRW';
}>;

export type OrderInput = Readonly<{ productId: string; quantity: number }>;

export type Draft = Readonly<{
  orderId: string;
  intentId: string;
  tenantId: string;
  subjectId: string;
  productId: string;
  productRevision: number;
  quantity: number;
  totalMinor: number;
  currency: 'KRW';
  state: 'draft';
}>;

export type PublicReceipt = Readonly<{
  orderId: string;
  state: 'draft';
  totalMinor: number;
  currency: 'KRW';
}>;

export type OrderPageView = Readonly<{
  productId: string;
  productName: string;
  unitPriceMinor: number;
  currency: 'KRW';
  productRevision: number;
}>;

export type PageTarget =
  | Readonly<{ kind: 'product'; productId: string }>
  | Readonly<{ kind: 'intent'; intentId: string }>;

export type PageFailureCode =
  | 'NOT_FOUND'
  | 'INTENT_UNAVAILABLE'
  | 'INTENT_EXPIRED'
  | 'RESULT_EXPIRED'
  | 'CONTRACT_CHANGED'
  | 'QUOTE_CHANGED'
  | 'COMPLETED_INPUT_CONFLICT'
  | 'INTENT_STATE_INVALID'
  | 'INVALID_CLOCK';

export type PageResolution =
  | Readonly<{ kind: 'start'; view: OrderPageView }>
  | Readonly<{ kind: 'form'; intentId: string; view: OrderPageView }>
  | Readonly<{ kind: 'receipt'; output: PublicReceipt }>
  | Readonly<{ kind: 'failure'; status: 404 | 409 | 410 | 500; code: PageFailureCode }>;

export type StartState = Readonly<{ csrfToken: string; formErrors: readonly string[] }>;

export type FormState = Readonly<{
  rawValues: Readonly<Partial<Record<'productId' | 'quantity', string>>>;
  fieldErrors: Readonly<Partial<Record<'productId' | 'quantity', readonly string[]>>>;
  formErrors: readonly string[];
  csrfToken: string;
  intentId: string;
}>;

export function newDraftId(): string {
  return `draft_${crypto.randomUUID()}`;
}

export function newIntentId(): string {
  return `intent_${crypto.randomUUID()}`;
}

export function toPublicReceipt(draft: Draft): PublicReceipt {
  return Object.freeze({
    orderId: draft.orderId,
    state: draft.state,
    totalMinor: draft.totalMinor,
    currency: draft.currency,
  });
}

export function toPageView(product: Product): OrderPageView {
  return Object.freeze({
    productId: product.id,
    productName: product.name,
    unitPriceMinor: product.priceMinor,
    currency: product.currency,
    productRevision: product.revision,
  });
}
