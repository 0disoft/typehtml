/** Compile-only fixtures. @ts-expect-error must correspond to an actual type error. */
import type { BindingRoleMap, Grant, PrincipalBase } from './binding-roles.js';
import type { OrderTypes, Product } from './order-bindings.js';
import type { OrderInput, OrderPageView, PublicReceipt } from './order-types.generated.js';
const input: OrderInput = { productId: 'p_100', quantity: 2 };
// @ts-expect-error wire string must be decoded before domain input
const badInput: OrderInput = { productId: 'p_100', quantity: '2' };
// @ts-expect-error page view is not an action receipt
const wrongView: OrderPageView = { orderId: 'draft_1', state: 'draft', totalMinor: 1, currency: 'KRW' };
// @ts-expect-error load is synchronous inside the SQLite transaction
const asyncLoad: BindingRoleMap<OrderTypes>['load'] = async () => null;
// @ts-expect-error policy must return an explicit decision, not a string
const badPolicy: BindingRoleMap<OrderTypes>['authorize'] = () => 'allow';
// @ts-expect-error execute requires a complete draft result, not a public receipt
const badExecute: BindingRoleMap<OrderTypes>['execute'] = () => ({ orderId:'draft_1', state:'draft', totalMinor: 1, currency:'KRW' });
// @ts-expect-error branded grant has no public constructor in this reference surface
const forgedGrant: Grant<PrincipalBase, Product> = { principal: { subjectId:'u',tenantId:'t',sessionId:'s' }, resourceId:'p',resourceRevision:1,operation:'orders.createDraft',requestId:'i',intentId:'i',behaviorSha256:'a'.repeat(64),inputHash:'b'.repeat(64) };
const output: PublicReceipt = { orderId:'draft_1', state:'draft', totalMinor:24000,currency:'KRW' };
void [input,badInput,wrongView,asyncLoad,badPolicy,badExecute,forgedGrant,output];

// v0.4 accepted Promise<object> in a deliberately broad result role.
type BroadResult = Omit<OrderTypes, 'Result'> & { Result: object };
// @ts-expect-error a broad object result must still exclude Promise/thenables
const broadAsyncExecute: BindingRoleMap<BroadResult>['execute'] = async () => ({ ok: true });
type BroadOutput = Omit<OrderTypes, 'Output'> & { Output: object };
// @ts-expect-error a broad public-output role must also stay synchronous
const broadAsyncProject: BindingRoleMap<BroadOutput>['project'] = async () => ({ ok: true });
// @ts-expect-error page resolution requires a discriminant; a bare view cannot express terminal state
const unclassifiedPage: BindingRoleMap<OrderTypes>['resolvePage'] = async () => ({ productId:'p_100',productName:'x',unitPriceMinor:1,currency:'KRW',productRevision:1 });
// Deliberately accepted counterexample: structural typing is NOT field projection.
const overwideProject: BindingRoleMap<OrderTypes>['project'] = draft => draft;
void [broadAsyncExecute,broadAsyncProject,unclassifiedPage,overwideProject];
