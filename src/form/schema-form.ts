import { defineForm } from './definition.ts';
import { createBoundaryHandler, type BoundaryHooks, type RawFormValues } from './boundary.ts';
import { decodeFormFields, prepareFields, type FormFields } from './fields.ts';
import { readUrlEncodedEntries, WireError, type FormReadLimits, type FormEntry } from '../runtime/wire.ts';
import { validateStandard, standardIssuesToInputIssues, type AnyStandardSchema, type InferStandardOutput } from './standard-schema.ts';
import { renderSchemaFormErrors } from './schema-html.ts';
import type { FormStateOptions } from './state.ts';

export interface SchemaFormDefinition<Fields extends FormFields, Input extends AnyStandardSchema, Output extends AnyStandardSchema> {
  readonly id: string;
  readonly path: string;
  /** Explicit wire allowlist/codecs: validators cannot silently strip unknown request keys. */
  readonly fields: Fields;
  readonly input: Input;
  readonly output: Output;
  readonly limits?: Partial<FormReadLimits>;
  readonly validationTimeoutMs?: number;
  readonly protocol?: Readonly<{ requestKey: 'required' }>;
}
export interface DefinedSchemaForm<Fields extends FormFields = FormFields, Input extends AnyStandardSchema = AnyStandardSchema, Output extends AnyStandardSchema = AnyStandardSchema> {
  readonly kind: 'typehtml-schema-form/1';
  readonly id: string;
  readonly path: string;
  readonly fields: Fields;
  readonly input: Input;
  readonly output: Output;
  readonly limits: Required<FormReadLimits>;
  readonly validationTimeoutMs: number;
  readonly protocol?: Readonly<{ requestKey: 'required' }>;
  /** External refinements/transforms are never represented as static Doctor proof. */
  readonly runtimeValidationCoverage: 'not-statically-analyzed';
}
export type SchemaFormInput<Form extends DefinedSchemaForm> = InferStandardOutput<Form['input']>;
export type SchemaFormOutput<Form extends DefinedSchemaForm> = InferStandardOutput<Form['output']>;
export interface SchemaFormHandlerOptions<Input, Output, Principal extends object, Result>
  extends BoundaryHooks<Input, Output, Principal, Result, RawFormValues> {
  readonly errors?: FormStateOptions & Readonly<{ title?: string; summaryTitle?: string; submitLabel?: string }>;
}

function captureSchema<Schema extends AnyStandardSchema>(schema: Schema): Schema {
  const props = schema?.['~standard'];
  if (props?.version !== 1 || typeof props.vendor !== 'string' || typeof props.validate !== 'function') throw new TypeError('expected a Standard Schema v1 validator');
  const validate = props.validate;
  return Object.freeze({ '~standard': Object.freeze({
    version: 1 as const, vendor: props.vendor,
    validate: (value: unknown, options?: Parameters<typeof validate>[1]) => Reflect.apply(validate, props, [value, options]),
  }) }) as Schema;
}

/** Rich forms are additive; defineForm's JSON-only analyzable profile is unchanged. */
export function defineSchemaForm<const Fields extends FormFields, Input extends AnyStandardSchema, Output extends AnyStandardSchema>(
  definition: SchemaFormDefinition<Fields, Input, Output>,
): DefinedSchemaForm<Fields, Input, Output> {
  // Reuse the existing canonical path, ID, and transport-limit validation.
  const marker = { type: 'object', additionalProperties: false, required: ['marker'], properties: { marker: { type: 'string' } } } as const;
  const base = defineForm({ id: definition.id, path: definition.path, input: marker, output: marker, ...(definition.limits === undefined ? {} : { limits: definition.limits }), ...(definition.protocol === undefined ? {} : { protocol: definition.protocol }) });
  const validationTimeoutMs = definition.validationTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(validationTimeoutMs) || validationTimeoutMs < 1 || validationTimeoutMs > 2_147_483_647) throw new TypeError('invalid validation timeout');
  return Object.freeze({
    kind: 'typehtml-schema-form/1', id: base.id, path: base.path,
    fields: prepareFields(definition.fields) as Fields,
    input: captureSchema(definition.input), output: captureSchema(definition.output), limits: base.limits,
    validationTimeoutMs, runtimeValidationCoverage: 'not-statically-analyzed',
    ...(base.definition.protocol === undefined ? {} : { protocol: base.definition.protocol }),
  });
}

