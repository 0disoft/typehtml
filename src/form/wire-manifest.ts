import { canonicalJson } from '../contract/canonical-json.ts';
import { sha256Hex, sourceSha256 } from '../contract/behavior.ts';
import { ProjectionError, type ProjectionOptions } from '../contract/project.ts';
import { decodeStrictJson, readBoundedJsonBytes } from '../contract/strict-json.ts';
import { SUPPORTED_PARSER_PROFILE } from '../contract/types.ts';
import type { FormReadLimits } from '../runtime/wire.ts';
import { defineForm } from './definition.ts';
import type { FormFields } from './fields.ts';
import type { FormCollections, PreparedFormCollections } from './collections.ts';
import { prepareFormTransport, type PreparedFormTransport } from './transport.ts';
import { assertUploadDomains, prepareUploadFields, type UploadFields } from './uploads.ts';
import { prepareMultipartLimits, type MultipartLimits } from './multipart.ts';

export const WIRE_FORM_FORMAT = 'typehtml-wire-form/1';
export const RICH_FORM_CHECK_FORMAT = 'typehtml-form-check/1';

export interface WireFormDefinition {
  readonly format?: typeof WIRE_FORM_FORMAT;
  readonly id: string;
  readonly path: string;
  readonly fields: FormFields;
  readonly collections?: FormCollections;
  readonly uploads?: UploadFields;
  readonly multipart?: Partial<MultipartLimits>;
  readonly limits?: Partial<FormReadLimits>;
  readonly protocol?: Readonly<{ requestKey: 'required' }>;
}

export interface DefinedWireForm {
  readonly id: string;
  readonly path: string;
  readonly definition: WireFormDefinition & Readonly<{
    format: typeof WIRE_FORM_FORMAT;
    limits: Required<FormReadLimits>;
    multipart?: MultipartLimits;
  }>;
  readonly prepared: PreparedFormTransport;
  readonly behaviorSha256: string;
}

/** The lookup index is regenerated, not duplicated or trusted in JSON artifacts. */
export type TransportProjection = Omit<PreparedFormTransport, 'byName'>;
const preparedChecks = new WeakMap<RichFormCheck, PreparedFormTransport>();

export interface RichFormCheck {
  readonly format: typeof RICH_FORM_CHECK_FORMAT;
  readonly status: 'generated';
  readonly source: Readonly<{
    path: string; sha256: string; generator: string; behaviorSha256: string;
    projection: 'exact-for-declared-wire-fields'; runtimeCoverage: 'not-evaluated';
  }>;
  readonly action: Readonly<{
    id: string; method: 'POST'; path: string; encoding: 'urlencoded' | 'multipart';
    parserProfile: typeof SUPPORTED_PARSER_PROFILE | 'bounded-multipart/1';
  }>;
  readonly transport: TransportProjection;
  readonly limits: Required<FormReadLimits>;
  readonly uploads: UploadFields;
  readonly multipart?: MultipartLimits;
  readonly protocolFields: readonly string[];
  readonly runtimeValidationCoverage: 'not-statically-analyzed';
}

/** Inspect descriptors before reading configuration, including top-level options. */
function assertJsonData(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (typeof value !== 'object' || depth > 32) throw new TypeError('wire manifest must contain plain JSON data');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) throw new TypeError('wire manifest must contain plain objects');
  if (ancestors.has(value)) throw new TypeError('wire manifest must not contain cycles');
  ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('wire manifest must not contain symbol keys');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor) || (!descriptor.enumerable && !(array && key === 'length'))) throw new TypeError('wire manifest must contain enumerable data properties');
      assertJsonData(descriptor.value, ancestors, depth + 1);
    }
  } finally { ancestors.delete(value); }
}

