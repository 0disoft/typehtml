import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
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
      expect(await readFile(join(directory, 'app.ts'), 'utf8')).toContain("from './generated/form-definition.ts'");
      expect(await readFile(join(directory, 'server.ts'), 'utf8')).toContain('Bun.serve');
      expect(manifest.scripts.check).toBe('npm run generate:check && npm run typecheck && npm run doctor');
      expect(await readFile(join(directory, 'index.html'), 'utf8')).toContain('id="greeting"');
      expect(await readdir(directory)).not.toContain('node_modules');
      expect((await readdir(parent)).filter((name) => name.startsWith('.typehtml-init-'))).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('selects runtime independently from the package manager and configures emitted Node ESM', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'typehtml-init-runtime-'));
    try {
      for (const runtime of ['bun', 'node'] as const) {
        for (const packageManager of ['bun', 'npm'] as const) {
          const directory = join(parent, `${runtime}-${packageManager}`);
          const result = await initProject({ directory, runtime, packageManager });
          const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
          const config = JSON.parse(await readFile(join(directory, 'tsconfig.json'), 'utf8'));
          const server = await readFile(join(directory, 'server.ts'), 'utf8');
          expect(result.packageManager).toBe(packageManager);
          expect(result.runtime).toBe(runtime === 'node' ? 'Node.js >=22.0.0' : 'Bun >=1.4.0');
          expect(result.nextCommands[2]).toEqual([packageManager, 'run', 'check']);
          expect(manifest.scripts.check).toBe(`${packageManager} run generate:check && ${packageManager} run typecheck && ${packageManager} run doctor`);
          expect(manifest.devDependencies.typescript).toBe('^7');
          expect(server).toContain("from './app.ts'");
          if (runtime === 'node') {
            expect(manifest.engines).toEqual({ node: '>=22.0.0' });
            expect(manifest.devDependencies['@types/node']).toBe('^22');
            expect(manifest.scripts.build).toBe(`${packageManager} run generate && tsc`);
            expect(manifest.scripts.dev).toBe(`${packageManager} run build && node build/server.js`);
            expect(config.compilerOptions.outDir).toBe('build');
            expect(config.compilerOptions.rewriteRelativeImportExtensions).toBe(true);
            expect(server).toContain("from '@0disoft/typehtml/adapters/node'");
            expect(server).toContain("new URL('../index.html', import.meta.url)");
            expect(server).not.toContain('Bun');
          } else {
            expect(manifest.engines).toEqual({ bun: '>=1.4.0' });
            expect(config.compilerOptions.noEmit).toBe(true);
            expect(server).toContain('Bun.serve');
          }
        }
      }
      const nodeApp = await readFile(join(parent, 'node-npm/app.ts'), 'utf8');
      expect(nodeApp).toBe(await readFile(join(parent, 'bun-bun/app.ts'), 'utf8'));
      const invalid = join(parent, 'invalid');
      await expect(initProject({ directory: invalid, runtime: 'deno' as never })).rejects.toThrow('runtime must be bun or node');
      expect(await readdir(parent)).not.toContain('invalid');
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

  it('vendors a local archive without installation and keeps its dependency portable after moving the app', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'typehtml-init-package-'));
    try {
      const source = join(parent, 'local package.tgz');
      // The initializer copies gzip bytes; package managers validate tar/package contents at installation.
      const archive = gzipSync('archive fixture');
      await writeFile(source, archive);
      const directory = join(parent, 'app');
      const result = await initProject({ directory, packageManager: 'npm', packageSource: source });
      expect(result.files).toContain('vendor/typehtml.tgz');
      expect(result.nextCommands[0]).toEqual(['npm', 'install']);
      expect((await readFile(join(directory, 'vendor/typehtml.tgz'))).equals(archive)).toBe(true);
      const moved = join(parent, 'moved app');
      await rename(directory, moved);
      const manifest = JSON.parse(await readFile(join(moved, 'package.json'), 'utf8'));
      expect(manifest.dependencies['@0disoft/typehtml']).toBe('file:./vendor/typehtml.tgz');
      expect((await readFile(join(moved, 'vendor/typehtml.tgz'))).equals(archive)).toBe(true);
      expect((await readFile(source)).equals(archive)).toBe(true);
      expect(await readdir(moved)).not.toContain('node_modules');
      expect((await readdir(parent)).filter((name) => name.startsWith('.typehtml-init-'))).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects invalid package sources before creating or changing a starter target', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'typehtml-init-bad-package-'));
    try {
      const empty = join(parent, 'existing empty app');
      await mkdir(empty);
      const text = join(parent, 'text.tgz');
      const short = join(parent, 'short.tgz');
      const large = join(parent, 'large.tgz');
      const directory = join(parent, 'directory.tgz');
      await writeFile(text, 'not gzip');
      await writeFile(short, new Uint8Array([0x1f]));
      await writeFile(large, '');
      await truncate(large, 64 * 1024 * 1024 + 1);
      await mkdir(directory);
      const sources = ['', 'wrong.zip', join(parent, 'missing.tgz'), text, short, large, directory];
      for (const packageSource of sources) {
        await expect(initProject({ directory: empty, packageSource })).rejects.toThrow();
        expect(await readdir(empty)).toEqual([]);
        expect((await readdir(parent)).filter((name) => name.startsWith('.typehtml-init-'))).toEqual([]);
      }
      const absent = join(parent, 'not-created', 'app');
      await expect(initProject({ directory: absent, packageSource: text })).rejects.toThrow('gzip');
      expect(await readdir(parent)).not.toContain('not-created');
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