export function createSchemaFormHandler<Fields extends FormFields, Input extends AnyStandardSchema, Output extends AnyStandardSchema, Principal extends object, Result>(
  form: DefinedSchemaForm<Fields, Input, Output>, options: SchemaFormHandlerOptions<InferStandardOutput<Input>, InferStandardOutput<Output>, Principal, Result>,
): (request: Request) => Promise<Response> {
  const names = Object.freeze(Object.keys(form.fields));
  const repeatable = Object.freeze(names.filter((name) => form.fields[name]!.type === 'array'));
  if (form.protocol?.requestKey === 'required' && options.acceptRequestKey === false) throw new TypeError('handler cannot disable the declared request key');
  const acceptRequestKey = options.acceptRequestKey === true || form.protocol?.requestKey === 'required';
  // Snapshot localization config, preserving callback functions but never freezing caller state.
  const errors = options.errors === undefined ? undefined : Object.freeze({ ...options.errors, messages: options.errors.messages === undefined ? undefined : Object.freeze({ ...options.errors.messages }) });
  return createBoundaryHandler({
    path: form.path, limits: form.limits,
    read: async (request) => {
      const entries = await readUrlEncodedEntries(request, form.limits, {}, { names, repeatable });
      let csrf: string | undefined;
      let requestKey: string | undefined;
      const business: FormEntry[] = [];
      for (const entry of entries) {
        if (entry.key === '_bc_csrf') { csrf = entry.value; continue; }
        if (entry.key === '_bc_request' && acceptRequestKey) { requestKey = entry.value; continue; }
        if (entry.key.startsWith('_')) throw new WireError(400, entry.key === '_bc_request' ? 'UNEXPECTED_REQUEST_KEY' : entry.key.startsWith('_th_') ? 'LEGACY_PROTOCOL_KEY' : 'UNKNOWN_RESERVED_KEY');
        business.push(entry);
      }
      if (csrf === undefined) throw new WireError(400, 'MISSING_CSRF');
      if (acceptRequestKey && requestKey === undefined) throw new WireError(400, 'MISSING_REQUEST_KEY');
      if (requestKey !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(requestKey)) throw new WireError(400, 'INVALID_REQUEST_KEY');
      const raw: Record<string, string | readonly string[]> = Object.create(null);
      for (const entry of business) {
        if (!Object.hasOwn(form.fields, entry.key)) continue;
        if (form.fields[entry.key]!.type === 'array') {
          const values = raw[entry.key] as string[] | undefined;
          if (values === undefined) raw[entry.key] = [entry.value]; else values.push(entry.value);
        } else raw[entry.key] = entry.value;
      }
      for (const value of Object.values(raw)) if (Array.isArray(value)) Object.freeze(value);
      return { csrf, raw: Object.freeze(raw), ...(requestKey === undefined ? {} : { requestKey }), validate: async () => {
        const decoded = decodeFormFields(form.fields, business);
        if (!decoded.validation.ok) return decoded.validation;
        const result = await validateStandard(form.input, decoded.validation.value, { signal: request.signal, timeoutMs: form.validationTimeoutMs });
        if (result.issues === undefined) return { ok: true as const, value: result.value };
        const issues = standardIssuesToInputIssues(result.issues).map((issue) => {
          const field = issue.field;
          if (field !== null && Object.hasOwn(form.fields, field)) return issue;
          // Repeated wire values use one name even when a validator reports an element index.
          const array = field?.replace(/\[[0-9]+\](?:\..*)?$/, '');
          if (array !== undefined && Object.hasOwn(form.fields, array) && form.fields[array]!.type === 'array') return { ...issue, field: array };
          return { ...issue, field: null };
        });
        return { ok: false as const, issues: Object.freeze(issues), unknownKeys: [] };
      } };
    },
    validateOutput: async (value, request) => {
      const result = await validateStandard(form.output, value, { signal: request.signal, timeoutMs: form.validationTimeoutMs });
      if (result.issues !== undefined) throw new TypeError('public projection failed Standard Schema validation');
      return result.value;
    },
    renderInvalid: (context) => renderSchemaFormErrors(form, context.rawValues, context.issues, context.csrfToken, errors, context.requestKey),
  }, options);
}
