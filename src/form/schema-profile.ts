import { SUPPORTED_STRING_PATTERNS, type FieldSchema, type ObjectSchema } from '../contract/types.ts';
import { defineForm, type DefinedForm } from './definition.ts';
import type { DefinedSchemaForm } from './schema-form.ts';

export type SchemaProfileUnsupportedCode = 'NESTED_FIELD' | 'UNSUPPORTED_FIELD_TYPE' | 'UNSUPPORTED_PATTERN';

/** Explicit rejection is preferable to silently dropping a wire field from Doctor's allowlist. */
export class SchemaProfileUnsupportedError extends Error {
  constructor(readonly field: string, readonly code: SchemaProfileUnsupportedCode) {
    super(`Doctor's scalar profile cannot represent ${field}: ${code}`);
    this.name = 'SchemaProfileUnsupportedError';
  }
}

export interface SchemaFormManifestOptions {
  /** A caller-declared public output profile. Standard Schema does not expose introspection. */
  readonly output: ObjectSchema;
}

export interface SchemaFormProfile {
  /** For projectForm/Doctor generation only; runtime submissions must use createSchemaFormHandler. */
  readonly form: DefinedForm;
  readonly runtimeValidationCoverage: 'not-statically-analyzed';
}

/**
 * Project only explicitly declared, representable wire constraints, never Standard Schema internals.
 * A successful static check covers this profile, not vendor refinements, transforms or output behavior.
 * Arrays, booleans and nested paths are rejected until Doctor can represent them faithfully.
 */
export function getSchemaFormProfile(form: DefinedSchemaForm, options: SchemaFormManifestOptions): SchemaFormProfile {
  const collection = Object.keys(form.collections ?? {})[0];
  if (collection !== undefined) throw new SchemaProfileUnsupportedError(collection, 'NESTED_FIELD');
  const upload = Object.keys(form.uploads ?? {})[0];
  if (upload !== undefined) throw new SchemaProfileUnsupportedError(upload, 'UNSUPPORTED_FIELD_TYPE');
  if (form.multipart !== undefined) throw new SchemaProfileUnsupportedError('(multipart)', 'UNSUPPORTED_FIELD_TYPE');
  const properties: Record<string, FieldSchema> = Object.create(null);
  const required: string[] = [];
  for (const [name, field] of Object.entries(form.fields)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new SchemaProfileUnsupportedError(name, 'NESTED_FIELD');
    if (field.type !== 'string' && field.type !== 'integer') throw new SchemaProfileUnsupportedError(name, 'UNSUPPORTED_FIELD_TYPE');
    if (field.type === 'string' && field.pattern !== undefined &&
        !SUPPORTED_STRING_PATTERNS.some((pattern) => pattern === field.pattern)) {
      throw new SchemaProfileUnsupportedError(name, 'UNSUPPORTED_PATTERN');
    }
    const { required: isRequired, control: _control, ...schema } = field;
    properties[name] = schema;
    if (isRequired === true) required.push(name);
  }
  const profile = defineForm({
    id: form.id, path: form.path, limits: form.limits,
    ...(form.protocol === undefined ? {} : { protocol: form.protocol }),
    input: { type: 'object', additionalProperties: false, required, properties }, output: options.output,
  });
  return Object.freeze({ form: profile, runtimeValidationCoverage: 'not-statically-analyzed' });
}

/**
 * JSON-serializable input to `typehtml generate --form profile.json --out-dir generated`.
 * Save the result explicitly; generation never imports or executes application validators.
 * The manifest declares transport constraints only. Keep runtimeValidationCoverage documentation
 * beside generated artifacts; the generated projection also labels runtime coverage not-evaluated.
 */
export function schemaFormManifest(form: DefinedSchemaForm, options: SchemaFormManifestOptions): DefinedForm['definition'] {
  return getSchemaFormProfile(form, options).form.definition;
}
