import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { VERSION } from '../src/version.ts';

const CLI = resolve(import.meta.dir, '../src/cli.ts');
function cli(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args]);
  return { exitCode: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}

describe('TypeHTML CLI', () => {
  it('provides a version and discoverable noninteractive commands', () => {
    const version = cli('--version');
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe(VERSION);
    const help = cli('--help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('typehtml init <directory>');
    expect(help.stdout).toContain('--form <file>');
    expect(help.stdout).toContain('--package-source <local.tgz>');
    expect(help.stdout).toContain('--runtime bun|node');
    expect(help.stdout).toContain('does not install dependencies');
  });

  it('rejects duplicate or unsupported options with one JSON error report', () => {
    for (const args of [[], ['init'], ['init', 'app', '--package-manager', 'yarn'], ['init', 'a', 'b'], ['init', 'app', '--runtime'], ['init', 'app', '--runtime', 'deno'], ['init', 'app', '--runtime', 'node', '--runtime', 'bun'], ['init', 'app', '--package-source'], ['init', 'app', '--package-source', '--package-manager', 'npm'], ['init', 'app', '--package-source', 'a.tgz', '--package-source', 'b.tgz'], ['generate', '--form', 'a', '--contract', 'b', '--out-dir', 'out']]) {
      const result = cli(...args);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout).status).toBe('configuration-error');
      expect(result.stderr).toBe('');
    }
  });

  it('creates a Node starter with Bun as the independently selected package manager', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'typehtml-cli-node-'));
    try {
      const directory = join(parent, 'node app');
      const result = cli('init', directory, '--runtime', 'node', '--package-manager', 'bun');
      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.runtime).toBe('Node.js >=22.0.0');
      expect(report.packageManager).toBe('bun');
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      expect(manifest.scripts.build).toBe('bun run generate && tsc');
      expect(manifest.scripts.dev).toBe('bun run build && node build/server.js');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('resolves a relative local package path and copies it into a starter containing spaces', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'typehtml-cli-package-'));
    try {
      const archive = gzipSync('archive fixture');
      await writeFile(join(parent, 'local package.tgz'), archive);
      const result = Bun.spawnSync([process.execPath, CLI, 'init', 'app with spaces', '--package-source', 'local package.tgz', '--package-manager', 'npm'], { cwd: parent });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe('');
      const report = JSON.parse(result.stdout.toString());
      expect(report.files).toContain('vendor/typehtml.tgz');
      const target = join(parent, 'app with spaces');
      const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
      expect(manifest.dependencies['@0disoft/typehtml']).toBe('file:./vendor/typehtml.tgz');
      expect((await readFile(join(target, 'vendor/typehtml.tgz'))).equals(archive)).toBe(true);
      const invalid = cli('init', join(parent, 'invalid app'), '--package-source', join(parent, 'missing.tgz'));
      expect(invalid.exitCode).toBe(2);
      expect(JSON.parse(invalid.stdout).status).toBe('error');
      expect(invalid.stderr).toBe('');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('creates a standalone starter using paths containing spaces', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'typehtml-cli-init-'));
    try {
      const target = join(parent, 'app with spaces');
      const result = cli('init', target, '--package-manager', 'npm');
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).packageManager).toBe('npm');
      expect(JSON.parse(await readFile(join(target, 'form.json'), 'utf8')).id).toBe('greeting.create');
      const retry = cli('init', target);
      expect(retry.exitCode).toBe(2);
      expect(JSON.parse(retry.stdout).status).toBe('error');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('emits requested text and SARIF formats while retaining execution failure status', () => {
    const text = cli('doctor', '--config', 'missing-doctor-file.json', '--format', 'text');
    expect(text.exitCode).toBe(2);
    expect(text.stdout).toContain('TypeHTML Doctor: configuration-error; exit 2');
    const sarif = cli('doctor', '--config', 'missing-doctor-file.json', '--format', 'sarif');
    expect(sarif.exitCode).toBe(2);
    expect(JSON.parse(sarif.stdout).version).toBe('2.1.0');
    expect(JSON.parse(sarif.stdout).runs[0].invocations[0].executionSuccessful).toBe(false);
    for (const flags of [['--format', 'xml'], ['--format', 'text', '--format', 'json'], ['--watch', '--watch']]) {
      expect(cli('doctor', '--config', 'missing.json', ...flags).exitCode).toBe(2);
    }
  });
});
