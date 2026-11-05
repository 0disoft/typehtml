export type SavedResult = Readonly<{
  orderId: string;
  behaviorHash: string;
  inputHash: string;
  completedAt: number;
  expiresAt: number;
}>;

export type IntentSnapshot = Readonly<{
  intentId: string;
  behaviorHash: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  draftId: string | null;
  result: SavedResult | null;
  currentAuthorized: boolean;
  resourceRevisionMatches: boolean;
}>;

export type SubmissionInput =
  | Readonly<{ kind: 'unchecked' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'valid'; inputHash: string }>;

export type IntentRequest =
  | Readonly<{ kind: 'view' }>
  | Readonly<{ kind: 'submit'; input: SubmissionInput }>;

export type IntentErrorCode =
  | 'INVALID_CLOCK'
  | 'INTENT_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'INTENT_STATE_INVALID'
  | 'INTENT_EXPIRED'
  | 'CONTRACT_CHANGED'
  | 'QUOTE_CHANGED'
  | 'COMPLETED_INPUT_CONFLICT'
  | 'RESULT_EXPIRED';

export type IntentDecision =
  | Readonly<{ kind: 'error'; status: 404 | 409 | 410 | 500; code: IntentErrorCode }>
  | Readonly<{ kind: 'form'; status: 200 }>
  | Readonly<{ kind: 'invalid'; status: 422 }>
  | Readonly<{ kind: 'receipt'; status: 303; orderId: string }>
  | Readonly<{ kind: 'needs-input' }>
  | Readonly<{ kind: 'write-candidate'; requires: 'fresh-immediate-policy-grant-cas' }>;

const error = (status: 404 | 409 | 410 | 500, code: IntentErrorCode): IntentDecision => ({ kind: 'error', status, code });
const epoch = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** intent-state/2, copied from the design reference; inputs come from one scoped snapshot. */
export function decideIntent(
  snapshot: IntentSnapshot | null,
  request: IntentRequest,
  now: number,
  currentBehaviorHash: string,
): IntentDecision {
  if (!epoch(now)) return error(500, 'INVALID_CLOCK');
  if (snapshot === null) return error(410, 'INTENT_UNAVAILABLE');
  const state = snapshot;
  if (!state.currentAuthorized) return error(404, 'NOT_FOUND');
  if (!epoch(state.issuedAt) || !epoch(state.expiresAt) || state.expiresAt <= state.issuedAt) {
    return error(500, 'INTENT_STATE_INVALID');
  }
  const result = state.result;
  if (state.consumedAt === null) {
    if (result !== null || state.draftId !== null) return error(500, 'INTENT_STATE_INVALID');
    if (now >= state.expiresAt) return error(410, 'INTENT_EXPIRED');
    if (state.behaviorHash !== currentBehaviorHash) return error(409, 'CONTRACT_CHANGED');
    if (!state.resourceRevisionMatches) return error(409, 'QUOTE_CHANGED');
    if (request.kind === 'view') return { kind: 'form', status: 200 };
    if (request.input.kind === 'unchecked') return { kind: 'needs-input' };
    if (request.input.kind === 'invalid') return { kind: 'invalid', status: 422 };
    return { kind: 'write-candidate', requires: 'fresh-immediate-policy-grant-cas' };
  }
  if (
    !epoch(state.consumedAt) ||
    state.consumedAt < state.issuedAt ||
    state.consumedAt >= state.expiresAt ||
    result === null ||
    state.draftId !== result.orderId ||
    result.behaviorHash !== state.behaviorHash ||
    result.completedAt !== state.consumedAt ||
    !epoch(result.expiresAt) ||
    result.expiresAt <= result.completedAt
  ) {
    return error(500, 'INTENT_STATE_INVALID');
  }
  if (now >= result.expiresAt) return error(410, 'RESULT_EXPIRED');
  if (request.kind === 'view') return { kind: 'receipt', status: 303, orderId: result.orderId };
  if (state.behaviorHash !== currentBehaviorHash) return error(409, 'CONTRACT_CHANGED');
  if (request.input.kind === 'unchecked') return { kind: 'needs-input' };
  if (request.input.kind === 'invalid' || request.input.inputHash !== result.inputHash) {
    return error(409, 'COMPLETED_INPUT_CONFLICT');
  }
  return { kind: 'receipt', status: 303, orderId: result.orderId };
}
