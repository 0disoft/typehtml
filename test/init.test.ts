import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../src/init.ts';
import { VERSION } from '../src/version.ts';

describe('standalone starter creation', () => {
  it('creates a standalone manifest-based Bun app without installing or starting anything', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'typehtml-init-'));
    try {
      const directory = join(parent, 'My App');
      const result = await initProject({ directory, packageManager: 'npm' });
      expect(result.runtime).toBe('Bun >=1.4.0');
      expect(result.nextCommands[0]).toEqual(['npm', 'install']);
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      expect(manifest.name).toBe('my-app');
      expect(manifest.dependencies['@0disoft/typehtml']).toBe(`^${VERSION}`);
      expect(manifest.scripts.generate).toContain('--form form.json');
      expect(manifest.scripts.dev).toContain('bun run generate');
      expect(JSON.parse(await readFile(join(directory, 'form.json'), 'utf8')).format).toBe('typehtml-form/1');
      expect(await readFile(join(directory, 'server.ts'), 'utf8')).toContain("from './generated/form-definition.ts'");
      expect(await readFile(join(directory, 'index.html'), 'utf8')).toContain('id="greeting"');
      expect(await readdir(directory)).not.toContain('node_modules');
      expect((await readdir(parent)).filter((name) => name.startsWith('.typehtml-init-'))).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('populates an existing empty target and refuses nonempty targets unchanged', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'typehtml-init-existing-'));
    try {
      const empty = join(parent, 'empty');
      await mkdir(empty);
      await initProject({ directory: empty });
      const original = await readFile(join(empty, 'package.json'), 'utf8');
      await expect(initProject({ directory: empty })).rejects.toThrow('not empty');
      expect(await readFile(join(empty, 'package.json'), 'utf8')).toBe(original);
      const occupied = join(parent, 'occupied');
      await mkdir(occupied);
      await writeFile(join(occupied, 'keep.txt'), 'keep');
      await expect(initProject({ directory: occupied })).rejects.toThrow('not empty');
      expect(await readdir(occupied)).toEqual(['keep.txt']);
      expect(await readFile(join(occupied, 'keep.txt'), 'utf8')).toBe('keep');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('does not follow a directory junction or overwrite a file target', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'typehtml-init-links-'));
    try {
      const actual = join(parent, 'actual');
      await mkdir(actual);
      const linked = join(parent, 'linked');
      await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(initProject({ directory: linked })).rejects.toThrow('real directory');
      expect(await readdir(actual)).toEqual([]);
      const file = join(parent, 'file');
      await writeFile(file, 'user work');
      await expect(initProject({ directory: file })).rejects.toThrow('real directory');
      expect(await readFile(file, 'utf8')).toBe('user work');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
