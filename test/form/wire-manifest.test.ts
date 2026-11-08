import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineWireForm, schemaFormWireManifest, projectWireForm, loadWireForm, loadRichFormCheck, validateRichFormCheck, verifyWireFormSource } from '../../src/form/wire-manifest.ts';
import { defineSchemaForm } from '../../src/form/schema-form.ts';

const make = () => defineWireForm({ id: 'rich.profile', path: '/profile', fields: {
  'person.name': { type: 'string', required: true, maxLength: 40 },
  newsletter: { type: 'boolean' },
  tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
} });
const project = () => projectWireForm(make(), { sourcePath: 'profile.wire.json', sourceSha256: 'a'.repeat(64) });

describe('rich JSON wire manifests', () => {
  test('preserves nested, boolean and repeated transport data without output-schema fiction', () => {
    const form = make();
    const projection = project();
    expect(form.definition.format).toBe('typehtml-wire-form/1');
    expect(Object.hasOwn(form.definition, 'output')).toBe(false);
    expect(projection.format).toBe('typehtml-form-check/1');
    expect(projection.transport.fields.map((field) => [field.name, field.cardinality, field.missing])).toEqual([
      ['person.name', 'scalar', 'absent'], ['newsletter', 'scalar', 'false'], ['tags', 'repeated', 'empty-array'],
    ]);
    expect(Object.hasOwn(projection.transport, 'byName')).toBe(false);
    expect(projection.runtimeValidationCoverage).toBe('not-statically-analyzed');
    expect(validateRichFormCheck(JSON.parse(JSON.stringify(projection)))).toEqual(projection);
  });

  test('does not inspect or execute application validators when exporting wire data', () => {
    let calls = 0;
    const form = { id: 'opaque.form', path: '/opaque', fields: { active: { type: 'boolean' as const } },
      get input() { calls++; throw new Error('validator introspection'); },
      get output() { calls++; throw new Error('validator introspection'); },
    };
    expect(schemaFormWireManifest(form).fields.active).toEqual({ type: 'boolean' });
    expect(calls).toBe(0);
  });

  test('rejects top-level and nested getters before executing them', () => {
    let calls = 0;
    const definition = { id: 'bad.form', path: '/bad', get fields() { calls++; return {}; } };
    expect(() => defineWireForm(definition)).toThrow('data properties');
    const nested = { id: 'bad.form', path: '/bad', fields: { name: { type: 'string' as const, get maxLength() { calls++; return 20; } } } };
    expect(() => defineWireForm(nested)).toThrow('data properties');
    expect(calls).toBe(0);
    expect(() => defineWireForm({ ...make().definition, transport: { encoding: 'urlencoded', unexpected: true } } as never)).toThrow('transport');
  });

  test('snapshots mutable input without mutating or freezing caller data', () => {
    const fields = { name: { type: 'string' as const, maxLength: 20 } };
    const form = defineWireForm({ id: 'snapshot', path: '/snapshot', fields });
    fields.name.maxLength = 40;
    expect(form.definition.fields.name?.type).toBe('string');
    expect(form.definition.fields.name).toEqual({ type: 'string', maxLength: 20 });
    expect(Object.isFrozen(fields)).toBe(false);
    expect(Object.isFrozen(form.definition.fields.name)).toBe(true);
  });

  test('serializes bounded collections using canonical source declarations and exact normalized row metadata', () => {
    const identity = { '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => ({ value }) } };
    const form = defineSchemaForm({ id: 'rows.form', path: '/rows', fields: {}, input: identity, output: identity,
      collections: { items: { maxItems: 2, minItems: 1, rowKey: 'rowId', fields: {
        rowId: { type: 'string', required: true, minLength: 1, maxLength: 64 }, quantity: { type: 'integer', required: true },
      } } },
    });
    const manifest = schemaFormWireManifest(form);
    expect(Object.hasOwn(manifest.collections!.items!, 'path')).toBe(false);
    expect(Object.keys(manifest.fields)).toEqual([]);
    const check = projectWireForm(defineWireForm(manifest), { sourcePath: 'rows.json', sourceSha256: 'a'.repeat(64) });
    expect(check.transport.fields[0]?.row).toEqual({ collection: 'items', index: 0, member: 'rowId' });
    expect(validateRichFormCheck(JSON.parse(JSON.stringify(check)))).toEqual(check);
  });

  test('requires explicit bounded multipart and preserves upload declarations without content-proof claims', () => {
    const fields = { title: { type: 'string' as const } };
    expect(() => defineWireForm({ id: 'upload.form', path: '/upload', fields, uploads: { attachment: {} } })).toThrow('multipart');
    const form = defineWireForm({ id: 'upload.form', path: '/upload', fields,
      uploads: { attachment: { required: true, accept: ['.pdf', 'image/*'] } }, multipart: {},
    });
    const check = projectWireForm(form, { sourcePath: 'upload.json', sourceSha256: 'a'.repeat(64) });
    expect(check.action).toMatchObject({ encoding: 'multipart', parserProfile: 'bounded-multipart/1' });
    expect(check.multipart?.maxBytes).toBeGreaterThan(0);
    expect(check.uploads.attachment).toEqual({ required: true, accept: ['.pdf', 'image/*'] });
    expect(validateRichFormCheck(JSON.parse(JSON.stringify(check)))).toEqual(check);
    expect(() => defineWireForm({ ...form.definition, multipart: { maxFiles: -1 } })).toThrow('multipart limit');
    const fileOnly = defineWireForm({ id: 'upload.only', path: '/upload', fields: {}, uploads: { attachment: {} }, multipart: {} });
    expect(validateRichFormCheck(JSON.parse(JSON.stringify(projectWireForm(fileOnly, { sourcePath: 'file.json', sourceSha256: 'a'.repeat(64) }))))).toMatchObject({ action: { encoding: 'multipart' } });
    expect(() => defineWireForm({ ...form.definition, uploads: { title: {} } })).toThrow('overlap');
  });

  test('rejects inconsistent derived cardinality, codecs, digests and unknown projection fields', () => {
    const valid = project();
    for (const mutate of [
      (value: any) => { value.transport.fields[0].minOccurrences = 0; },
      (value: any) => { value.transport.repeatable = []; },
      (value: any) => { value.source.behaviorSha256 = 'f'.repeat(64); },
      (value: any) => { value.action.method = 'GET'; },
      (value: any) => { value.extra = true; },
      (value: any) => { value.runtimeValidationCoverage = 'checked'; },
    ]) {
      const tampered = JSON.parse(JSON.stringify(valid));
      mutate(tampered);
      expect(() => validateRichFormCheck(tampered)).toThrow();
    }
  });

  test('loads bounded JSON and verifies original bytes as well as regenerated behavior', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'typehtml-wire-manifest-'));
    try {
      const path = join(directory, 'source.json');
      await writeFile(path, JSON.stringify(make().definition));
      const loaded = await loadWireForm(path);
      const projection = projectWireForm(loaded.form, { sourcePath: 'source.json', sourceSha256: loaded.sourceSha256 });
      const projectionPath = join(directory, 'projection.json');
      await writeFile(projectionPath, JSON.stringify(projection));
      expect((await loadRichFormCheck(projectionPath)).formCheck).toEqual(projection);
      expect(() => verifyWireFormSource(projection, loaded)).not.toThrow();
      await writeFile(path, JSON.stringify(make().definition, null, 2));
      expect(() => verifyWireFormSource(projection, { ...loaded, sourceSha256: 'b'.repeat(64) })).toThrow('bytes');
      const changed = JSON.parse(JSON.stringify(projection));
      changed.transport.fields[0].maxOccurrences = 2;
      expect(() => verifyWireFormSource(changed, loaded)).toThrow('match its source');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
