import type { FieldSchema, InputContract, ObjectSchema } from '../contract/types.ts';
import { canonicalJson } from '../contract/canonical-json.ts';
import { sha256Hex } from '../contract/behavior.ts';
import { decodeStrictJson } from '../contract/strict-json.ts';
import { validateInputContract, validateObjectSchema } from '../contract/validate.ts';
import type { FormReadLimits } from '../runtime/wire.ts';

export const FORM_FORMAT = 'typehtml-form/1';

type Scalar<F extends FieldSchema> = F extends { readonly const: infer C extends string | number } ? C
  : F extends { readonly enum: readonly (infer E extends string | number)[] } ? E
  : F extends { readonly type: 'integer' } ? number : string;

/** Required keys and literal const/enum values are preserved from an inline schema. */
export type InferSchema<S extends ObjectSchema> = Readonly<{
  [K in keyof S['properties'] as K extends S['required'][number] ? K : never]: Scalar<S['properties'][K]>;
} & {
  [K in keyof S['properties'] as K extends S['required'][number] ? never : K]?: Scalar<S['properties'][K]>;
}>;

export interface FormDefinition<I extends ObjectSchema = ObjectSchema, O extends ObjectSchema = ObjectSchema> {
  readonly format?: typeof FORM_FORMAT;
  readonly id: string;
  readonly path: string;
  readonly input: I;
  readonly output: O;
  readonly limits?: Partial<FormReadLimits>;
  readonly protocol?: Readonly<{ requestKey: 'required' }>;
}

export interface DefinedForm<I extends ObjectSchema = ObjectSchema, O extends ObjectSchema = ObjectSchema> {
  readonly id: string;
  readonly path: string;
  readonly input: InputContract & { readonly schema: I };
  readonly output: O;
  readonly limits: Required<FormReadLimits>;
  readonly definition: FormDefinition<I, O> & { readonly format: typeof FORM_FORMAT; readonly limits: Required<FormReadLimits> };
  readonly behaviorSha256: string;
}

export type InferInput<F extends DefinedForm> = InferSchema<F['input']['schema']>;
export type InferOutput<F extends DefinedForm> = InferSchema<F['output']>;

function freezeData<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

const LIMITS: Required<FormReadLimits> = {
  maxBytes: 16_384, maxEntries: 16, maxKeyBytes: 64, maxValueBytes: 1_024, readTimeoutMs: 30_000,
};

/** Define one flat native HTML form. This does not create a server, database, or transaction. */
export function defineForm<const I extends ObjectSchema, const O extends ObjectSchema>(
  definition: FormDefinition<I, O>,
): DefinedForm<I, O> {
  const data = decodeStrictJson(canonicalJson(definition), { integerOnly: true }) as unknown as FormDefinition<I, O>;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('form definition must be an object');
  for (const key of Object.keys(data)) {
    if (!['format', 'id', 'path', 'input', 'output', 'limits', 'protocol'].includes(key)) throw new TypeError(`unknown form definition field: ${key}`);
  }
  if (data.format !== undefined && data.format !== FORM_FORMAT) throw new TypeError('unsupported form format');
  if (data.protocol !== undefined && (data.protocol === null || typeof data.protocol !== 'object' || Array.isArray(data.protocol) || Object.keys(data.protocol).length !== 1 || data.protocol.requestKey !== 'required')) throw new TypeError('unsupported form protocol');
  if (typeof data.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(data.id)) throw new TypeError('form id must be a stable identifier');
  if (typeof data.path !== 'string' || !data.path.startsWith('/') || data.path.startsWith('//') || /[\s\\?#:*{}]/.test(data.path) || /%(?:2f|5c)/i.test(data.path)) {
    throw new TypeError('form path must be a fixed canonical absolute path');
  }
  const path = new URL(data.path, 'http://form.invalid');
  if (path.origin !== 'http://form.invalid' || path.pathname !== data.path) throw new TypeError('form path must be canonical');
  const schema = validateObjectSchema(data.input, '/input') as I;
  const output = validateObjectSchema(data.output, '/output') as O;
  const codecs: Record<string, 'text' | 'decimal-integer'> = Object.create(null);
  for (const [name, field] of Object.entries(schema.properties)) {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new TypeError(`input field is reserved: ${name}`);
    codecs[name] = field.type === 'integer' ? 'decimal-integer' : 'text';
  }
  const input = validateInputContract({
    schema, codecs, unknownKeys: 'reject', duplicateScalars: 'reject', scalarSemantics: {
      missing: 'absent', emptyString: 'preserve', textNormalization: 'none',
      schemaStringLength: 'unicode-code-points', validationMutatesData: false,
    },
  }) as InputContract & { readonly schema: I };
  if (data.limits !== undefined && (data.limits === null || typeof data.limits !== 'object' || Array.isArray(data.limits))) {
    throw new TypeError('form limits must be an object');
  }
  const limits = { ...LIMITS, ...data.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(LIMITS, key) || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`invalid form limit: ${key}`);
  }
  const normalized = freezeData({ format: FORM_FORMAT, id: data.id, path: data.path, input: schema, output, limits, ...(data.protocol === undefined ? {} : { protocol: data.protocol }) } as const);
  return freezeData({
    id: data.id, path: data.path, input, output, limits, definition: normalized,
    behaviorSha256: sha256Hex(new TextEncoder().encode(canonicalJson(normalized))),
  });
}
