import { describe, expect, test } from 'bun:test';
import { decideIntent, type IntentSnapshot } from '../../src/runtime/intent.ts';

const behavior = 'b'.repeat(64);
const base: IntentSnapshot = {
  intentId: 'intent_1',
  behaviorHash: behavior,
  issuedAt: 100,
  expiresAt: 200,
  consumedAt: null,
  draftId: null,
  result: null,
  currentAuthorized: true,
  resourceRevisionMatches: true,
};

describe('intent-state/2', () => {
  test('OPEN view and invalid branches', () => {
    expect(decideIntent(base, { kind: 'view' }, 150, behavior)).toEqual({ kind: 'form', status: 200 });
    expect(decideIntent(base, { kind: 'submit', input: { kind: 'invalid' } }, 150, behavior)).toEqual({
      kind: 'invalid',
      status: 422,
    });
    expect(decideIntent(base, { kind: 'submit', input: { kind: 'unchecked' } }, 150, behavior)).toEqual({
      kind: 'needs-input',
    });
    expect(decideIntent(base, { kind: 'submit', input: { kind: 'valid', inputHash: 'a'.repeat(64) } }, 150, behavior)).toMatchObject({
      kind: 'write-candidate',
    });
  });

  test('expiry, contract, revision, authorization, and missing precedence', () => {
    expect(decideIntent(base, { kind: 'view' }, 200, behavior)).toMatchObject({ status: 410, code: 'INTENT_EXPIRED' });
    expect(decideIntent(base, { kind: 'view' }, 150, 'c'.repeat(64))).toMatchObject({ status: 409, code: 'CONTRACT_CHANGED' });
    expect(decideIntent({ ...base, resourceRevisionMatches: false }, { kind: 'view' }, 150, behavior)).toMatchObject({
      status: 409,
      code: 'QUOTE_CHANGED',
    });
    expect(decideIntent({ ...base, currentAuthorized: false }, { kind: 'view' }, 150, behavior)).toMatchObject({
      status: 404,
    });
    expect(decideIntent(null, { kind: 'view' }, 150, behavior)).toMatchObject({ status: 410 });
  });

  test('COMMITTED replay accepts the same hash and rejects different or invalid input', () => {
    const inputHash = 'a'.repeat(64);
    const committed: IntentSnapshot = {
      ...base,
      consumedAt: 120,
      draftId: 'order_1',
      result: { orderId: 'order_1', behaviorHash: behavior, inputHash, completedAt: 120, expiresAt: 300 },
    };
    expect(decideIntent(committed, { kind: 'view' }, 150, behavior)).toEqual({ kind: 'receipt', status: 303, orderId: 'order_1' });
    expect(decideIntent(committed, { kind: 'submit', input: { kind: 'valid', inputHash } }, 150, behavior)).toEqual({
      kind: 'receipt',
      status: 303,
      orderId: 'order_1',
    });
    expect(decideIntent(committed, { kind: 'submit', input: { kind: 'valid', inputHash: 'c'.repeat(64) } }, 150, behavior)).toMatchObject({
      status: 409,
      code: 'COMPLETED_INPUT_CONFLICT',
    });
    expect(decideIntent(committed, { kind: 'submit', input: { kind: 'invalid' } }, 150, behavior)).toMatchObject({ status: 409 });
    expect(decideIntent(committed, { kind: 'view' }, 300, behavior)).toMatchObject({ status: 410, code: 'RESULT_EXPIRED' });
  });

  test('rejects corrupted consumed state instead of treating it as OPEN', () => {
    const corrupted: IntentSnapshot = { ...base, consumedAt: 120, draftId: 'order_1', result: null };
    expect(decideIntent(corrupted, { kind: 'view' }, 150, behavior)).toMatchObject({ status: 500, code: 'INTENT_STATE_INVALID' });
  });
});
