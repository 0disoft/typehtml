import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFormCatalog, renderFormCatalog, serializeFormCatalog, CATALOG_LIMITS } from '../src/catalog/index.ts';
import { writeFormCatalog } from '../src/catalog/files.ts';
import { defineForm, type DefinedForm } from '../src/form/definition.ts';
import { defineSchemaForm } from '../src/form/schema-form.ts';
import { DEFAULT_MAX_BYTES } from '../src/contract/strict-json.ts';

const schema = { type: 'object', additionalProperties: false, required: ['name'], properties: {
  name: { type: 'string', minLength: 1, maxLength: 80 }, count: { type: 'integer', minimum: 0, maximum: 99 },
} } as const;
const definition = { format: 'typehtml-form/1', id: 'profile.save', path: '/profile', input: schema, output: schema, protocol: { requestKey: 'required' } } as const;
const form = defineForm(definition);

describe('read-only form catalog', () => {
  it('preserves declaration order, bounds, protocols and freezes independent snapshots', () => {
    const catalog = createFormCatalog([form]);
    expect(catalog.forms[0]!.fields.map((field) => field.name)).toEqual(Object.keys(form.input.schema.properties));
    expect(catalog.forms[0]!.fields.find((field) => field.name === 'name')!.required).toBe(true);
    expect(catalog.forms[0]!.fields.find((field) => field.name === 'count')).toMatchObject({ required: false, schema: schema.properties.count });
    expect(catalog.forms[0]!.protocolFields).toEqual(['_bc_csrf', '_bc_request']);
    expect(catalog.forms[0]!.fields[0]!.schema).not.toBe(form.input.schema.properties.name);
    expect(Object.isFrozen(catalog.forms[0]!.fields[0]!.schema)).toBe(true);
    expect(JSON.parse(serializeFormCatalog(catalog))).toEqual(catalog);
    expect(catalog.applicationCompleteness).toBe('not-evaluated');
  });

  it('never invokes or serializes vendor validators or claims their runtime coverage', () => {
    const validator = { '~standard': { version: 1 as const, vendor: 'private-vendor-secret', validate: () => { throw new Error('must not execute'); } } };
    const rich = defineSchemaForm({ id: 'settings.save', path: '/settings', fields: {
      'user.email': { type: 'string', required: true }, tags: { type: 'array', items: { type: 'string' }, maxItems: 4 }, notify: { type: 'boolean' },
    }, input: validator, output: validator });
    const catalog = createFormCatalog([form, rich]);
    expect(catalog.forms[1]!.fields.map((field) => field.name)).toEqual(['user.email', 'tags', 'notify']);
    expect(catalog.forms[1]!.validation).toBe('standard-schema-not-statically-analyzed');
    expect(serializeFormCatalog(catalog)).not.toContain('private-vendor-secret');
    expect(catalog.forms[1]!.protocolFields).toEqual(['_bc_csrf']);
  });

  it('escapes titles and constraint data and renders no active forms, scripts or collapsed sections', () => {
    const hostile = defineForm({ ...definition, input: { ...schema, properties: { name: { type: 'string', enum: ['</pre><script>alert("x")</script>'] } } } });
    const html = renderFormCatalog(createFormCatalog([hostile], { title: '<img src=x onerror=alert(1)>' }));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;/pre&gt;&lt;script&gt;');
    for (const tag of ['<form', '<input', '<script', '<details', '<img']) expect(html).not.toContain(tag);
    expect(html).toContain("form-action 'none'");
    expect(html).toContain('HTML 422'); expect(html).toContain('303 redirect');
  });

  it('rejects duplicate registrations and bounds forms, fields and output', () => {
    expect(() => createFormCatalog([form, form])).toThrow('duplicate');
    expect(() => createFormCatalog([])).toThrow('count');
    expect(() => createFormCatalog(Array(CATALOG_LIMITS.maxForms + 1).fill(form))).toThrow('count');
    expect(createFormCatalog([form], { title: 'a'.repeat(200) }).title.length).toBe(200);
    expect(() => createFormCatalog([form], { title: 'a'.repeat(201) })).toThrow('title');
    const fields = Object.fromEntries(Array.from({ length: 1_024 }, (_, index) => [`field${index}`, { type: 'string' as const }]));
    const validator = { '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => ({ value }) } };
    const many = Array.from({ length: 9 }, (_, index) => defineSchemaForm({ id: `form${index}`, path: `/form${index}`, fields, input: validator, output: validator }));
    expect(createFormCatalog(many.slice(0, 8)).forms.length).toBe(8);
    expect(() => createFormCatalog(many)).toThrow('field limit');
    const huge = { ...createFormCatalog([form]), title: 'x'.repeat(CATALOG_LIMITS.maxBytes) };
    expect(() => serializeFormCatalog(huge)).toThrow('byte limit');
  });

  it('accepts the exact UTF-8 JSON limit and stops before later forms at one byte over', () => {
    const sized = (index: number, value: string) => defineForm({ ...definition, id: `sized${index}`, path: `/sized${index}`,
      input: { ...schema, properties: { name: { type: 'string', const: value } } } });
    const prefix = Array.from({ length: 7 }, (_, index) => sized(index, 'x'.repeat(1_000_000)));
    const unicode = '한글😀\n\\"';
    const initial = [...prefix, sized(7, unicode)];
    const options = { title: 'UTF-8 한글 "catalog"' };
    const initialBytes = new TextEncoder().encode(serializeFormCatalog(createFormCatalog(initial, options))).byteLength;
    const padding = 'x'.repeat(CATALOG_LIMITS.maxBytes - initialBytes);
    const exact = [...prefix, sized(7, unicode + padding)];
    expect(new TextEncoder().encode(serializeFormCatalog(createFormCatalog(exact, options))).byteLength).toBe(CATALOG_LIMITS.maxBytes);
    const oversized: DefinedForm[] = [...prefix, sized(7, unicode + padding + 'x')];
    let laterRead = false;
    Object.defineProperty(oversized, 8, { get: () => { laterRead = true; throw new Error('later form must not be accessed'); } });
    expect(() => createFormCatalog(oversized, options)).toThrow('catalog byte limit exceeded');
    expect(laterRead).toBe(false);
  });

  it('checks the field count before accessing overflowing field schemas', () => {
    const fields = Object.fromEntries(Array.from({ length: 1_024 }, (_, index) => [`field${index}`, { type: 'string' as const }]));
    const validator = { '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => ({ value }) } };
    const accepted = Array.from({ length: 8 }, (_, index) => defineSchemaForm({ id: `bounded${index}`, path: `/bounded${index}`, fields, input: validator, output: validator }));
    let schemaRead = false;
    const overflow = { ...accepted[0]!, id: 'overflow', path: '/overflow', fields: new Proxy(fields, {
      get: () => { schemaRead = true; throw new Error('overflowing schema must not be accessed'); },
    }) };
    expect(() => createFormCatalog([...accepted, overflow])).toThrow('catalog field limit exceeded');
    expect(schemaRead).toBe(false);
  });
});

describe('static catalog files and CLI', () => {
  async function fixture(run: (root: string, configPath: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'typehtml-catalog-'));
    try {
      await writeFile(join(root, 'form.json'), JSON.stringify(definition));
      const configPath = join(root, 'catalog-config.json');
      await writeFile(configPath, JSON.stringify({ format: 'typehtml-catalog/1', forms: ['./form.json'] }));
      await run(root, configPath);
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  it('loads only bounded static manifests and refuses to replace any existing directory', async () => fixture(async (root, configPath) => {
    const directory = join(root, 'catalog output');
    expect((await writeFormCatalog({ configPath, directory })).forms).toBe(1);
    expect(JSON.parse(await readFile(join(directory, 'catalog.json'), 'utf8')).forms[0].id).toBe('profile.save');
    expect(await readFile(join(directory, 'index.html'), 'utf8')).toContain('profile.save');
    await expect(writeFormCatalog({ configPath, directory })).rejects.toThrow();
    await expect(writeFormCatalog({ configPath, directory: root })).rejects.toThrow('outside output');
    await mkdir(join(root, 'docs', 'design'), { recursive: true });
    await expect(writeFormCatalog({ configPath, directory: join(root, 'docs', 'design', 'catalog') })).rejects.toThrow('immutable');
  }));

  it('rejects duplicate JSON members, executable modules, unknown config keys and symlink escapes', async () => fixture(async (root, configPath) => {
    const directory = join(root, 'output');
    await writeFile(configPath, '{"format":"typehtml-catalog/1","forms":[],"forms":["form.json"]}');
    await expect(writeFormCatalog({ configPath, directory })).rejects.toThrow('DUPLICATE_JSON_MEMBER');
    await writeFile(join(root, 'module.ts'), 'throw new Error("application module executed");');
    await writeFile(configPath, JSON.stringify({ format: 'typehtml-catalog/1', forms: ['./module.ts'] }));
    await expect(writeFormCatalog({ configPath, directory })).rejects.toThrow('JSON');
    await writeFile(configPath, JSON.stringify({ format: 'typehtml-catalog/1', forms: ['./form.json'], execute: true }));
    await expect(writeFormCatalog({ configPath, directory })).rejects.toThrow('config');
    await mkdir(join(root, 'nested'));
    await symlink(root, join(root, 'nested', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const nestedConfig = join(root, 'nested', 'config.json');
    await writeFile(nestedConfig, JSON.stringify({ format: 'typehtml-catalog/1', forms: ['./escape/form.json'] }));
    await expect(writeFormCatalog({ configPath: nestedConfig, directory })).rejects.toThrow('within');
  }));

  it('enforces the exact cumulative source limit before parsing later files', async () => fixture(async (root, configPath) => {
    const paths = Array.from({ length: 4 }, (_, index) => `./sized${index}.json`);
    const config = JSON.stringify({ format: 'typehtml-catalog/1', forms: paths });
    const configBytes = new TextEncoder().encode(config).byteLength;
    await writeFile(configPath, config);
    const texts = paths.map((_, index) => JSON.stringify({ ...definition, id: `source${index}`, path: `/source${index}` }));
    for (let index = 0; index < paths.length; index++) {
      const bytes = index < 3 ? DEFAULT_MAX_BYTES : CATALOG_LIMITS.maxSourceBytes - configBytes - 3 * DEFAULT_MAX_BYTES;
      const text = texts[index]!;
      await writeFile(join(root, paths[index]!), text + ' '.repeat(bytes - new TextEncoder().encode(text).byteLength));
    }
    expect((await writeFormCatalog({ configPath, directory: join(root, 'exact source limit') })).forms).toBe(4);
    const lastPath = join(root, paths[3]!);
    await writeFile(lastPath, (await readFile(lastPath, 'utf8')) + ' ');
    await expect(writeFormCatalog({ configPath, directory: join(root, 'one byte over') })).rejects.toThrow('catalog source byte limit exceeded');
    await writeFile(configPath, JSON.stringify({ format: 'typehtml-catalog/1', forms: [...paths, './missing-later.json'] }));
    await expect(writeFormCatalog({ configPath, directory: join(root, 'skip later file') })).rejects.toThrow('catalog source byte limit exceeded');
  }));

  it('rejects repeated sources and duplicate IDs/routes before loading later manifests', async () => fixture(async (root, configPath) => {
    for (const second of ['./form.json', './duplicate.json']) {
      await writeFile(join(root, 'duplicate.json'), JSON.stringify(definition));
      await writeFile(configPath, JSON.stringify({ format: 'typehtml-catalog/1', forms: ['./form.json', second, './missing-later.json'] }));
      await expect(writeFormCatalog({ configPath, directory: join(root, 'no output') })).rejects.toThrow('duplicate catalog');
    }
    await writeFile(join(root, 'duplicate.json'), JSON.stringify({ ...definition, id: 'different.id' }));
    await writeFile(configPath, JSON.stringify({ format: 'typehtml-catalog/1', forms: ['./form.json', './duplicate.json', './missing-later.json'] }));
    await expect(writeFormCatalog({ configPath, directory: join(root, 'no output') })).rejects.toThrow('duplicate catalog form ID or route');
  }));

  it('exposes catalog help, produces JSON success and reports usage/errors with exit 2', async () => fixture(async (root, configPath) => {
    const cli = (...args: string[]) => Bun.spawnSync([process.execPath, resolve(import.meta.dir, '../src/cli.ts'), ...args]);
    const result = cli('catalog', '--config', configPath, '--out-dir', join(root, 'CLI output'));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).forms).toBe(1);
    expect(cli('--help').stdout.toString()).toContain('typehtml catalog');
    for (const args of [['catalog'], ['catalog', '--config', configPath, '--config', configPath], ['catalog', '--config', 'missing.json', '--out-dir', join(root, 'new')]]) {
      const bad = cli(...args);
      expect(bad.exitCode).toBe(2); expect(JSON.parse(bad.stdout.toString()).status).toMatch(/error/);
    }
  }));
});
