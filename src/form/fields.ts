import type { IntegerFieldSchema, StringFieldSchema } from '../contract/types.ts';
import { validateBusinessInput, type InputIssue } from '../runtime/input.ts';
import type { FormEntry } from '../runtime/wire.ts';
import type { BoundaryValidation, RawFormValues } from './boundary.ts';

export type ScalarFormField = StringFieldSchema | IntegerFieldSchema | Readonly<{
  type: 'boolean'; trueValue?: string; falseValue?: string;
}>;
export type FormField = (ScalarFormField | Readonly<{
  type: 'array'; items: ScalarFormField; minItems?: number; maxItems?: number;
}>) & Readonly<{ required?: boolean; control?: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' }>;
export type FormFields = Readonly<Record<string, FormField>>;
export const FIELD_LIMITS = Object.freeze({ maxFields: 1_024, maxDepth: 16, maxIndex: 1_023 });
type Segment = string | number;
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);

/** Fixed paths only: never infer paths or array indexes from untrusted request keys. */
export function fieldPath(name: string): readonly Segment[] {
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:(?:\.[A-Za-z][A-Za-z0-9_]*)|(?:\[(?:0|[1-9][0-9]*)\]))*$/.test(name)) throw new TypeError(`invalid field path: ${name}`);
  const segments: Segment[] = [];
  for (const part of name.matchAll(/([A-Za-z][A-Za-z0-9_]*)|\[([0-9]+)\]/g)) {
    if (part[1] !== undefined) {
      if (unsafe.has(part[1])) throw new TypeError(`reserved field path: ${name}`);
      segments.push(part[1]);
    } else {
      const index = Number(part[2]);
      if (index > FIELD_LIMITS.maxIndex) throw new TypeError('field array index exceeds limit');
      segments.push(index);
    }
  }
  if (segments.length > FIELD_LIMITS.maxDepth) throw new TypeError('field path exceeds maximum depth');
  return Object.freeze(segments);
}

function validateScalar(field: ScalarFormField): void {
  const keys = field.type === 'string' ? ['type', 'minLength', 'maxLength', 'const', 'enum', 'pattern']
    : field.type === 'integer' ? ['type', 'minimum', 'maximum', 'const', 'enum']
    : field.type === 'boolean' ? ['type', 'trueValue', 'falseValue'] : [];
  if (keys.length === 0) throw new TypeError('unsupported field codec');
  for (const key of Object.keys(field)) if (!keys.includes(key)) throw new TypeError(`unknown scalar field option: ${key}`);
  if (field.type === 'boolean') {
    if ((field.trueValue !== undefined && typeof field.trueValue !== 'string') || (field.falseValue !== undefined && typeof field.falseValue !== 'string') || (field.trueValue ?? 'on') === field.falseValue) throw new TypeError('invalid boolean tokens');
    return;
  }
  const lower = field.type === 'string' ? field.minLength : field.minimum;
  const upper = field.type === 'string' ? field.maxLength : field.maximum;
  for (const value of [lower, upper]) if (value !== undefined && (!Number.isSafeInteger(value) || (field.type === 'string' && value < 0))) throw new TypeError('invalid field bound');
  if (lower !== undefined && upper !== undefined && lower > upper) throw new TypeError('inverted field bounds');
  for (const value of [...(field.const === undefined ? [] : [field.const]), ...(field.enum ?? [])]) {
    if (field.type === 'string' ? typeof value !== 'string' : typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError('invalid field literal');
  }
  if (field.enum !== undefined && (!Array.isArray(field.enum) || field.enum.length === 0)) throw new TypeError('field enum must not be empty');
  if (field.type === 'string' && field.pattern !== undefined) {
    if (typeof field.pattern !== 'string' || field.pattern.length > 1_024) throw new TypeError('invalid field pattern');
    new RegExp(field.pattern, 'u');
  }
}

/** Clone/freeze configuration and reject path aliases, container conflicts, and dangerous keys. */
export function prepareFields(fields: FormFields): FormFields {
  const snapshot = structuredClone(fields);
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new TypeError('fields must be an object');
  const entries = Object.entries(snapshot);
  if (entries.length === 0 || entries.length > FIELD_LIMITS.maxFields) throw new TypeError('invalid field count');
  type Node = { leaf?: boolean; kind?: 'object' | 'array'; children: Map<Segment, Node> };
  const root: Node = { children: new Map() };
  for (const [name, field] of entries) {
    const path = fieldPath(name);
    let node = root;
    for (const key of path) {
      if (node.leaf) throw new TypeError(`overlapping field paths: ${name}`);
      const kind = typeof key === 'number' ? 'array' : 'object';
      if (node.kind !== undefined && node.kind !== kind) throw new TypeError(`conflicting field containers: ${name}`);
      node.kind = kind;
      let child = node.children.get(key);
      if (child === undefined) { child = { children: new Map() }; node.children.set(key, child); }
      node = child;
    }
    if (node.leaf || node.children.size > 0) throw new TypeError(`overlapping field paths: ${name}`);
    node.leaf = true;
    if (field === null || typeof field !== 'object' || Array.isArray(field)) throw new TypeError('invalid field definition');
    const { required, control, ...codec } = field;
    if (required !== undefined && typeof required !== 'boolean') throw new TypeError('required must be boolean');
    if (control !== undefined && !['text', 'textarea', 'select', 'radio', 'checkbox'].includes(control)) throw new TypeError('invalid field control');
    if ((field.type === 'boolean' || field.type === 'array' && field.items?.type === 'boolean') && control !== undefined && control !== 'checkbox') throw new TypeError('boolean fields require checkbox controls');
    if (codec.type === 'array') {
      if (Object.keys(codec).some((key) => !['type', 'items', 'minItems', 'maxItems'].includes(key))) throw new TypeError('unknown array field option');
      validateScalar(codec.items);
      for (const limit of [codec.minItems, codec.maxItems]) if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new TypeError('invalid array bound');
      if ((codec.minItems ?? 0) > (codec.maxItems ?? Infinity)) throw new TypeError('inverted array bounds');
      Object.freeze(codec.items);
    } else validateScalar(codec);
    if ('enum' in field && Array.isArray(field.enum)) Object.freeze(field.enum);
    if (field.type === 'array' && 'enum' in field.items && Array.isArray(field.items.enum)) Object.freeze(field.items.enum);
    Object.freeze(field);
  }
  return Object.freeze(snapshot);
}

function decodeScalar(name: string, field: ScalarFormField, raw: string): string | number | boolean | InputIssue {
  if (field.type === 'boolean') {
    if (raw === (field.trueValue ?? 'on')) return true;
    if (field.falseValue !== undefined && raw === field.falseValue) return false;
    return { field: name, code: 'BOOLEAN', message: `${name} must be an allowed checkbox value` };
  }
  const result = validateBusinessInput({ schema: { type: 'object', additionalProperties: false, required: [name], properties: { [name]: field } }, codecs: { [name]: field.type === 'string' ? 'text' : 'decimal-integer' }, unknownKeys: 'reject', duplicateScalars: 'reject', scalarSemantics: { missing: 'absent', emptyString: 'preserve', textNormalization: 'none', schemaStringLength: 'unicode-code-points', validationMutatesData: false } }, { [name]: raw });
  return result.ok ? result.value[name]! : result.issues[0]!;
}

function assign(root: Record<string, unknown>, path: readonly Segment[], value: unknown): void {
  let node: Record<string | number, unknown> = root;
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index]!;
    node[key] ??= typeof path[index + 1] === 'number' ? [] : Object.create(null);
    node = node[key] as Record<string | number, unknown>;
  }
  node[path.at(-1)!] = value;
}
function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const item of Object.values(value)) freezeTree(item);
  Object.freeze(value);
}
function hasHoles(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value) && Object.keys(value).length !== value.length) return true;
  return Object.values(value).some(hasHoles);
}

