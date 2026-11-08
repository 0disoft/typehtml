import { fieldPath, prepareFields, type FormField, type FormFields, type ScalarFormField } from './fields.ts';

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
}

export interface PreparedFormTransport {
  readonly format: 'typehtml-transport/1';
  readonly declarations: FormFields;
  readonly fields: readonly NormalizedTransportField[];
  readonly byName: Readonly<Record<string, NormalizedTransportField>>;
  readonly names: readonly string[];
  readonly repeatable: readonly string[];
}

// Only snapshots produced here are cached. Mutable caller-owned declarations
// must be prepared again rather than silently reusing an obsolete snapshot.
const preparedByDeclarations = new WeakMap<FormFields, PreparedFormTransport>();

/** Shared immutable transport data for decoding, HTML helpers and static tools. */
export function prepareFormTransport(fields: FormFields): PreparedFormTransport {
  const declarations = prepareFields(fields);
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
    });
    normalized.push(field);
    byName[name] = field;
    if (repeated) repeatable.push(name);
  }
  const prepared: PreparedFormTransport = Object.freeze({
    format: 'typehtml-transport/1', declarations,
    fields: Object.freeze(normalized), byName: Object.freeze(byName),
    names: Object.freeze(normalized.map((field) => field.name)), repeatable: Object.freeze(repeatable),
  });
  preparedByDeclarations.set(declarations, prepared);
  return prepared;
}

/** Reuse an owned snapshot without recompiling a form for every HTML control. */
export function getPreparedFormTransport(fields: FormFields): PreparedFormTransport {
  return preparedByDeclarations.get(fields) ?? prepareFormTransport(fields);
}

/** Exact canonical names only; prototype keys and undeclared indexes never match. */
export function resolveTransportField(prepared: PreparedFormTransport, name: string): NormalizedTransportField | null {
  return Object.hasOwn(prepared.byName, name) ? prepared.byName[name]! : null;
}
