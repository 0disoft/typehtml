import { FIELD_LIMITS, fieldPath, prepareFields, type FormFields } from './fields.ts';
import type { RawFormValues } from './boundary.ts';
import type { InputIssue } from '../runtime/input.ts';

export interface FormCollection {
  readonly minItems?: number;
  /** Required finite bound; expanded fields share the 1024-field transport budget. */
  readonly maxItems: number;
  /** Ordinary submitted string used for UI identity, never authorization. */
  readonly rowKey: string;
  readonly fields: FormFields;
}
export type FormCollections = Readonly<Record<string, FormCollection>>;
export interface PreparedFormCollection extends FormCollection {
  readonly minItems: number;
  readonly path: readonly string[];
}
export type PreparedFormCollections = Readonly<Record<string, PreparedFormCollection>>;
export const COLLECTION_LIMITS = Object.freeze({ maxRowKeyLength: 64 });

function dataProperties(value: unknown, label: string): Record<string, PropertyDescriptor> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain object`);
  const properties = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(properties)) {
    if (typeof key !== 'string' || !properties[key]!.enumerable || !('value' in properties[key]!)) throw new TypeError(`${label} must contain enumerable data properties`);
  }
  return properties;
}

/** Snapshot declarations without invoking caller-owned getters. */
export function prepareFormCollections(collections: FormCollections = {}): PreparedFormCollections {
  const result: Record<string, PreparedFormCollection> = Object.create(null);
  for (const [name, descriptor] of Object.entries(dataProperties(collections, 'collections'))) {
    const path = fieldPath(name);
    if (path.some((segment) => typeof segment !== 'string')) throw new TypeError('collection paths cannot contain row indexes');
    const options = dataProperties(descriptor.value, 'collection');
    if (Object.keys(options).some((key) => !['minItems', 'maxItems', 'rowKey', 'fields'].includes(key))) throw new TypeError('unknown collection option');
    const minItems = options.minItems?.value === undefined ? 0 : options.minItems.value;
    const maxItems = options.maxItems?.value;
    if (!Number.isSafeInteger(minItems) || !Number.isSafeInteger(maxItems) || minItems < 0 || maxItems < minItems || maxItems > FIELD_LIMITS.maxIndex + 1) throw new TypeError('invalid collection bounds');
    const fields = prepareFields(options.fields?.value);
    const rowKey = options.rowKey?.value;
    const key = typeof rowKey === 'string' && Object.hasOwn(fields, rowKey) ? fields[rowKey] : undefined;
    if (key?.type !== 'string' || key.required !== true || (key.minLength ?? 0) < 1 || key.maxLength === undefined || key.maxLength > COLLECTION_LIMITS.maxRowKeyLength) throw new TypeError('rowKey must name a required nonempty string field bounded to 64 characters');
    result[name] = Object.freeze({ minItems, maxItems, rowKey, fields, path: Object.freeze(path as string[]) });
  }
  return Object.freeze(result);
}

export function collectionFieldName(collection: string, index: number, member: string): string {
  if (fieldPath(collection).some((segment) => typeof segment !== 'string')) throw new TypeError('collection paths cannot contain row indexes');
  if (!Number.isSafeInteger(index) || index < 0 || index > FIELD_LIMITS.maxIndex) throw new RangeError('invalid collection row index');
  fieldPath(member);
  const name = `${collection}[${index}].${member}`;
  fieldPath(name);
  return name;
}

/** Stable UI identity survives index changes; the key confers no server-side authority. */
export function collectionFieldId(collection: string, rowKey: string, member: string): string {
  if (typeof rowKey !== 'string' || Array.from(rowKey).length < 1 || Array.from(rowKey).length > COLLECTION_LIMITS.maxRowKeyLength) throw new TypeError('invalid collection row key');
  return `row-${Array.from(JSON.stringify([collection, rowKey, member]), (character) => character.codePointAt(0)!.toString(16)).join('-')}`;
}

/** Only submitted members activate rows; absent checkbox/array members cannot invent rows. */
export function activeCollectionRows(collections: PreparedFormCollections, names: Iterable<string>, resolve: (name: string) => Readonly<{ collection: string; index: number }> | undefined): Readonly<Record<string, readonly number[]>> {
  const active: Record<string, Set<number>> = Object.create(null);
  for (const name of Object.keys(collections)) active[name] = new Set();
  for (const name of names) {
    const row = resolve(name);
    if (row !== undefined) active[row.collection]!.add(row.index);
  }
  const result: Record<string, readonly number[]> = Object.create(null);
  for (const [name, indexes] of Object.entries(active)) result[name] = Object.freeze([...indexes].sort((a, b) => a - b));
  return Object.freeze(result);
}

/** Collection checks supplement ordinary member codecs instead of replacing their errors. */
export function collectionIssues(collections: PreparedFormCollections, active: Readonly<Record<string, readonly number[]>>, raw: RawFormValues): readonly InputIssue[] {
  const issues: InputIssue[] = [];
  for (const [name, collection] of Object.entries(collections)) {
    const rows = active[name]!;
    if (rows.length < collection.minItems) issues.push({ field: null, code: 'MIN_ITEMS', message: `${name} has too few rows` });
    if (rows.some((index, position) => index !== position)) issues.push({ field: null, code: 'SPARSE_ARRAY', message: 'Indexed form values must be contiguous from zero' });
    const keys = new Set<string>();
    for (const index of rows) {
      const field = collectionFieldName(name, index, collection.rowKey);
      const key = raw[field];
      if (typeof key !== 'string') continue; // The required member codec supplies the missing-key error.
      if (keys.has(key)) issues.push({ field, code: 'DUPLICATE_ROW_KEY', message: `${name} row keys must be unique` });
      keys.add(key);
    }
  }
  return Object.freeze(issues);
}

export interface CollectionRow<Value> { readonly key: string; readonly value: Value }

/** Host-owned array operations; no random keys, shared mutations, or reactive state. */
export function createCollectionRows<Value>(rows: readonly CollectionRow<Value>[], maxItems = FIELD_LIMITS.maxIndex + 1): readonly CollectionRow<Value>[] {
  if (!Number.isSafeInteger(maxItems) || maxItems < 0 || maxItems > FIELD_LIMITS.maxIndex + 1 || rows.length > maxItems) throw new RangeError('collection row limit exceeded');
  const keys = new Set<string>();
  return Object.freeze(rows.map(({ key, value }) => {
    collectionFieldId('', key, '');
    if (keys.has(key)) throw new TypeError('collection row keys must be unique');
    keys.add(key);
    return Object.freeze({ key, value });
  }));
}

export function appendCollectionRow<Value>(rows: readonly CollectionRow<Value>[], row: CollectionRow<Value>, maxItems = FIELD_LIMITS.maxIndex + 1): readonly CollectionRow<Value>[] {
  return createCollectionRows([...rows, row], maxItems);
}

export function removeCollectionRow<Value>(rows: readonly CollectionRow<Value>[], key: string): readonly CollectionRow<Value>[] {
  if (!rows.some((row) => row.key === key)) throw new TypeError('unknown collection row key');
  return createCollectionRows(rows.filter((row) => row.key !== key));
}

export function moveCollectionRow<Value>(rows: readonly CollectionRow<Value>[], key: string, toIndex: number): readonly CollectionRow<Value>[] {
  if (!Number.isSafeInteger(toIndex) || toIndex < 0 || toIndex >= rows.length) throw new RangeError('invalid collection row index');
  const fromIndex = rows.findIndex((row) => row.key === key);
  if (fromIndex < 0) throw new TypeError('unknown collection row key');
  const moved = [...rows];
  const [row] = moved.splice(fromIndex, 1);
  moved.splice(toIndex, 0, row!);
  return createCollectionRows(moved);
}
