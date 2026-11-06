import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { defineForm } from '../../src/form/definition.ts';
import { loadForm, projectForm } from '../../src/form/manifest.ts';
import { collectRenderedHtml, writeRenderedCollection } from '../../src/doctor/capture.ts';
import { runDoctor } from '../../src/doctor/analyze.ts';
import { watchDoctor } from '../../src/doctor/watch.ts';
import { runDoctorLanguageServer } from '../../src/doctor/lsp.ts';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const validHtml = '<form id="form" method="post" action="/send"><textarea name="name"></textarea><input type="hidden" name="_bc_csrf"><button>Send</button></form>';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'typehtml-devtools-')); dirs.push(root);
  const form = defineForm({ id: 'test.send', path: '/send', input: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
    output: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string' } } } });
  await writeFile(join(root, 'form.json'), JSON.stringify(form.definition));
  const loaded = await loadForm(join(root, 'form.json'));
  await writeFile(join(root, 'projection.json'), JSON.stringify(projectForm(form, { sourcePath: 'form.json', sourceSha256: loaded.sourceSha256 })));
  const collection = await collectRenderedHtml({ allowedOrigins: ['https://example.test'], selections: [{ id: 'initial', url: 'https://example.test/form', bindings: [
    { formId: 'form', actionId: form.id, required: true, submitterPolicy: 'enumerate-native', constraintMismatchSeverity: 'warning' },
  ] }], render: () => validHtml });
  const result = await writeRenderedCollection(collection, { directory: join(root, 'snapshots'), root, inputs: [{ kind: 'form-projection', path: 'projection.json' }] });
  return { root, configPath: result.configPath, htmlPath: join(root, 'snapshots/initial.html') };
}

function packet(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message as object }));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

function unpack(buffer: Buffer): any[] {
  const messages: any[] = [];
  while (buffer.length) {
    const split = buffer.indexOf('\r\n\r\n');
    const length = Number(/Content-Length: ([0-9]+)/.exec(buffer.subarray(0, split).toString())![1]);
    messages.push(JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString()));
    buffer = buffer.subarray(split + 4 + length);
  }
  return messages;
}

