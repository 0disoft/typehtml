import { fieldPath, prepareFields, type FormField, type FormFields, type ScalarFormField } from './fields.ts';
import { prepareFormCollections, collectionFieldName, activeCollectionRows, collectionIssues, type FormCollections, type PreparedFormCollections } from './collections.ts';
import { decodeFormFields, FIELD_LIMITS } from './fields.ts';
import type { FormEntry } from '../runtime/wire.ts';
import type { BoundaryValidation, RawFormValues } from './boundary.ts';

export interface NormalizedTransportField {
  readonly name: string;
  readonly path: readonly (string | number)[];
  /** Preserve presence declarations separately from effective occurrence bounds. */
  readonly declaration: FormField;
  readonly codec: ScalarFormField;
  readonly cardinality: 'scalar' | 'repeated';
  readonly minOccurrences: number;
  /** null represents an unbounded declaration; request transport limits still apply. */
  readonly maxOccurrences: number | null;
  readonly missing: 'absent' | 'false' | 'empty-array';
  readonly row?: Readonly<{ collection: string; index: number; member: string }>;
}

export interface PreparedFormTransport {
  readonly format: 'typehtml-transport/1';
  readonly declarations: FormFields;
  readonly fixedDeclarations: FormFields;
  readonly collections: PreparedFormCollections;
  readonly fields: readonly NormalizedTransportField[];
  readonly byName: Readonly<Record<string, NormalizedTransportField>>;
  readonly names: readonly string[];
  readonly repeatable: readonly string[];
}

// Only snapshots produced here are cached. Mutable caller-owned declarations
// must be prepared again rather than silently reusing an obsolete snapshot.
const preparedByDeclarations = new WeakMap<FormFields, PreparedFormTransport>();

function assertCollectionDomains(fixed: FormFields, groups: PreparedFormCollections): void {
  type Node = { leaf: boolean; children: Map<string | number, Node> };
  const root: Node = { leaf: false, children: new Map() };
  for (const path of Object.keys(fixed).map(fieldPath)) {
    let node = root;
    for (const segment of path) {
      let child = node.children.get(segment);
      if (child === undefined) { child = { leaf: false, children: new Map() }; node.children.set(segment, child); }
      node = child;
    }
    node.leaf = true;
  }
  for (const [name, group] of Object.entries(groups)) {
    let node = root;
    for (const segment of group.path) {
      if (node.leaf) throw new TypeError(`overlapping collection path: ${name}`);
      let child = node.children.get(segment);
      if (child === undefined) { child = { leaf: false, children: new Map() }; node.children.set(segment, child); }
      node = child;
    }
    if (node.leaf || node.children.size > 0) throw new TypeError(`overlapping collection path: ${name}`);
    node.leaf = true;
  }
}

/** Shared immutable transport data for decoding, HTML helpers and static tools. */
export function prepareFormTransport(fields: FormFields, collections: FormCollections = {}, options: Readonly<{ allowEmpty?: boolean }> = {}): PreparedFormTransport {
  const groups = prepareFormCollections(collections);
  const empty = fields !== null && typeof fields === 'object' && !Array.isArray(fields) && [null, Object.prototype].includes(Object.getPrototypeOf(fields)) && Reflect.ownKeys(fields).length === 0;
  const fixedDeclarations = empty && (Object.keys(groups).length > 0 || options.allowEmpty === true) ? Object.freeze(Object.create(null)) as FormFields : prepareFields(fields);
  assertCollectionDomains(fixedDeclarations, groups);
  const expanded: Record<string, FormField> = Object.assign(Object.create(null), fixedDeclarations);
  const rows: Record<string, Readonly<{ collection: string; index: number; member: string }>> = Object.create(null);
  let count = Object.keys(expanded).length;
  for (const [collection, group] of Object.entries(groups)) {
    const members = Object.entries(group.fields);
    count += Math.max(1, group.maxItems) * members.length;
    if (count > FIELD_LIMITS.maxFields) throw new TypeError('expanded collection fields exceed transport limit');
    for (let index = 0; index < group.maxItems; index++) for (const [member, declaration] of members) {
      const name = collectionFieldName(collection, index, member);
      if (Object.hasOwn(expanded, name)) throw new TypeError(`overlapping collection field: ${name}`);
      expanded[name] = declaration;
      rows[name] = Object.freeze({ collection, index, member });
    }
  }
  const validationFields = { ...expanded };
  for (const [collection, group] of Object.entries(groups)) if (group.maxItems === 0) {
    for (const [member, declaration] of Object.entries(group.fields)) {
      const name = collectionFieldName(collection, 0, member);
      if (Object.hasOwn(validationFields, name)) throw new TypeError(`overlapping collection field: ${name}`);
      validationFields[name] = declaration;
    }
  }
  if (Object.keys(validationFields).length > 0) prepareFields(validationFields);
  const declarations = Object.keys(groups).length === 0 ? fixedDeclarations : Object.freeze(expanded);
  const normalized: NormalizedTransportField[] = [];
  const byName: Record<string, NormalizedTransportField> = Object.create(null);
  const repeatable: string[] = [];
  for (const [name, declaration] of Object.entries(declarations)) {
    const repeated = declaration.type === 'array';
    const { required: _required, control: _control, ...scalar } = declaration;
    const codec = repeated ? declaration.items : Object.freeze(scalar) as ScalarFormField;
    const field: NormalizedTransportField = Object.freeze({
      name, path: fieldPath(name), declaration, codec,
      cardinality: repeated ? 'repeated' : 'scalar',
      minOccurrences: Math.max(declaration.required ? 1 : 0, repeated ? declaration.minItems ?? 0 : 0),
      maxOccurrences: repeated ? declaration.maxItems ?? null : 1,
      missing: repeated ? 'empty-array' : declaration.type === 'boolean' ? 'false' : 'absent',
      ...(Object.hasOwn(rows, name) ? { row: rows[name] } : {}),
    });
    normalized.push(field);
    byName[name] = field;
    if (repeated) repeatable.push(name);
  }
  const prepared: PreparedFormTransport = Object.freeze({
    format: 'typehtml-transport/1', declarations, fixedDeclarations, collections: groups,
    fields: Object.freeze(normalized), byName: Object.freeze(byName),
    names: Object.freeze(normalized.map((field) => field.name)), repeatable: Object.freeze(repeatable),
  });
  preparedByDeclarations.set(declarations, prepared);
  preparedByDeclarations.set(fixedDeclarations, prepared);
  return prepared;
}

