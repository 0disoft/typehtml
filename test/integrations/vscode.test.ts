import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLaunchPlan, validateLaunchFiles } from '../../integrations/vscode/src/config.ts';
import { DoctorSessionManager, type ManagedClient } from '../../integrations/vscode/src/lifecycle.ts';

const root = resolve('workspace with spaces');

describe('VS Code saved-snapshot launch configuration', () => {
  test('never resolves workspace executables without trust, local files, and explicit opt-in', () => {
    expect(createLaunchPlan(root, false, 'file', { doctorConfig: {}, cliPath: {} })).toBeNull();
    expect(createLaunchPlan(root, true, 'vscode-vfs', { doctorConfig: {} })).toBeNull();
    expect(createLaunchPlan(root, true, 'file', {})).toBeNull();
    expect(createLaunchPlan(root, true, 'file', { doctorConfig: '' })).toBeNull();
  });

  test('keeps arguments separate and literal, including whitespace and shell metacharacters', () => {
    const config = 'snapshots/a; $(no-execution).json';
    const plan = createLaunchPlan(root, true, 'file', { doctorConfig: config, nodePath: 'node' })!;
    expect(plan.command).toBe('node');
    expect(plan.args).toEqual([resolve(root, 'node_modules/@0disoft/typehtml/dist/cli.js'), 'lsp', '--config', resolve(root, config)]);
    expect(Object.isFrozen(plan.args)).toBe(true);
  });

  test('rejects traversal, absolute workspace paths, nonstrings, and control characters', () => {
    for (const doctorConfig of ['../escape.json', resolve(root, 'config.json'), '.', 'x\0.json', '\n', {}, 1]) {
      expect(() => createLaunchPlan(root, true, 'file', { doctorConfig })).toThrow();
    }
    expect(() => createLaunchPlan(root, true, 'file', { doctorConfig: 'config.json', cliPath: '../cli.js' })).toThrow();
    expect(() => createLaunchPlan(root, true, 'file', { doctorConfig: 'config.json', nodePath: 'node\n' })).toThrow();
  });

  test('checks real files and rejects filesystem links escaping the workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'typehtml-vscode-'));
    try {
      const workspace = join(directory, 'workspace');
      const external = join(directory, 'external');
      await Promise.all([mkdir(workspace), mkdir(external)]);
      await Promise.all([writeFile(join(workspace, 'cli.js'), ''), writeFile(join(workspace, 'config.json'), '{}'), writeFile(join(external, 'config.json'), '{}')]);
      const plan = createLaunchPlan(workspace, true, 'file', { cliPath: 'cli.js', doctorConfig: 'config.json' })!;
      const checked = await validateLaunchFiles(plan);
      expect(checked.args).toEqual([await realpath(plan.cli), 'lsp', '--config', await realpath(plan.config)]);
      await symlink(external, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      const escaped = createLaunchPlan(workspace, true, 'file', { cliPath: 'cli.js', doctorConfig: 'linked/config.json' })!;
      await expect(validateLaunchFiles(escaped)).rejects.toThrow('resolve inside');
      await expect(validateLaunchFiles({ ...plan, config: workspace })).rejects.toThrow();
      await expect(validateLaunchFiles({ ...plan, cli: join(workspace, 'missing.js') })).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

describe('VS Code language client lifetime', () => {
  test('stops and disposes the previous client before any replacement starts', async () => {
    const events: string[] = [];
    const stopping = gate();
    const manager = new DoctorSessionManager<string>(async (id) => ({
      start: async () => { events.push(`start:${id}`); },
      stop: async () => { events.push(`stop:${id}`); if (id === 'one') await stopping.promise; },
      dispose: async () => { events.push(`dispose:${id}`); },
    }), (error) => { throw error; });
    await manager.refresh(['one']);
    const replacing = manager.refresh(['two']);
    await Promise.resolve();
    expect(events).toEqual(['start:one', 'stop:one']);
    stopping.open();
    await replacing;
    expect(events).toEqual(['start:one', 'stop:one', 'dispose:one', 'start:two']);
    await manager.dispose();
    await manager.dispose();
    expect(events.slice(-2)).toEqual(['stop:two', 'dispose:two']);
    expect(events.filter((event) => event === 'dispose:two')).toHaveLength(1);
  });

  test('disposes failed-start clients and continues after a stop failure', async () => {
    const events: string[] = [];
    const errors: unknown[] = [];
    const manager = new DoctorSessionManager<string>(async (id) => ({
      start: async () => { events.push(`start:${id}`); if (id === 'bad') throw new Error('start failed'); },
      stop: async () => { events.push(`stop:${id}`); if (id === 'bad') throw new Error('stop failed'); },
      dispose: async () => { events.push(`dispose:${id}`); },
    }), (error) => { errors.push(error); });
    await manager.refresh(['bad', 'good']);
    expect(events).toEqual(['start:bad', 'stop:bad', 'dispose:bad', 'start:good']);
    expect(errors.map((error) => (error as Error).message)).toEqual(['start failed', 'stop failed']);
    await manager.dispose();
    expect(events.slice(-2)).toEqual(['stop:good', 'dispose:good']);
  });

  test('disposal during startup suppresses queued launches and waits for cleanup', async () => {
    const started = gate();
    const release = gate();
    const events: string[] = [];
    const client: ManagedClient = {
      start: async () => { events.push('start'); started.open(); await release.promise; },
      stop: async () => { events.push('stop'); },
      dispose: async () => { events.push('dispose'); },
    };
    const manager = new DoctorSessionManager<string>(async () => client, (error) => { throw error; });
    const first = manager.refresh(['one']);
    await started.promise;
    const queued = manager.refresh(['two']);
    const done = manager.dispose();
    release.open();
    await Promise.all([first, queued, done]);
    expect(events).toEqual(['start', 'stop', 'dispose']);
    await manager.refresh(['three']);
    expect(events).toEqual(['start', 'stop', 'dispose']);
  });

  test('a nonresponsive server reaches its startup deadline and releases the client', async () => {
    const events: string[] = [];
    const errors: unknown[] = [];
    const manager = new DoctorSessionManager<string>(async () => ({
      start: () => new Promise<void>(() => {}),
      stop: async () => { events.push('stop'); },
      dispose: async () => { events.push('dispose'); },
    }), (error) => { errors.push(error); }, 1);
    await manager.refresh(['stalled']);
    expect(events).toEqual(['stop', 'dispose']);
    expect((errors[0] as Error).message).toContain('startup deadline');
    await manager.dispose();
    expect(events).toEqual(['stop', 'dispose']);
  });
});
