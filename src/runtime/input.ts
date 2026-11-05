import type { FieldSchema, InputContract, ObjectSchema } from '../contract/types.ts';
import { canonicalInput, decimalInteger, WireError } from './wire.ts';
import { sha256Hex } from '../contract/behavior.ts';

export interface InputIssue {
  readonly field: string | null;
  readonly code: string;
  readonly message: string;
}

export type InputValidation =
  | Readonly<{
      ok: true;
      value: Readonly<Record<string, string | number>>;
      raw: Readonly<Record<string, string>>;
    }>
  | Readonly<{ ok: false; issues: readonly InputIssue[]; unknownKeys: readonly string[] }>;

function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length++;
  return length;
}

function validateField(field: string, schema: FieldSchema, raw: string): string | number | InputIssue {
  if (schema.type === 'string') {
    const value = raw;
    const length = codePointLength(value);
    if (schema.minLength !== undefined && length < schema.minLength) {
      return { field, code: 'MIN_LENGTH', message: `${field} must be at least ${schema.minLength} characters` };
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      return { field, code: 'MAX_LENGTH', message: `${field} must be at most ${schema.maxLength} characters` };
    }
    if (schema.const !== undefined && value !== schema.const) {
      return { field, code: 'CONST', message: `${field} must be ${JSON.stringify(schema.const)}` };
    }
    if (schema.enum !== undefined && !schema.enum.includes(value)) {
      return { field, code: 'ENUM', message: `${field} is not an allowed value` };
    }
    if (schema.pattern !== undefined) {
      let expression: RegExp;
      try {
        expression = new RegExp(schema.pattern, 'u');
      } catch {
        return { field, code: 'PATTERN_UNSUPPORTED', message: `${field} has an unsupported pattern` };
      }
      if (!expression.test(value)) {
        return { field, code: 'PATTERN', message: `${field} does not match the required pattern` };
      }
    }
    return value;
  }

  let integer: number;
  try {
    integer = decimalInteger(raw);
  } catch (error) {
    if (error instanceof WireError) {
      return { field, code: error.code, message: `${field} must be a decimal integer` };
    }
    throw error;
  }
  if (schema.minimum !== undefined && integer < schema.minimum) {
    return { field, code: 'MINIMUM', message: `${field} must be at least ${schema.minimum}` };
  }
  if (schema.maximum !== undefined && integer > schema.maximum) {
    return { field, code: 'MAXIMUM', message: `${field} must be at most ${schema.maximum}` };
  }
  if (schema.const !== undefined && integer !== schema.const) {
    return { field, code: 'CONST', message: `${field} must be ${schema.const}` };
  }
  if (schema.enum !== undefined && !schema.enum.includes(integer)) {
    return { field, code: 'ENUM', message: `${field} is not an allowed value` };
  }
  return integer;
}

function isIssue(value: unknown): value is InputIssue {
  return typeof value === 'object' && value !== null && 'code' in value && 'field' in value;
}

export function validateBusinessInput(input: InputContract, fields: Readonly<Record<string, string>>): InputValidation {
  const issues: InputIssue[] = [];
  const unknownKeys: string[] = [];
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(input.schema.properties, key)) unknownKeys.push(key);
  }
  if (unknownKeys.length > 0) {
    return { ok: false, issues: [], unknownKeys };
  }
  const value: Record<string, string | number> = Object.create(null);
  for (const key of input.schema.required) {
    if (!Object.hasOwn(fields, key)) {
      issues.push({ field: key, code: 'REQUIRED', message: `${key} is required` });
    }
  }
  for (const key of Object.keys(input.schema.properties)) {
    if (!Object.hasOwn(fields, key)) continue;
    const schema = input.schema.properties[key]!;
    const result = validateField(key, schema, fields[key]!);
    if (isIssue(result)) issues.push(result);
    else value[key] = result;
  }
  const raw: Record<string, string> = Object.create(null);
  for (const key of Object.keys(value)) raw[key] = fields[key]!;
  if (issues.length > 0) return { ok: false, issues, unknownKeys: [] };
  return { ok: true, value: Object.freeze(value), raw: Object.freeze(raw) };
}

export function hashValidatedInput(value: Readonly<Record<string, string | number>>): string {
  return sha256Hex(new TextEncoder().encode(canonicalInput(value)));
}

export function schemaFields(schema: ObjectSchema): readonly string[] {
  return Object.freeze(Object.keys(schema.properties));
}
