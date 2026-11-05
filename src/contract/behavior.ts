import { createHash } from 'node:crypto';
import type { JsonObject, JsonValue } from './strict-json.ts';
import { canonicalJson } from './canonical-json.ts';

export const BEHAVIOR_DIGEST_PROFILE = 'boundary-behavior/1';

/** Fields included in boundary-behavior/1, in the order documented by v0.5. */
export const BEHAVIOR_FIELDS = Object.freeze([
  'id',
  'operationRevision',
  'operation',
  'http',
  'protocol',
  'input',
  'serverOwnedFields',
  'guards',
  'output',
  'response',
] as const);

export type BehaviorField = (typeof BEHAVIOR_FIELDS)[number];

export class BehaviorDigestError extends Error {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = 'BehaviorDigestError';
    this.field = field;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sourceSha256(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

export function behaviorProjection(contract: JsonObject): JsonObject {
  const selected: Record<string, JsonValue> = Object.create(null);
  for (const field of BEHAVIOR_FIELDS) {
    if (!Object.hasOwn(contract, field)) {
      throw new BehaviorDigestError(`missing behavior field: ${field}`, field);
    }
    selected[field] = contract[field]!;
  }
  return { profile: BEHAVIOR_DIGEST_PROFILE, contract: selected };
}

export function computeBehaviorSha256(contract: JsonObject): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(behaviorProjection(contract))));
}
