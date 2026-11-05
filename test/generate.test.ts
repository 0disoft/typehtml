import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateFiles } from '../src/generate.ts';
import { loadBoundaryContract, loadFormCheck } from '../src/contract/load.ts';
import { verifyFormCheckSource } from '../src/contract/project.ts';

const CONTRACT = resolve(import.meta.dir, '../docs/design/v0.5/examples/order.boundary.json');

describe('generation delivery', () => {
  it('checks freshness, regenerates the complete bundle, and preserves unrelated output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'typehtml-generation-'));
    try {
      const contractPath = join(directory, 'contract.json');
      await writeFile(contractPath, await readFile(CONTRACT));
      const outDir = join(directory, 'generated');
      expect((await generateFiles({ contractPath, outDir })).status).toBe('written');
      expect((await generateFiles({ contractPath, outDir, check: true })).status).toBe('current');
      const formCheck = (await loadFormCheck(join(outDir, 'form-check.generated.json'))).formCheck;
      expect(formCheck.source.path).toBe('../contract.json');
      const source = await loadBoundaryContract(contractPath);
      expect(() => verifyFormCheckSource(formCheck, source)).not.toThrow();
      const generated = join(outDir, 'order-contract.ts');
      await writeFile(generated, 'stale');
      expect((await generateFiles({ contractPath, outDir, check: true })).files).toEqual(['order-contract.ts']);
      expect(await readFile(generated, 'utf8')).toBe('stale');
      expect((await generateFiles({ contractPath, outDir })).status).toBe('written');
      await writeFile(join(outDir, 'keep.txt'), 'user file');
      await writeFile(generated, 'stale again');
      await expect(generateFiles({ contractPath, outDir })).rejects.toThrow('unrelated files');
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
      await expect(generateFiles({ contractPath, outDir: join(alias, 'generated') }))
        .rejects.toThrow('authoritative source resolves inside');
      expect(await readFile(contractPath, 'utf8')).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
