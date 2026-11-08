import { defineForm } from './definition.ts';
import { createBoundaryHandler, type BoundaryHooks, type RawFormValues } from './boundary.ts';
import type { FormFields } from './fields.ts';
import { prepareFormTransport } from './transport.ts';
import type { FormCollections } from './collections.ts';
import type { FormReadLimits } from '../runtime/wire.ts';
import { validateStandard, type AnyStandardSchema, type InferStandardInput, type InferStandardOutput } from './standard-schema.ts';
import { assertUploadDomains, prepareUploadFields, type UploadFields } from './uploads.ts';
import { assertMultipartTransport, prepareMultipartLimits, type MultipartLimits } from './multipart.ts';
import type { TemporaryUploadStore } from './upload-storage.ts';
import { readSchemaRequest } from './schema-request.ts';
import { renderSchemaFormErrors } from './schema-html.ts';
import type { FormStateOptions } from './state.ts';

export interface SchemaFormDefinition<Fields extends FormFields, Input extends AnyStandardSchema, Output extends AnyStandardSchema, Collections extends FormCollections = FormCollections, Uploads extends UploadFields = UploadFields> {
  readonly id: string;
  readonly path: string;
  /** Explicit wire allowlist/codecs: validators cannot silently strip unknown request keys. */
  readonly fields: Fields;
  readonly collections?: Collections;
  readonly uploads?: Uploads;
  /** Explicit opt-in; URL-encoded forms retain their existing limits and transport. */
  readonly multipart?: Partial<MultipartLimits>;
  readonly input: Input;
  readonly output: Output;
  readonly limits?: Partial<FormReadLimits>;
  readonly validationTimeoutMs?: number;
  readonly protocol?: Readonly<{ requestKey: 'required' }>;
}
export interface DefinedSchemaForm<Fields extends FormFields = FormFields, Input extends AnyStandardSchema = AnyStandardSchema, Output extends AnyStandardSchema = AnyStandardSchema, Collections extends FormCollections = FormCollections, Uploads extends UploadFields = UploadFields> {
  readonly kind: 'typehtml-schema-form/1';
  readonly id: string;
  readonly path: string;
  readonly fields: Fields;
  readonly collections: Collections;
  readonly uploads: Uploads;
  readonly multipart?: MultipartLimits;
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
export interface SchemaFormHandlerOptions<Input, Output, Principal extends object, Result, Projected = Output>
  extends BoundaryHooks<Input, Output, Principal, Result, RawFormValues, Projected> {
  readonly errors?: FormStateOptions & Readonly<{ title?: string; summaryTitle?: string; submitLabel?: string }>;
  readonly uploadStore?: TemporaryUploadStore;
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
export function defineSchemaForm<const Fields extends FormFields, Input extends AnyStandardSchema, Output extends AnyStandardSchema, const Collections extends FormCollections = Readonly<Record<never, never>>, const Uploads extends UploadFields = Readonly<Record<never, never>>>(
  definition: SchemaFormDefinition<Fields, Input, Output, Collections, Uploads>,
): DefinedSchemaForm<Fields, Input, Output, Collections, Uploads> {
  // Reuse the existing canonical path, ID, and transport-limit validation.
  const marker = { type: 'object', additionalProperties: false, required: ['marker'], properties: { marker: { type: 'string' } } } as const;
  const base = defineForm({ id: definition.id, path: definition.path, input: marker, output: marker, ...(definition.limits === undefined ? {} : { limits: definition.limits }), ...(definition.protocol === undefined ? {} : { protocol: definition.protocol }) });
  const validationTimeoutMs = definition.validationTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(validationTimeoutMs) || validationTimeoutMs < 1 || validationTimeoutMs > 2_147_483_647) throw new TypeError('invalid validation timeout');
  const uploads = prepareUploadFields(definition.uploads);
  if (Object.keys(uploads).length > 0 && definition.multipart === undefined) throw new TypeError('uploads require explicit multipart configuration');
  const multipart = definition.multipart === undefined ? undefined : prepareMultipartLimits(definition.multipart);
  const transport = prepareFormTransport(definition.fields, definition.collections, { allowEmpty: Object.keys(uploads).length > 0 });
  assertUploadDomains(transport, uploads);
  return Object.freeze({
    kind: 'typehtml-schema-form/1', id: base.id, path: base.path,
    fields: transport.fixedDeclarations as Fields, collections: transport.collections as unknown as Collections,
    uploads: uploads as unknown as Uploads, ...(multipart === undefined ? {} : { multipart }),
    input: captureSchema(definition.input), output: captureSchema(definition.output), limits: base.limits,
    validationTimeoutMs, runtimeValidationCoverage: 'not-statically-analyzed',
    ...(base.definition.protocol === undefined ? {} : { protocol: base.definition.protocol }),
  });
}

export function createSchemaFormHandler<Fields extends FormFields, Input extends AnyStandardSchema, Output extends AnyStandardSchema, Principal extends object, Result>(
  form: DefinedSchemaForm<Fields, Input, Output>, options: SchemaFormHandlerOptions<InferStandardOutput<Input>, InferStandardOutput<Output>, Principal, Result, InferStandardInput<Output>>,
): (request: Request) => Promise<Response> {
  if (form.protocol?.requestKey === 'required' && options.acceptRequestKey === false) throw new TypeError('handler cannot disable the declared request key');
  const acceptRequestKey = options.acceptRequestKey === true || form.protocol?.requestKey === 'required';
  // Snapshot localization config, preserving callback functions but never freezing caller state.
  const errors = options.errors === undefined ? undefined : Object.freeze({ ...options.errors, messages: options.errors.messages === undefined ? undefined : Object.freeze({ ...options.errors.messages }) });
  const providedStore = options.uploadStore;
  const open = providedStore?.open;
  if (providedStore !== undefined && typeof open !== 'function') throw new TypeError('uploadStore must implement open');
  const uploadStore = providedStore === undefined ? undefined : Object.freeze({ open: (metadata: Parameters<TemporaryUploadStore['open']>[0], signal: AbortSignal) => Reflect.apply(open!, providedStore, [metadata, signal]) });
  return createBoundaryHandler({
    path: form.path, limits: form.limits,
    ...(form.multipart === undefined ? {} : { assertTransport: (request: Request) => assertMultipartTransport(request, form.multipart!) }),
    read: (request) => readSchemaRequest(form, request, acceptRequestKey, uploadStore),
    validateOutput: async (value, request) => {
      const result = await validateStandard(form.output, value, { signal: request.signal, timeoutMs: form.validationTimeoutMs });
      if (result.issues !== undefined) throw new TypeError('public projection failed Standard Schema validation');
      return result.value;
    },
    renderInvalid: (context) => renderSchemaFormErrors(form, context.rawValues, context.issues, context.csrfToken, errors, context.requestKey),
  }, options);
}
