import type { ObjectSchema } from '../contract/types.ts';

export class OutputValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'OutputValidationError';
    this.path = path;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codePointLengthUpTo(value: string, limit: number): number {
  let length = 0;
  if (limit === 0) return length;
  for (const _ of value) {
    if (++length >= limit) break;
  }
  return length;
}

/** Validates the public projection before it leaves the transaction boundary. */
export function validateOutputObject(
  schema: ObjectSchema,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!isObject(value)) throw new OutputValidationError('$', 'must be an object');
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new OutputValidationError('$', 'symbol keys are unsupported');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new OutputValidationError(`$.${key}`, 'must be an own data property');
    }
    snapshot[key] = descriptor.value;
  }
  const keys = Object.keys(snapshot);
  for (const key of keys) {
    if (!Object.hasOwn(schema.properties, key)) throw new OutputValidationError(`$.${key}`, 'unknown key');
  }
  for (const key of schema.required) {
    if (!Object.hasOwn(snapshot, key)) throw new OutputValidationError(`$.${key}`, 'required');
  }
  for (const [key, field] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(snapshot, key)) continue;
    const item = snapshot[key];
    const path = `$.${key}`;
    if (field.type === 'string') {
      if (typeof item !== 'string') throw new OutputValidationError(path, 'must be a string');
      // Count only enough to decide both bounds, retaining minimum-before-maximum errors.
      const countLimit = Math.max(field.minLength ?? 0, field.maxLength === undefined ? 0 : field.maxLength + 1);
      const length = codePointLengthUpTo(item, countLimit);
      if (field.minLength !== undefined && length < field.minLength) {
        throw new OutputValidationError(path, `must be at least ${field.minLength} characters`);
      }
      if (field.maxLength !== undefined && length > field.maxLength) {
        throw new OutputValidationError(path, `must be at most ${field.maxLength} characters`);
      }
      if (field.const !== undefined && item !== field.const) throw new OutputValidationError(path, 'const mismatch');
      if (field.enum !== undefined && !field.enum.includes(item)) throw new OutputValidationError(path, 'enum mismatch');
      if (field.pattern !== undefined && !new RegExp(field.pattern, 'u').test(item)) {
        throw new OutputValidationError(path, 'pattern mismatch');
      }
    } else {
      if (typeof item !== 'number' || !Number.isSafeInteger(item)) {
        throw new OutputValidationError(path, 'must be a safe integer');
      }
      if (field.minimum !== undefined && item < field.minimum) throw new OutputValidationError(path, 'below minimum');
      if (field.maximum !== undefined && item > field.maximum) throw new OutputValidationError(path, 'above maximum');
      if (field.const !== undefined && item !== field.const) throw new OutputValidationError(path, 'const mismatch');
      if (field.enum !== undefined && !field.enum.includes(item)) throw new OutputValidationError(path, 'enum mismatch');
    }
  }
  return Object.freeze(snapshot);
}
