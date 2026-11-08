import { fieldPath, prepareFields, FIELD_LIMITS, type FormField } from './fields.ts';
import type { PreparedFormTransport } from './transport.ts';
import type { InputIssue } from '../runtime/input.ts';
import type { UploadedFile } from './upload-storage.ts';

export interface UploadField {
  readonly required?: boolean;
  readonly multiple?: boolean;
  readonly minFiles?: number;
  readonly maxFiles?: number;
  /** Browser hint only. Inspect actual file bytes inside your authorized operation. */
  readonly accept?: readonly string[];
}
export type UploadFields = Readonly<Record<string, UploadField>>;
export const UPLOAD_LIMITS = Object.freeze({ defaultMultipleCount: 4, maxFilesPerField: 64, maxAcceptHints: 32 });

/** Files cannot alias text leaves or inhabit a dynamic collection's reserved domain. */
export function assertUploadDomains(transport: PreparedFormTransport, uploads: UploadFields): void {
  const reserved = Object.values(transport.collections).reduce((sum, group) => sum + (group.maxItems === 0 ? Object.keys(group.fields).length : 0), 0);
  if (transport.fields.length + reserved + Object.keys(uploads).length > FIELD_LIMITS.maxFields) throw new TypeError('upload and text fields exceed transport limit');
  const combined: Record<string, FormField> = { ...transport.declarations };
  for (const name of Object.keys(uploads)) {
    const path = fieldPath(name);
    for (const collection of Object.values(transport.collections)) {
      const common = Math.min(path.length, collection.path.length);
      if (path.slice(0, common).every((part, index) => part === collection.path[index])) throw new TypeError('uploads cannot overlap a dynamic collection domain');
    }
    if (Object.hasOwn(combined, name)) throw new TypeError('upload and text fields overlap');
    combined[name] = { type: 'string' };
  }
  if (Object.keys(combined).length > 0) prepareFields(combined);
}

function dataProperties(value: unknown): Record<string, PropertyDescriptor> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new TypeError('upload declarations must be plain objects');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as string]!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('upload declarations require enumerable data properties');
  }
  return descriptors;
}

export function prepareUploadFields(value: UploadFields = {}): UploadFields {
  const fields: Record<string, UploadField> = Object.create(null);
  const entries = Object.entries(dataProperties(value));
  if (entries.length > FIELD_LIMITS.maxFields) throw new TypeError('too many upload declarations');
  for (const [name, descriptor] of entries) {
    fieldPath(name);
    const props = dataProperties(descriptor.value);
    if (Object.keys(props).some((key) => !['required', 'multiple', 'minFiles', 'maxFiles', 'accept'].includes(key))) throw new TypeError('unknown upload option');
    const get = (key: string) => props[key]?.value;
    for (const key of ['required', 'multiple']) if (get(key) !== undefined && typeof get(key) !== 'boolean') throw new TypeError(`upload ${key} must be boolean`);
    for (const key of ['minFiles', 'maxFiles']) if (get(key) !== undefined && (!Number.isSafeInteger(get(key)) || get(key) < 0 || get(key) > UPLOAD_LIMITS.maxFilesPerField)) throw new TypeError('upload file count must be between zero and 64');
    const minimum = Math.max(get('required') ? 1 : 0, get('minFiles') ?? 0);
    const maximum = get('maxFiles') ?? (get('multiple') ? UPLOAD_LIMITS.defaultMultipleCount : 1);
    if (minimum > maximum || !get('multiple') && maximum > 1) throw new TypeError('invalid upload count range');
    const accept = get('accept');
    const hints: string[] = [];
    if (accept !== undefined) {
      if (!Array.isArray(accept) || Object.getPrototypeOf(accept) !== Array.prototype || accept.length > UPLOAD_LIMITS.maxAcceptHints) throw new TypeError('invalid upload accept hints');
      const descriptors = Object.getOwnPropertyDescriptors(accept);
      if (Reflect.ownKeys(descriptors).length !== accept.length + 1) throw new TypeError('invalid upload accept hints');
      for (let index = 0; index < accept.length; index++) {
        const item = descriptors[String(index)];
        if (item === undefined || !('value' in item) || !item.enumerable || typeof item.value !== 'string' || !/^(?:\.[A-Za-z0-9]+|[A-Za-z0-9!#$&^_.+-]+\/(?:[A-Za-z0-9!#$&^_.+-]+|\*))$/.test(item.value)) throw new TypeError('invalid upload accept hints');
        hints.push(item.value);
      }
    }
    fields[name] = Object.freeze({ ...(get('required') === undefined ? {} : { required: get('required') }),
      ...(get('multiple') === undefined ? {} : { multiple: get('multiple') }),
      ...(get('minFiles') === undefined ? {} : { minFiles: get('minFiles') }),
      ...(get('maxFiles') === undefined ? {} : { maxFiles: get('maxFiles') }),
      ...(accept === undefined ? {} : { accept: Object.freeze(hints) }),
    });
  }
  return Object.freeze(fields);
}

/** Selected files only; browsers' empty filename/zero-byte placeholders are omitted by transport. */
export function decodeUploadFields(fields: UploadFields, files: ReadonlyMap<string, readonly UploadedFile[]>): Readonly<{
  value: Readonly<Record<string, UploadedFile | readonly UploadedFile[]>>;
  issues: readonly InputIssue[];
}> {
  const value: Record<string, UploadedFile | readonly UploadedFile[]> = Object.create(null);
  const issues: InputIssue[] = [];
  for (const [name, field] of Object.entries(fields)) {
    const selected = files.get(name) ?? [];
    if (field.required && selected.length === 0) issues.push({ field: name, code: 'REQUIRED', message: `${name} is required` });
    if (selected.length < (field.minFiles ?? 0)) issues.push({ field: name, code: 'MIN_FILES', message: `${name} has too few files` });
    if (selected.length > (field.maxFiles ?? (field.multiple ? UPLOAD_LIMITS.defaultMultipleCount : 1))) issues.push({ field: name, code: 'MAX_FILES', message: `${name} has too many files` });
    if (field.multiple) value[name] = Object.freeze([...selected]);
    else if (selected[0] !== undefined) value[name] = selected[0];
  }
  return Object.freeze({ value: Object.freeze(value), issues: Object.freeze(issues) });
}