function freezeData<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Static wire declarations only: no validators, output schema or application imports. */
export function defineWireForm(definition: WireFormDefinition): DefinedWireForm {
  assertJsonData(definition);
  const data = record(definition, 'wire manifest');
  for (const key of Object.keys(data)) if (!['format', 'id', 'path', 'fields', 'collections', 'uploads', 'multipart', 'limits', 'protocol'].includes(key)) throw new TypeError(`unknown wire manifest option: ${key}`);
  if (data.format !== undefined && data.format !== WIRE_FORM_FORMAT) throw new TypeError('unsupported wire manifest format');
  const uploads = prepareUploadFields(definition.uploads);
  if (Object.keys(uploads).length > 0 && definition.multipart === undefined) throw new TypeError('uploads require explicit multipart limits');
  const multipart = definition.multipart === undefined ? undefined : prepareMultipartLimits(definition.multipart);
  const prepared = prepareFormTransport(definition.fields, definition.collections, { allowEmpty: Object.keys(uploads).length > 0 });
  assertUploadDomains(prepared, uploads);
  // Reuse canonical identity/limit validation without exposing or inventing a public output schema.
  const marker = { type: 'object', additionalProperties: false, required: [], properties: { marker: { type: 'string' } } } as const;
  const base = defineForm({ id: definition.id, path: definition.path, input: marker, output: marker,
    ...(definition.limits === undefined ? {} : { limits: definition.limits }),
    ...(definition.protocol === undefined ? {} : { protocol: definition.protocol }),
  });
  const normalized = freezeData({
    format: WIRE_FORM_FORMAT, id: base.id, path: base.path, fields: prepared.fixedDeclarations,
    ...(Object.keys(prepared.collections).length === 0 ? {} : { collections: collectionDefinitions(prepared.collections) }),
    limits: base.limits,
    ...(Object.keys(uploads).length === 0 ? {} : { uploads }),
    ...(multipart === undefined ? {} : { multipart }),
    ...(base.definition.protocol === undefined ? {} : { protocol: base.definition.protocol }),
  } as const);
  return Object.freeze({ id: base.id, path: base.path, definition: normalized, prepared,
    behaviorSha256: sha256Hex(new TextEncoder().encode(canonicalJson(normalized))),
  });
}

