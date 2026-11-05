import type { Principal, Product, Draft, OrderInput } from './order.ts';
import type { Grant } from './order-bindings.ts';

export type StoredIntent = Readonly<{
  id: string;
  tenantId: string;
  subjectId: string;
  actionId: string;
  productId: string;
  resourceRevision: number;
  behaviorHash: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
}>;

export type StoredResult = Readonly<{
  intentId: string;
  draftId: string;
  behaviorHash: string;
  inputHash: string;
  completedAt: number;
  expiresAt: number;
}>;

export interface OrderReadTx {
  currentMember(tenantId: string, subjectId: string): boolean;
  loadProduct(tenantId: string, productId: string): Product | null;
  loadIntent(tenantId: string, subjectId: string, actionId: string, intentId: string): StoredIntent | null;
  loadResult(intentId: string): StoredResult | null;
  readDraft(tenantId: string, orderId: string): Draft | null;
  readDraftByIntent(intentId: string): Draft | null;
}

export interface OrderWriteTx extends OrderReadTx {
  insertIntent(intent: StoredIntent): void;
  insertDraftIfRevision(args: Readonly<{
    principal: Principal;
    input: OrderInput;
    product: Product;
    grant: Grant;
    now: number;
  }>): Draft | null;
  consumeIntent(args: Readonly<{
    intentId: string;
    principal: Principal;
    behaviorHash: string;
    now: number;
  }>): boolean;
  insertResult(result: StoredResult): void;
  insertAudit(args: Readonly<{
    intentId: string;
    actionId: string;
    outcome: string;
    createdAt: number;
  }>): void;
}

export interface OrderStorage {
  read<T>(work: (tx: OrderReadTx) => T): T;
  immediate<T>(work: (tx: OrderWriteTx) => T): Promise<T>;
}
