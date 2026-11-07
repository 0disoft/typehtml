import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLaunchPlan, validateLaunchFiles } from '../../integrations/vscode/src/config.ts';
import { DoctorSessionManager, type ManagedClient } from '../../integrations/vscode/src/lifecycle.ts';
import { DoctorProcess } from '../../integrations/vscode/src/process.ts';
import { forwardSavedDocumentOpen, withoutDocumentText } from '../../integrations/vscode/src/snapshot.ts';
import { pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { defineForm } from '../../src/form/definition.ts';
import { loadForm, projectForm } from '../../src/form/manifest.ts';
import { runDoctorLanguageServer } from '../../src/doctor/lsp.ts';
import { readLspFrames } from '../../src/doctor/lsp-frames.ts';

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

  test('disposal while the client factory awaits prevents a subsequent start', async () => {
    const creating = gate();
    const release = gate();
    const events: string[] = [];
    const manager = new DoctorSessionManager<string>(async () => {
      creating.open(); await release.promise;
      return { start: async () => { events.push('start'); }, stop: async () => { events.push('stop'); }, dispose: async () => { events.push('dispose'); } };
    }, (error) => { throw error; });
    const refreshed = manager.refresh(['one']);
    await creating.promise;
    const disposed = manager.dispose();
    release.open();
    await Promise.all([refreshed, disposed]);
    expect(events).toEqual(['stop', 'dispose']);
  });
});

describe('VS Code owned transport process', () => {
  test('blocks a late transport callback after disposal', async () => {
    const transport = new DoctorProcess({ root: process.cwd(), command: 'node', args: ['-e', 'process.exit(9)'] });
    await transport.close();
    await expect(transport.launch()).rejects.toThrow('closed');
  });

  test('awaits actual process exit and closes streams before allowing replacement', async () => {
    const transport = new DoctorProcess({ root: process.cwd(), command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'] });
    try {
      const child = await transport.launch();
      expect(child.pid).toBeNumber();
      await transport.close();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true);
      await expect(transport.launch()).rejects.toThrow('closed');
    } finally { await transport.close(); }
  });

  test('reports spawn errors and permits cleanup without leaking an error event', async () => {
    const transport = new DoctorProcess({ root: process.cwd(), command: '__typehtml_missing_node_executable__', args: [] });
    await expect(transport.launch()).rejects.toThrow();
    await transport.close();
  });
});

describe('VS Code persisted-snapshot notifications', () => {
  function packet(message: object): Buffer {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  }

  // Matches the installed language client's asOpenTextDocumentParams conversion.
  function savedDocumentOpen(document: { uri: { toString(): string }; languageId: string; version: number; getText(): string }) {
    const safe = withoutDocumentText(document);
    return { textDocument: { uri: safe.uri.toString(), languageId: safe.languageId, version: safe.version, text: safe.getText() } };
  }

  test.each([false, true])('opens a document with dirty=%s without reading or sending buffer text', (isDirty) => {
    const document = { uri: { toString: () => 'file:///workspace/form.html' }, languageId: 'html', version: 9, isDirty,
      getText: () => { throw new Error('the editor buffer must not be read'); } };
    Object.freeze(document);
    expect(savedDocumentOpen(document)).toEqual({ textDocument: { uri: 'file:///workspace/form.html', languageId: 'html', version: 9, text: '' } });
  });

  test('retains metadata receivers and calls the normal client continuation for frozen documents', async () => {
    class Document {
      #version = 3;
      readonly uri = { toString: () => 'file:///workspace/form.html' };
      readonly languageId = 'html';
      get version() { return this.#version; }
      getText(): string { throw new Error('buffer should not be read'); }
      metadataVersion() { return this.#version; }
    }
    const document = new Document();
    Object.freeze(document);
    const synced = new Map<string, Document>();
    const next = async (forwarded: Document) => { synced.set(forwarded.uri.toString(), forwarded); };
    await forwardSavedDocumentOpen(document, next);
    const forwarded = synced.get(document.uri.toString())!;
    expect(forwarded.version).toBe(3);
    expect(forwarded.metadataVersion()).toBe(3);
    expect(forwarded.getText()).toBe('');
    expect(Object.isFrozen(document)).toBe(true);
  });

  test('a valid snapshot above the RPC limit remains analyzable and the server stays connected', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'typehtml-vscode-snapshot-'));
    try {
      const form = defineForm({ id: 'snapshot.submit', path: '/submit',
        input: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
        output: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } } });
      const formPath = join(directory, 'form.json');
      await writeFile(formPath, JSON.stringify(form.definition));
      const loaded = await loadForm(formPath);
      await writeFile(join(directory, 'projection.json'), JSON.stringify(projectForm(form, { sourcePath: 'form.json', sourceSha256: loaded.sourceSha256 })));
      const htmlPath = join(directory, 'form.html');
      const html = `<!--${'x'.repeat(1_500_000)}--><form id="test" method="post" action="/submit"><input name="unknown"><input type="hidden" name="_bc_csrf"><button>Send</button></form>`;
      await writeFile(htmlPath, html);
      const configPath = join(directory, 'doctor.json');
      await writeFile(configPath, JSON.stringify({ format: 'boundary-doctor/0.5-draft', root: directory,
        inputs: [{ kind: 'form-projection', path: 'projection.json' }],
        documents: [{ path: 'form.html', documentUrl: 'https://example.test/form', sourceKind: 'snapshot', executionAssumption: 'native', bindings: [{ formId: 'test', actionId: form.id }] }],
      }));
      const document = { uri: pathToFileURL(htmlPath), languageId: 'html', version: 1, getText: () => html };
      const oversized = packet({ method: 'textDocument/didOpen', params: { textDocument: { ...savedDocumentOpen(document).textDocument, text: html } } });
      const readOld = async () => { for await (const _ of readLspFrames(Readable.from([oversized]))) { /* consume */ } };
      await expect(readOld()).rejects.toThrow('message exceeds bounds');
      const open = packet({ method: 'textDocument/didOpen', params: savedDocumentOpen(document) });
      expect(open.byteLength).toBeLessThan(1024);
      const chunks: Buffer[] = [];
      const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
      await runDoctorLanguageServer(configPath, Readable.from([
        packet({ id: 1, method: 'initialize', params: {} }), open,
        packet({ id: 2, method: 'shutdown' }), packet({ method: 'exit' }),
      ]), output);
      const messages: any[] = [];
      for await (const body of readLspFrames(Readable.from(chunks))) messages.push(JSON.parse(body.toString()));
      const diagnostics = messages.find((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === document.uri.toString());
      expect(diagnostics.params.diagnostics.some((item: any) => item.code === 'BC010')).toBe(true);
      expect(messages.at(-1)).toMatchObject({ id: 2, result: null });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
