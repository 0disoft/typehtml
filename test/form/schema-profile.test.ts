import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineSchemaForm } from '../../src/form/schema-form.ts';
import { getSchemaFormProfile, schemaFormManifest, SchemaProfileUnsupportedError } from '../../src/form/schema-profile.ts';
import { loadForm, projectForm } from '../../src/form/manifest.ts';
import { FORM_FORMAT } from '../../src/form/definition.ts';
import type { FormFields } from '../../src/form/fields.ts';
import type { StandardSchemaV1 } from '../../src/form/standard-schema.ts';

const output = { type: 'object', additionalProperties: false, required: ['receipt'], properties: { receipt: { type: 'string', minLength: 1 } } } as const;
const identity: StandardSchemaV1 = { '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) } };

function rich(fields: FormFields) {
  return defineSchemaForm({ id: 'profile.send', path: '/profile', fields, input: identity, output: identity, limits: { maxBytes: 4_096 } });
}

describe('Standard Schema form static profile bridge', () => {
  it('preserves explicitly declared scalar constraints, required fields, paths and limits', () => {
    const form = rich({
      name: { type: 'string', required: true, control: 'textarea', minLength: 1, maxLength: 40 },
      count: { type: 'integer', required: true, minimum: -2, maximum: 5 },
      channel: { type: 'string', control: 'radio', enum: ['email', 'paper'] },
      draft: { type: 'string', pattern: '^draft_[A-Za-z0-9_-]{1,58}$' },
    });
    const profile = getSchemaFormProfile(form, { output });
    expect(profile.runtimeValidationCoverage).toBe('not-statically-analyzed');
    expect(profile.form.id).toBe(form.id);
    expect(profile.form.path).toBe(form.path);
    expect(profile.form.limits).toEqual(form.limits);
    expect(profile.form.input.schema.required).toEqual(['name', 'count']);
    expect(profile.form.input.schema.properties.name).toEqual({ type: 'string', minLength: 1, maxLength: 40 });
    expect(profile.form.input.schema.properties.count).toEqual({ type: 'integer', minimum: -2, maximum: 5 });
    expect(profile.form.input.schema.properties.channel).toEqual({ type: 'string', enum: ['email', 'paper'] });
    expect(profile.form.output).toEqual(output);
    expect(Object.isFrozen(profile.form.definition)).toBe(true);
  });

  it('rejects every unrepresentable field instead of silently omitting it', () => {
    const cases = [
      { fields: { 'person.name': { type: 'string' } }, field: 'person.name', code: 'NESTED_FIELD' },
      { fields: { 'items[0]': { type: 'integer' } }, field: 'items[0]', code: 'NESTED_FIELD' },
      { fields: { checked: { type: 'boolean' } }, field: 'checked', code: 'UNSUPPORTED_FIELD_TYPE' },
      { fields: { tags: { type: 'array', items: { type: 'string' } } }, field: 'tags', code: 'UNSUPPORTED_FIELD_TYPE' },
      { fields: { name: { type: 'string', pattern: '[a-z]+' } }, field: 'name', code: 'UNSUPPORTED_PATTERN' },
    ] as const;
    for (const { fields, field, code } of cases) {
      try { schemaFormManifest(rich(fields as FormFields), { output }); throw new Error('expected unsupported profile'); }
      catch (error) {
        expect(error).toBeInstanceOf(SchemaProfileUnsupportedError);
        expect(error).toMatchObject({ field, code });
      }
    }
  });

  it('does not introspect or execute validators, invent refinements, or fabricate an output schema', () => {
    let calls = 0;
    const validator: StandardSchemaV1 = { '~standard': { version: 1, vendor: 'opaque', validate() { calls++; return { issues: [{ message: 'business constraint' }] }; } } };
    const form = defineSchemaForm({ id: 'opaque', path: '/opaque', fields: { name: { type: 'string' } }, input: validator, output: validator });
    const profile = getSchemaFormProfile(form, { output });
    expect(calls).toBe(0);
    expect(profile.form.input.schema.properties.name).toEqual({ type: 'string' });
    expect(() => schemaFormManifest(form, {} as never)).toThrow();
    // @ts-expect-error caller-declared output profile is mandatory
    if (false) schemaFormManifest(form, {});
  });

  it('round-trips the JSON manifest through the existing verified source projection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'typehtml-schema-profile-'));
    try {
      const form = rich({ name: { type: 'string', required: true, minLength: 1 } });
      const manifest = schemaFormManifest(form, { output });
      expect(manifest.format).toBe(FORM_FORMAT);
      const path = join(directory, 'profile.form.json');
      await writeFile(path, JSON.stringify(manifest));
      const loaded = await loadForm(path);
      const check = projectForm(loaded.form, { sourcePath: 'profile.form.json', sourceSha256: loaded.sourceSha256 });
      expect(check.action.id).toBe(form.id);
      expect(check.input.schema.properties).toEqual({ name: { type: 'string', minLength: 1 } });
      expect(check.source.runtimeCoverage).toBe('not-evaluated');
      expect(check.protocolFields).toEqual(['_bc_csrf']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('snapshots caller-owned output without freezing or altering it', () => {
    const mutable = { type: 'object' as const, additionalProperties: false as const, required: ['message'], properties: { message: { type: 'string' as const, maxLength: 32 } } };
    const manifest = schemaFormManifest(rich({ name: { type: 'string' } }), { output: mutable });
    mutable.properties.message.maxLength = 64;
    expect(manifest.output.properties.message).toEqual({ type: 'string', maxLength: 32 });
    expect(Object.isFrozen(mutable)).toBe(false);
  });

  it('declares idempotency protocol fields in the verified static projection', () => {
    const form = defineSchemaForm({ id: 'idempotent.form', path: '/profile', fields: { name: { type: 'string' } }, input: identity, output: identity, protocol: { requestKey: 'required' } });
    const profile = getSchemaFormProfile(form, { output });
    const check = projectForm(profile.form, { sourcePath: 'profile.json', sourceSha256: 'a'.repeat(64) });
    expect(check.protocolFields).toEqual(['_bc_csrf', '_bc_request']);
    expect(schemaFormManifest(form, { output }).protocol).toEqual({ requestKey: 'required' });
  });
});
