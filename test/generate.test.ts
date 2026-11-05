import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateFiles } from '../src/generate.ts';
import { loadBoundaryContract, loadFormCheck } from '../src/contract/load.ts';
import { verifyFormCheckSource } from '../src/contract/project.ts';
import { runDoctor } from '../src/doctor/analyze.ts';

const CONTRACT = resolve(import.meta.dir, '../docs/design/v0.5/examples/order.boundary.json');

describe('generation delivery', () => {
  it('generates and verifies a generic manifest in a project without the repository design tree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'typehtml-generic-generation-'));
    try {
      const contractPath = join(directory, 'form.json');
      const definition = { format: 'typehtml-form/1', id: 'newsletter.subscribe', path: '/subscribe',
        input: { type: 'object', additionalProperties: false, required: ['email'], properties: { email: { type: 'string', minLength: 1, maxLength: 80 } } },
        output: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', const: 'subscribed' } } },
      };
      await writeFile(contractPath, JSON.stringify(definition));
      const options = { contractPath, outDir: join(directory, 'generated'), rootDir: directory };
      const generated = await generateFiles(options);
      expect(generated.files).toContain('form-definition.ts');
      expect(generated.files).toContain('form-types.ts');
      expect(generated.files).not.toContain('order-contract.ts');
      expect((await generateFiles({ ...options, check: true })).status).toBe('current');
      await writeFile(join(directory, 'index.html'), '<form id="newsletter" action="/subscribe" method="post"><input name="_bc_csrf" type="hidden" value="synthetic"><input name="email"><button>Subscribe</button></form>');
      const configPath = join(directory, 'doctor.json');
      await writeFile(configPath, JSON.stringify({ format: 'boundary-doctor/0.5-draft', root: directory,
        inputs: [{ kind: 'form-projection', path: 'generated/form-check.generated.json' }],
        documents: [{ path: 'index.html', documentUrl: 'https://example.invalid/', sourceKind: 'rendered-snapshot', executionAssumption: 'native-no-script-by-example', bindings: [{ formId: 'newsletter', actionId: 'newsletter.subscribe', required: true }] }],
      }));
      expect((await runDoctor(configPath)).exitCode).toBe(0);
      definition.input.properties.email.maxLength = 40;
      await writeFile(contractPath, JSON.stringify(definition));
      expect((await generateFiles({ ...options, check: true })).status).toBe('stale');
      const stale = await runDoctor(configPath);
      expect(stale.exitCode).toBe(3);
      expect(stale.findings.some((finding) => finding.ruleId === 'BC193')).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('checks freshness, regenerates the complete bundle, and preserves unrelated output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'typehtml-generation-'));
    try {
      const contractPath = join(directory, 'contract.json');
      await writeFile(contractPath, await readFile(CONTRACT));
      const outDir = join(directory, 'generated');
      const options = { contractPath, outDir, rootDir: directory };
      expect((await generateFiles(options)).status).toBe('written');
      expect((await generateFiles({ ...options, check: true })).status).toBe('current');
      const formCheck = (await loadFormCheck(join(outDir, 'form-check.generated.json'))).formCheck;
      expect(formCheck.source.path).toBe('contract.json');
      const source = await loadBoundaryContract(contractPath);
      expect(() => verifyFormCheckSource(formCheck, source)).not.toThrow();
      const generated = join(outDir, 'order-contract.ts');
      await writeFile(generated, 'stale');
      expect((await generateFiles({ ...options, check: true })).files).toEqual(['order-contract.ts']);
      expect(await readFile(generated, 'utf8')).toBe('stale');
      expect((await generateFiles(options)).status).toBe('written');
      await writeFile(join(outDir, 'keep.txt'), 'user file');
      await writeFile(generated, 'stale again');
      await expect(generateFiles(options)).rejects.toThrow('unrelated files');
      expect(await readFile(join(outDir, 'keep.txt'), 'utf8')).toBe('user file');
      expect(await readFile(generated, 'utf8')).toBe('stale again');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses to modify immutable design snapshots', async () => {
    await expect(generateFiles({ contractPath: CONTRACT, outDir: resolve(import.meta.dir, '../docs/design/v0.5/reference') }))
      .rejects.toThrow('immutable');
    await expect(generateFiles({ contractPath: CONTRACT, outDir: resolve(import.meta.dir, '../docs/design/..generated') }))
      .rejects.toThrow('immutable');
  });

  it('keeps checked-in runtime types and form projections current', async () => {
    expect((await generateFiles({ contractPath: CONTRACT, outDir: resolve(import.meta.dir, '../src/generated'), check: true })).status).toBe('current');
  });

  it('preserves an authoritative source reached through an output parent junction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'typehtml-generation-junction-'));
    try {
      const realParent = join(directory, 'real');
      const actualOut = join(realParent, 'generated');
      await mkdir(actualOut, { recursive: true });
      const contractPath = join(actualOut, 'form-check.generated.json');
      const original = await readFile(CONTRACT, 'utf8');
      await writeFile(contractPath, original);
      const alias = join(directory, 'alias');
      await symlink(realParent, alias, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(generateFiles({ contractPath, outDir: join(alias, 'generated'), rootDir: directory }))
        .rejects.toThrow('authoritative source resolves inside');
      expect(await readFile(contractPath, 'utf8')).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
