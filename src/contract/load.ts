import { readFile } from 'node:fs/promises';
import { computeBehaviorSha256, sourceSha256 as sourceHash } from './behavior.ts';
import { decodeStrictJson, type JsonObject, type JsonValue } from './strict-json.ts';
import { validateBoundaryContract, validateFormCheck } from './validate.ts';
import type {
  BoundaryContract,
  FormCheck,
  LoadedBoundaryContract,
  LoadedFormCheck,
} from './types.ts';

function asObject(value: JsonValue): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('contract document must be a JSON object');
  }
  return value;
}

export async function loadBoundaryContract(path: string): Promise<LoadedBoundaryContract> {
  const bytes = await readFile(path);
  const value = asObject(decodeStrictJson(bytes));
  const contract: BoundaryContract = validateBoundaryContract(value);
  return {
    contract,
    value,
    sourceSha256: sourceHash(bytes),
    behaviorSha256: computeBehaviorSha256(value),
  };
}

export async function loadFormCheck(path: string): Promise<LoadedFormCheck> {
  const bytes = await readFile(path);
  const value = asObject(decodeStrictJson(bytes));
  const formCheck: FormCheck = validateFormCheck(value);
  return { formCheck, value };
}