/** Pick only public wire data; opaque Standard Schema validators are never inspected or called. */
export function schemaFormWireManifest(form: Readonly<{
  id: string; path: string; fields: FormFields; limits?: Partial<FormReadLimits>;
  collections?: FormCollections;
  uploads?: UploadFields; multipart?: Partial<MultipartLimits>;
  protocol?: Readonly<{ requestKey: 'required' }>;
}>): DefinedWireForm['definition'] {
  const selected: Record<string, unknown> = Object.create(null);
  for (const key of ['id', 'path', 'fields', 'collections', 'uploads', 'multipart', 'limits', 'protocol'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(form, key);
    if (descriptor === undefined) continue;
    if (!('value' in descriptor)) throw new TypeError('wire source must contain data properties');
    if (descriptor.value !== undefined) {
      if (key === 'collections') {
        assertJsonData(descriptor.value);
        for (const group of Object.values(record(descriptor.value, 'collections'))) {
          const options = record(group, 'collection');
          if (Object.keys(options).some((option) => !['minItems', 'maxItems', 'rowKey', 'fields', 'path'].includes(option))) throw new TypeError('unknown collection option');
        }
        selected[key] = collectionDefinitions(descriptor.value as PreparedFormCollections);
      } else selected[key] = descriptor.value;
    }
  }
  return defineWireForm(selected as unknown as WireFormDefinition).definition;
}

export async function loadWireForm(path: string): Promise<Readonly<{ form: DefinedWireForm; sourceSha256: string }>> {
  const bytes = await readBoundedJsonBytes(path);
  const data = record(decodeStrictJson(bytes, { integerOnly: true }), 'wire manifest');
  if (data.format !== WIRE_FORM_FORMAT) throw new TypeError(`expected a ${WIRE_FORM_FORMAT} manifest`);
  return Object.freeze({ form: defineWireForm(data as unknown as WireFormDefinition), sourceSha256: sourceSha256(bytes) });
}

export function projectWireForm(form: DefinedWireForm, options: ProjectionOptions): RichFormCheck {
  assertJsonData(options);
  if (!/^[a-f0-9]{64}$/.test(options.sourceSha256)) throw new TypeError('sourceSha256 must be a SHA-256 hex digest');
  if (typeof options.sourcePath !== 'string' || options.sourcePath.length === 0 || /[\r\n\u2028\u2029]/.test(options.sourcePath)) throw new TypeError('sourcePath must be a non-empty single-line path');
  if (options.generator !== undefined && (typeof options.generator !== 'string' || options.generator.length === 0 || /[\r\n\u2028\u2029]/.test(options.generator))) throw new TypeError('generator must be a non-empty single-line identifier');
  const { byName: _index, ...transport } = form.prepared;
  const check = freezeData({
    format: RICH_FORM_CHECK_FORMAT, status: 'generated',
    source: { path: options.sourcePath, sha256: options.sourceSha256,
      generator: options.generator ?? '@0disoft/typehtml/wire-projection', behaviorSha256: form.behaviorSha256,
      projection: 'exact-for-declared-wire-fields', runtimeCoverage: 'not-evaluated',
    },
    action: { id: form.id, method: 'POST', path: form.path,
      encoding: form.definition.multipart === undefined ? 'urlencoded' : 'multipart',
      parserProfile: form.definition.multipart === undefined ? SUPPORTED_PARSER_PROFILE : 'bounded-multipart/1',
    },
    transport, limits: form.definition.limits, uploads: form.definition.uploads ?? {},
    ...(form.definition.multipart === undefined ? {} : { multipart: form.definition.multipart }),
    protocolFields: form.definition.protocol?.requestKey === 'required' ? ['_bc_csrf', '_bc_request'] : ['_bc_csrf'],
    runtimeValidationCoverage: 'not-statically-analyzed',
  } as const);
  preparedChecks.set(check, form.prepared);
  return check;
}

function collectionDefinitions(collections: PreparedFormCollections): FormCollections {
  const definitions: Record<string, FormCollections[string]> = Object.create(null);
  for (const [name, group] of Object.entries(collections)) {
    definitions[name] = { ...(group.minItems === undefined ? {} : { minItems: group.minItems }), maxItems: group.maxItems, rowKey: group.rowKey, fields: group.fields };
  }
  return definitions;
}

/** Projection indexes are owned, bounded and rebuilt from declarations when needed. */
export function getRichFormTransport(check: RichFormCheck): PreparedFormTransport {
  const cached = preparedChecks.get(check);
  if (cached !== undefined) return cached;
  const prepared = prepareFormTransport(check.transport.fixedDeclarations, collectionDefinitions(check.transport.collections), { allowEmpty: Object.keys(check.uploads).length > 0 });
  assertUploadDomains(prepared, check.uploads);
  preparedChecks.set(check, prepared);
  return prepared;
}

export function verifyWireFormSource(check: RichFormCheck, loaded: Readonly<{ form: DefinedWireForm; sourceSha256: string }>): void {
  if (check.source.sha256 !== loaded.sourceSha256) throw new ProjectionError('/source/sha256', 'wire projection source bytes have changed');
  const expected = projectWireForm(loaded.form, { sourcePath: check.source.path, sourceSha256: loaded.sourceSha256, generator: check.source.generator });
  if (canonicalJson(check) !== canonicalJson(expected)) throw new ProjectionError('/', 'wire projection does not match its source');
}

/** Regenerate every derived property; untrusted normalized metadata is never authoritative. */
export function validateRichFormCheck(value: unknown): RichFormCheck {
  assertJsonData(value);
  const data = record(value, 'rich projection');
  const source = record(data.source, 'projection source');
  const action = record(data.action, 'projection action');
  const transport = record(data.transport, 'projection transport');
  if (data.format !== RICH_FORM_CHECK_FORMAT) throw new TypeError(`expected a ${RICH_FORM_CHECK_FORMAT} projection`);
  const form = defineWireForm({ id: action.id as string, path: action.path as string,
    fields: transport.fixedDeclarations as FormFields,
    collections: collectionDefinitions(transport.collections as PreparedFormCollections),
    limits: data.limits as Partial<FormReadLimits>,
    uploads: data.uploads as UploadFields,
    ...(data.multipart === undefined ? {} : { multipart: data.multipart as Partial<MultipartLimits> }),
    ...(Array.isArray(data.protocolFields) && data.protocolFields.includes('_bc_request') ? { protocol: { requestKey: 'required' as const } } : {}),
  });
  const expected = projectWireForm(form, { sourcePath: source.path as string, sourceSha256: source.sha256 as string,
    ...(source.generator === undefined ? {} : { generator: source.generator as string }),
  });
  if (canonicalJson(data) !== canonicalJson(expected)) throw new ProjectionError('/', 'rich projection contains inconsistent or unsupported data');
  return expected;
}

export async function loadRichFormCheck(path: string): Promise<Readonly<{ formCheck: RichFormCheck }>> {
  return Object.freeze({ formCheck: validateRichFormCheck(decodeStrictJson(await readBoundedJsonBytes(path), { integerOnly: true })) });
}
