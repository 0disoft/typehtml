/** Pure decision reference, not authorization, an HTTP handler, or a transaction coordinator.
 * Inputs must be copied from ONE scoped database snapshot after authentication.
 * Every write still requires a fresh IMMEDIATE transaction, policy and Grant/CAS checks.
 */
export type SavedResult = Readonly<{
  orderId: string; behaviorHash: string; inputHash: string;
  completedAt: number; expiresAt: number;
}>;
export type IntentSnapshot = Readonly<{
  intentId: string; behaviorHash: string; issuedAt: number; expiresAt: number;
  consumedAt: number | null; draftId: string | null; result: SavedResult | null;
  currentAuthorized: boolean; resourceRevisionMatches: boolean;
}>;
export type SubmissionInput =
  | Readonly<{ kind: 'unchecked' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'valid'; inputHash: string }>;
export type IntentRequest = Readonly<{ kind: 'view' }> |
  Readonly<{ kind: 'submit'; input: SubmissionInput }>;
export type IntentDecision =
  | Readonly<{ kind: 'error'; status: 404 | 409 | 410 | 500; code: string }>
  | Readonly<{ kind: 'form'; status: 200 }>
  | Readonly<{ kind: 'invalid'; status: 422 }>
  | Readonly<{ kind: 'receipt'; status: 303; orderId: string }>
  | Readonly<{ kind: 'needs-input' }>
  | Readonly<{ kind: 'write-candidate'; requires: 'fresh-immediate-policy-grant-cas' }>;
const error = (status: 404 | 409 | 410 | 500, code: string): IntentDecision => ({ kind: 'error', status, code });
const epoch = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
export function decideIntent(snapshot: IntentSnapshot | null, request: IntentRequest,
  now: number, currentBehaviorHash: string): IntentDecision {
  if (!epoch(now)) return error(500, 'INVALID_CLOCK');
  if (snapshot === null) return error(410, 'INTENT_UNAVAILABLE');
  const s = snapshot;
  // No detailed lifecycle or contract information before current object authorization.
  if (!s.currentAuthorized) return error(404, 'NOT_FOUND');
  if (!epoch(s.issuedAt) || !epoch(s.expiresAt) || s.expiresAt <= s.issuedAt) return error(500, 'INTENT_STATE_INVALID');
  const r = s.result;
  if (s.consumedAt === null) {
    if (r !== null || s.draftId !== null) return error(500, 'INTENT_STATE_INVALID');
    if (now >= s.expiresAt) return error(410, 'INTENT_EXPIRED');
    if (s.behaviorHash !== currentBehaviorHash) return error(409, 'CONTRACT_CHANGED');
    if (!s.resourceRevisionMatches) return error(409, 'QUOTE_CHANGED');
    if (request.kind === 'view') return { kind: 'form', status: 200 };
    if (request.input.kind === 'unchecked') return { kind: 'needs-input' };
    if (request.input.kind === 'invalid') return { kind: 'invalid', status: 422 };
    return { kind: 'write-candidate', requires: 'fresh-immediate-policy-grant-cas' };
  }
  // A consumed intent without its matching durable result is NOT ordinary expiry.
  if (!epoch(s.consumedAt) || s.consumedAt < s.issuedAt || s.consumedAt >= s.expiresAt || r === null ||
      s.draftId !== r.orderId || r.behaviorHash !== s.behaviorHash ||
      r.completedAt !== s.consumedAt || !epoch(r.expiresAt) || r.expiresAt <= r.completedAt)
    return error(500, 'INTENT_STATE_INVALID');
  if (now >= r.expiresAt) return error(410, 'RESULT_EXPIRED');
  // A GET of an existing receipt need not execute old behavior or decode an old form.
  if (request.kind === 'view') return { kind: 'receipt', status: 303, orderId: r.orderId };
  if (s.behaviorHash !== currentBehaviorHash) return error(409, 'CONTRACT_CHANGED');
  if (request.input.kind === 'unchecked') return { kind: 'needs-input' };
  if (request.input.kind === 'invalid' || request.input.inputHash !== r.inputHash)
    return error(409, 'COMPLETED_INPUT_CONFLICT');
  return { kind: 'receipt', status: 303, orderId: r.orderId };
}
