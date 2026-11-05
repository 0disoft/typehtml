/** Design reference only. This is not a released runtime SDK. */
import type { SyncResult } from './sync-result.js';
declare const grantBrand: unique symbol;
declare const txBrand: unique symbol;
export type Decision = { readonly allow: true } | { readonly allow: false };
export type PrincipalBase = { readonly subjectId: string; readonly tenantId: string; readonly sessionId: string };
export type VersionedResource = { readonly id: string; readonly tenantId: string; readonly revision: number };
export type TransactionHandle = { readonly [txBrand]: true };
export type Grant<P extends PrincipalBase, R extends VersionedResource> = {
  readonly [grantBrand]: true;
  readonly principal: P;
  readonly resourceId: R['id'];
  readonly resourceRevision: R['revision'];
  readonly operation: 'orders.createDraft';
  readonly requestId: string;
  readonly intentId: string;
  readonly behaviorSha256: string;
  readonly inputHash: string;
};
export interface BindingTypes {
  Input: object;
  Principal: PrincipalBase;
  Resource: VersionedResource;
  Result: object;
  Output: object;
  PageView: object;
  Receipt: object;
  Tx: TransactionHandle;
}
export type PageTarget = Readonly<{ kind: 'product'; productId: string }> | Readonly<{ kind: 'intent'; intentId: string }>;
export type PageFailureCode = 'NOT_FOUND' | 'INTENT_UNAVAILABLE' | 'INTENT_EXPIRED' |
  'RESULT_EXPIRED' | 'CONTRACT_CHANGED' | 'QUOTE_CHANGED' | 'INTENT_STATE_INVALID';
export type PageResolution<V, O> =
  | Readonly<{ kind: 'start'; view: V }>
  | Readonly<{ kind: 'form'; intentId: string; view: V }>
  | Readonly<{ kind: 'receipt'; output: O }>
  | Readonly<{ kind: 'failure'; status: 404 | 409 | 410 | 500; code: PageFailureCode }>;
export type StartState = Readonly<{ csrfToken: string; formErrors: readonly string[] }>;
export type AuthContext = Readonly<{ request: Request; traceId: string }>;
export type FormState<I extends object> = Readonly<{
  rawValues: Partial<Record<Extract<keyof I, string>, string>>;
  fieldErrors: Partial<Record<Extract<keyof I, string>, readonly string[]>>;
  formErrors: readonly string[];
  csrfToken: string;
  intentId: string;
}>;
export type BindingRoleMap<T extends BindingTypes> = {
  principal: (context: AuthContext) => Promise<T['Principal']>;
  prepareIntent: (context: Readonly<{ tx: T['Tx']; principal: T['Principal']; productId: string }>) => SyncResult<T['Resource'] | null>;
  load: (context: Readonly<{ tx: T['Tx']; principal: T['Principal']; input: T['Input'] }>) => SyncResult<T['Resource'] | null>;
  authorize: (context: Readonly<{ principal: T['Principal']; input: T['Input']; resource: T['Resource'] }>) => SyncResult<Decision>;
  execute: (context: Readonly<{ tx: T['Tx']; principal: T['Principal']; input: T['Input']; resource: T['Resource']; grant: Grant<T['Principal'], T['Resource']> }>) => SyncResult<T['Result']>;
  project: (result: T['Result']) => SyncResult<T['Output']>;
  loadReceipt: (context: Readonly<{ tx: T['Tx']; principal: T['Principal']; orderId: string }>) => SyncResult<T['Receipt'] | null>;
  authorizeReceipt: (context: Readonly<{ principal: T['Principal']; receipt: T['Receipt'] }>) => SyncResult<Decision>;
  projectReceipt: (receipt: T['Receipt']) => SyncResult<T['Output']>;
  resolvePage: (context: Readonly<{ principal: T['Principal']; target: PageTarget }>) => Promise<PageResolution<T['PageView'], T['Output']>>;
  renderStart: (view: T['PageView'], state: StartState) => string;
  renderForm: (view: T['PageView'], state: FormState<T['Input']>) => string;
  renderReceipt: (receipt: T['Output']) => string;
};
