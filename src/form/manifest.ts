import { canonicalJson } from '../contract/canonical-json.ts';
import { sourceSha256 } from '../contract/behavior.ts';
import { decodeStrictJson, readBoundedJsonBytes } from '../contract/strict-json.ts';
import { FORM_CHECK_FORMAT, SUPPORTED_PARSER_PROFILE, type FormCheck } from '../contract/types.ts';
import { ProjectionError } from '../contract/project.ts';
import { defineForm, FORM_FORMAT, type DefinedForm, type FormDefinition } from './definition.ts';

export interface LoadedForm {
  readonly form: DefinedForm;
  readonly sourceSha256: string;
}

/** Reads bounded static JSON only; application configuration and exporters are never executed. */
export async function loadForm(path: string): Promise<LoadedForm> {
  const bytes = await readBoundedJsonBytes(path);
  const value = decodeStrictJson(bytes, { integerOnly: true });
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.format !== FORM_FORMAT) {
    throw new TypeError(`expected a ${FORM_FORMAT} manifest`);
  }
  return { form: defineForm(value as unknown as FormDefinition), sourceSha256: sourceSha256(bytes) };
}

/** Exact structural input projection compatible with the form-only Doctor. */
export function projectForm(form: DefinedForm, options: Readonly<{
  sourcePath: string;
  sourceSha256: string;
  generator?: string;
}>): FormCheck {
  if (!/^[a-f0-9]{64}$/.test(options.sourceSha256)) throw new TypeError('sourceSha256 must be a SHA-256 hex digest');
  if (options.sourcePath.length === 0 || /[\r\n\u2028\u2029]/.test(options.sourcePath)) throw new TypeError('sourcePath must be a non-empty single-line path');
  return {
    format: FORM_CHECK_FORMAT,
    status: 'generated',
    source: {
      path: options.sourcePath, sha256: options.sourceSha256,
      generator: options.generator ?? '@0disoft/typehtml/form-projection',
      projection: 'exact-for-selected-structural-fields', runtimeCoverage: 'not-evaluated',
      behaviorSha256: form.behaviorSha256,
    },
    action: { id: form.id, method: 'POST', path: form.path, encoding: 'urlencoded', parserProfile: SUPPORTED_PARSER_PROFILE },
    input: form.input,
    protocolFields: ['_bc_csrf'],
  };
}

export function verifyFormSource(check: FormCheck, loaded: LoadedForm): void {
  if (check.source.sha256 !== loaded.sourceSha256) throw new ProjectionError('/source/sha256', 'form projection source bytes have changed');
  const expected = projectForm(loaded.form, { sourcePath: check.source.path, sourceSha256: loaded.sourceSha256, generator: check.source.generator });
  if (check.source.behaviorSha256 !== expected.source.behaviorSha256) throw new ProjectionError('/source/behaviorSha256', 'form projection behavior digest does not match its source');
  for (const key of ['action', 'input', 'protocolFields'] as const) {
    if (canonicalJson(check[key]) !== canonicalJson(expected[key])) throw new ProjectionError(`/${key}`, `form projection ${key} does not match its source`);
  }
}