/** Reuse an owned snapshot without recompiling a form for every HTML control. */
export function getPreparedFormTransport(fields: FormFields, collections?: FormCollections): PreparedFormTransport {
  const cached = preparedByDeclarations.get(fields);
  return cached !== undefined && (collections === undefined || collections === cached.collections) ? cached : prepareFormTransport(fields, collections);
}

/** Exact canonical names only; prototype keys and undeclared indexes never match. */
export function resolveTransportField(prepared: PreparedFormTransport, name: string): NormalizedTransportField | null {
  return Object.hasOwn(prepared.byName, name) ? prepared.byName[name]! : null;
}

export function getActiveTransportRows(prepared: PreparedFormTransport, names: Iterable<string>): Readonly<Record<string, readonly number[]>> {
  return activeCollectionRows(prepared.collections, names, (name) => resolveTransportField(prepared, name)?.row);
}

function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

/** Decode only activated rows, preserving scalar codec errors and ordered repeated values. */
export function decodeFormTransport(prepared: PreparedFormTransport, entries: readonly FormEntry[], options: Readonly<{ deferSparseCheck?: boolean }> = {}): Readonly<{ raw: RawFormValues; validation: BoundaryValidation<Readonly<Record<string, unknown>>> }> {
  if (Object.keys(prepared.collections).length === 0) return decodeFormFields(prepared.declarations, entries, options);
  const active = getActiveTransportRows(prepared, entries.map(({ key }) => key));
  const indexes = Object.fromEntries(Object.entries(active).map(([name, values]) => [name, new Set(values)]));
  const selected: Record<string, FormField> = Object.create(null);
  for (const field of prepared.fields) if (field.row === undefined || indexes[field.row.collection]!.has(field.row.index)) selected[field.name] = field.declaration;
  const decoded = decodeFormFields(selected, entries, options);
  const issues = collectionIssues(prepared.collections, active, decoded.raw);
  if (!decoded.validation.ok) {
    const sparse = decoded.validation.issues.some((issue) => issue.code === 'SPARSE_ARRAY');
    const combined = [...decoded.validation.issues, ...issues.filter((issue) => issue.code !== 'SPARSE_ARRAY' || !sparse)];
    return Object.freeze({ raw: decoded.raw, validation: { ...decoded.validation, issues: Object.freeze(combined) } });
  }
  if (issues.length > 0) return Object.freeze({ raw: decoded.raw, validation: { ok: false, issues, unknownKeys: [] } });
  const value: Record<string, unknown> = { ...decoded.validation.value };
  for (const [name, group] of Object.entries(prepared.collections)) {
    if (active[name]!.length > 0) continue;
    let node = value;
    for (const segment of group.path.slice(0, -1)) {
      const child = node[segment];
      node[segment] = child === undefined ? Object.create(null) : { ...child as Record<string, unknown> };
      node = node[segment] as Record<string, unknown>;
    }
    node[group.path.at(-1)!] = [];
  }
  freezeTree(value);
  return Object.freeze({ raw: decoded.raw, validation: { ok: true, value } });
}