/** O(entries + declared fields + bounded path depth), preserving repeated-value order. */
export function decodeFormFields(fields: FormFields, entries: readonly FormEntry[]): Readonly<{
  raw: RawFormValues; validation: BoundaryValidation<Readonly<Record<string, unknown>>>;
}> {
  const grouped = new Map<string, string[]>();
  const unknownKeys: string[] = [];
  for (const entry of entries) {
    if (!Object.hasOwn(fields, entry.key)) { unknownKeys.push(entry.key); continue; }
    const values = grouped.get(entry.key);
    if (values === undefined) grouped.set(entry.key, [entry.value]); else values.push(entry.value);
  }
  const raw: Record<string, string | readonly string[]> = Object.create(null);
  const value: Record<string, unknown> = Object.create(null);
  const issues: InputIssue[] = [];
  for (const [name, field] of Object.entries(fields)) {
    const submitted = grouped.get(name) ?? [];
    if (submitted.length > 0) raw[name] = field.type === 'array' ? Object.freeze([...submitted]) : submitted[0]!;
    if (field.required && submitted.length === 0) issues.push({ field: name, code: 'REQUIRED', message: `${name} is required` });
    if (field.type !== 'array' && submitted.length > 1) {
      issues.push({ field: name, code: 'DUPLICATE_KEY', message: `${name} must occur once` }); continue;
    }
    if (field.type !== 'array' && field.type !== 'boolean' && submitted.length === 0) continue;
    const decoded: unknown[] = [];
    for (const text of submitted) {
      const item = decodeScalar(name, field.type === 'array' ? field.items : field, text);
      if (typeof item === 'object') issues.push(item); else decoded.push(item);
    }
    if (field.type === 'array') {
      if (submitted.length < (field.minItems ?? 0)) issues.push({ field: name, code: 'MIN_ITEMS', message: `${name} has too few values` });
      if (submitted.length > (field.maxItems ?? Infinity)) issues.push({ field: name, code: 'MAX_ITEMS', message: `${name} has too many values` });
      assign(value, fieldPath(name), decoded);
    } else assign(value, fieldPath(name), decoded[0] ?? false);
  }
  if (hasHoles(value)) issues.push({ field: null, code: 'SPARSE_ARRAY', message: 'Indexed form values must be contiguous from zero' });
  freezeTree(value);
  return Object.freeze({ raw: Object.freeze(raw), validation: issues.length > 0 || unknownKeys.length > 0
    ? { ok: false, issues: Object.freeze(issues), unknownKeys: Object.freeze(unknownKeys) }
    : { ok: true, value } });
}