describe('Doctor development integrations', () => {
  test('captured rendered HTML is directly analyzable with verified contract provenance', async () => {
    const { configPath } = await fixture();
    const report = await runDoctor(configPath);
    expect(report.exitCode).toBe(0);
    expect(report.scope.paths).toBe(1);
    expect(report.submissions[0]?.artifact.sourceKind).toBe('rendered-html');
    expect(report.scope.applicationCompleteness).toBe('not-evaluated');
  });

  test('disabled checked radio cannot turn conditional required supply into a successful Doctor run', async () => {
    const { configPath, htmlPath } = await fixture();
    await writeFile(htmlPath, validHtml.replace('<textarea name="name"></textarea>', '<input type="radio" name="name" required value="a"><input type="radio" name="name" disabled checked value="b">'));
    const report = await runDoctor(configPath);
    expect(report.exitCode).toBe(3);
    expect(report.findings.some((finding) => finding.subcode === 'conditional-required-field' && finding.analysisStatus === 'unknown')).toBe(true);
  });

  test('CLI captures a live selected HTML response and emits verified Doctor SARIF', async () => {
    const { root } = await fixture();
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(validHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const manifestPath = join(root, 'capture.json');
      const directory = join(root, 'live-snapshots');
      await writeFile(manifestPath, JSON.stringify({ format: 'typehtml-capture/1', root,
        allowedOrigins: [origin], inputs: [{ kind: 'form-projection', path: 'projection.json' }],
        selections: [{ id: 'live', url: `${origin}/form`, bindings: [{ formId: 'form', actionId: 'test.send' }] }],
      }));
      const cli = resolve(import.meta.dir, '../../src/cli.ts');
      const execute = async (...args: string[]) => {
        const process = Bun.spawn([Bun.which('bun')!, cli, ...args], { stdout: 'pipe', stderr: 'pipe' });
        const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
        return { exitCode, stdout, stderr };
      };
      const capture = await execute('capture', '--config', manifestPath, '--out-dir', directory);
      expect(capture.stderr).toBe('');
      expect(capture.exitCode).toBe(0);
      const result = JSON.parse(capture.stdout);
      expect(result.snapshots).toBe(1);
      expect(await readFile(join(directory, 'live.html'), 'utf8')).toBe(validHtml);
      const doctor = await execute('doctor', '--config', result.configPath, '--format', 'sarif');
      expect(doctor.stderr).toBe('');
      expect(doctor.exitCode).toBe(0);
      const sarif = JSON.parse(doctor.stdout);
      expect(sarif.version).toBe('2.1.0');
      expect(sarif.runs[0].properties.scope.documents).toBe(1);
      expect(sarif.runs[0].properties.scope.paths).toBe(1);
      expect(sarif.runs[0].properties.applicationCompleteness).toBe('not-evaluated');
    } finally { await server.stop(true); }
  });

  test('managed watch detects selected document changes without overlapping analyses', async () => {
    const { configPath, htmlPath } = await fixture();
    const codes: number[] = [];
    await watchDoctor(configPath, { signal: new AbortController().signal, intervalMs: 10, maxRuns: 2, onReport: async (report) => {
      codes.push(report.exitCode);
      if (codes.length === 1) await writeFile(htmlPath, validHtml.replace('name="name"', 'name="unknown"'));
    } });
    expect(codes).toEqual([0, 1]);
  });

  test('watch cancellation stops its timer and returns without another report', async () => {
    const { configPath } = await fixture();
    const controller = new AbortController();
    let reports = 0;
    await watchDoctor(configPath, { signal: controller.signal, intervalMs: 10, onReport: () => { reports++; controller.abort(); } });
    expect(reports).toBe(1);
  });

  test('watch recovers when an initially invalid projection is repaired', async () => {
    const { configPath, root } = await fixture();
    const path = join(root, 'projection.json');
    const original = await readFile(path, 'utf8');
    await writeFile(path, '{');
    const codes: number[] = [];
    await watchDoctor(configPath, { signal: new AbortController().signal, intervalMs: 10, maxRuns: 2, onReport: async (report) => {
      codes.push(report.exitCode);
      if (codes.length === 1) await writeFile(path, original);
    } });
    expect(codes).toEqual([2, 0]);
  });

  test('stdio LSP frames initialize, persisted diagnostics, shutdown and exit', async () => {
    const { configPath, htmlPath } = await fixture();
    await writeFile(htmlPath, validHtml.replace('name="name"', 'name="unknown"'));
    const input = Buffer.concat([packet({ id: 1, method: 'initialize', params: {} }), packet({ method: 'initialized', params: {} }), packet({ id: 2, method: 'shutdown' }), packet({ method: 'exit' })]);
    const chunks: Buffer[] = [];
    const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    await runDoctorLanguageServer(configPath, Readable.from([input.subarray(0, 7), input.subarray(7, 50), input.subarray(50)]), output);
    const messages = unpack(Buffer.concat(chunks));
    expect(messages[0].result.capabilities.textDocumentSync.change).toBe(0);
    const diagnostics = messages.find((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === pathToFileURL(htmlPath).href);
    expect(diagnostics.params.diagnostics.some((item: any) => item.code === 'BC010')).toBe(true);
    expect(diagnostics.params.diagnostics[0].range.start.line).toBe(0);
    expect(messages.at(-1)).toMatchObject({ id: 2, result: null });
  });

  test('LSP rejects oversized messages and handles invalid JSON without protocol log pollution', async () => {
    const chunks: Buffer[] = [];
    const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    await runDoctorLanguageServer('missing.json', Readable.from([Buffer.from('Content-Length: 1\r\n\r\n{')]), output);
    expect(unpack(Buffer.concat(chunks))[0].error.code).toBe(-32700);
    await expect(runDoctorLanguageServer('missing.json', Readable.from([Buffer.from('Content-Length: 1048577\r\n\r\n')]), output)).rejects.toThrow('bounds');
  });

  test('assembles byte-fragmented LSP bodies without repeatedly copying accumulated input', async () => {
    const input = packet({ id: 1, method: 'initialize', params: { ignored: 'x'.repeat(32_768) } });
    const fragments = async function* () { for (let index = 0; index < input.length; index++) yield input.subarray(index, index + 1); };
    const chunks: Buffer[] = [];
    const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    const concat = spyOn(Buffer, 'concat');
    try {
      await runDoctorLanguageServer('unused.json', fragments(), output);
      // Only output framing needs concatenation; growing an input prefix per fragment is quadratic.
      expect(concat.mock.calls.length).toBeLessThanOrEqual(2);
    } finally { concat.mockRestore(); }
    expect(unpack(Buffer.concat(chunks))[0].id).toBe(1);
  });
});
