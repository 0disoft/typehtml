import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2] ?? 'rich-workspace';
if (process.argv.length > 3 || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('usage: bun scripts/vscode-rich-fixture.ts [new-workspace-name]');
const parent = join(root, '.typehtml', 'vscode-ui');
const workspace = join(parent, name);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string; version: string };
const artifact = join(root, 'artifacts', `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`);
const node = Bun.which('node');
assert.ok(node, 'Node.js 22+ is required for installed CLI/LSP verification');
assert.ok((await stat(artifact)).isFile(), 'pack the current source before creating the rich fixture');
await mkdir(parent, { recursive: true });
// A fixture owns one newly created directory. Never replace earlier fixtures or user edits.
await mkdir(workspace);
await mkdir(join(workspace, '.vscode'));
await mkdir(join(workspace, 'variants'));
await mkdir(join(workspace, 'reports'));
await writeJson('package.json', { name: 'typehtml-vscode-rich-fixture', private: true, type: 'module' });
run([process.execPath, 'add', artifact, '--ignore-scripts'], 0, 90_000);

const installedRoot = join(workspace, 'node_modules/@0disoft/typehtml');
const installedManifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8')) as { version: string };
assert.equal(installedManifest.version, manifest.version, 'installed artifact version differs from repository metadata');
const installed = await import(pathToFileURL(join(installedRoot, 'dist/index.js')).href);
for (const key of ['defineWireForm', 'loadWireForm', 'projectWireForm']) assert.equal(typeof installed[key], 'function', `${key} is missing; regenerate the installable package`);
const wireForm = installed.defineWireForm({
  id: 'richUi.submit', path: '/submit',
  fields: {
    'person.name': { type: 'string', required: true },
    'person.newsletter': { type: 'boolean' },
    'person.tags': { type: 'array', items: { type: 'string', enum: ['research', 'product'] }, maxItems: 2 },
  },
  uploads: { attachment: {} }, multipart: { maxParts: 16 }, limits: { maxEntries: 16 },
});
await writeJson('form.wire.json', wireForm.definition);
const loaded = await installed.loadWireForm(join(workspace, 'form.wire.json'));
await writeJson('form-check.json', installed.projectWireForm(loaded.form, {
  sourcePath: 'form.wire.json', sourceSha256: loaded.sourceSha256,
}));

function html(encodingFixed: boolean, duplicateFixed: boolean): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>TypeHTML rich form UI verification</title></head>
<body>
<h1>Rich native form diagnostics</h1>
<p>The initial form has two structural errors. Fix the encoding first, then the duplicate scalar.</p>
<form id="qa-rich-form" method="post" action="/submit"${encodingFixed ? ' enctype="multipart/form-data"' : ''}>
  <label>Name <input name="person.name" value="Ada" required></label>
${duplicateFixed ? '' : '  <input name="person.name" value="duplicate scalar">\n'}  <label><input type="checkbox" name="person.newsletter" value="on">Newsletter</label>
  <label>Tags <select name="person.tags" multiple>
    <option value="research">Research</option>
    <option value="product">Product</option>
  </select></label>
  <label>Attachment <input type="file" name="attachment"></label>
  <input type="hidden" name="_bc_csrf" value="rich-ui-fixture-only">
  <button type="submit">Save</button>
</form>
</body>
</html>
`;
}
for (const [path, text] of [
  ['form.html', html(false, false)],
  ['variants/form.invalid.html', html(false, false)],
  ['variants/form.encoding-fixed.html', html(true, false)],
  ['variants/form.valid.html', html(true, true)],
] as const) await writeFile(join(workspace, path), text);

function config(path: string) {
  return { format: 'boundary-doctor/0.5-draft', root: workspace,
    inputs: [{ kind: 'form-projection', path: 'form-check.json' }],
    documents: [{ path, documentUrl: 'https://example.test/form', sourceKind: 'rendered-snapshot', executionAssumption: 'selected-native-no-script',
      bindings: [{ formId: 'qa-rich-form', actionId: wireForm.id }],
    }],
  };
}
for (const [file, path] of [
  ['doctor.json', 'form.html'],
  ['doctor-one-fixed.json', 'variants/form.encoding-fixed.html'],
  ['doctor-valid.json', 'variants/form.valid.html'],
] as const) await writeJson(file, config(path));
await writeJson('.vscode/settings.json', { 'typehtml.doctorConfig': 'doctor.json', 'files.autoSave': 'off' });

interface Finding {
  ruleId: string; subcode?: string; schemaPath?: string; reason?: string; remediation?: string;
  note: string; severity: string; outcome: string;
  evidenceRef: { path: string; line: number; column: number } | null;
}
interface Report { findings: Finding[]; exitCode: number; coverage: { ruleGroup: string; actualStatus: string }[] }
const cli = join(installedRoot, 'dist/cli.js');
assert.equal(run([node, cli, '--version'], 0).trim(), manifest.version);
const results: Record<string, unknown> = {};
for (const [configName, expectedExit, expectedErrors] of [
  ['doctor.json', 1, ['encoding-mismatch', 'duplicate-scalar']],
  ['doctor-one-fixed.json', 1, ['duplicate-scalar']],
  ['doctor-valid.json', 0, []],
] as const) {
  const raw = run([node, cli, 'doctor', '--config', join(workspace, configName)], expectedExit);
  const report = JSON.parse(raw) as Report;
  const errors = report.findings.filter((finding) => finding.severity === 'error' && finding.outcome === 'defect');
  assert.deepEqual(errors.map((finding) => finding.subcode), expectedErrors);
  assert.ok(report.findings.some((finding) => finding.subcode === 'file-content-not-analyzed'), 'file content must remain unknown');
  assert.ok(report.coverage.some((row) => row.ruleGroup === 'constraints' && row.actualStatus === 'unknown'), 'opaque validation must not become checked');
  const stem = configName.replace(/\.json$/, '');
  await writeFile(join(workspace, 'reports', `${stem}.json`), raw);
  const sarifText = run([node, cli, 'doctor', '--config', join(workspace, configName), '--format', 'sarif'], expectedExit);
  const sarif = JSON.parse(sarifText) as { runs: { results: { ruleId: string; properties: Record<string, unknown> }[] }[] };
  const sarifResults = sarif.runs[0]!.results;
  assert.equal(sarifResults.length, report.findings.length);
  for (const [index, finding] of report.findings.entries()) assert.deepEqual({ ruleId: sarifResults[index]!.ruleId,
    schemaPath: sarifResults[index]!.properties.schemaPath, reason: sarifResults[index]!.properties.reason,
    remediation: sarifResults[index]!.properties.remediation,
  }, { ruleId: finding.ruleId, schemaPath: finding.schemaPath, reason: finding.reason, remediation: finding.remediation });
  await writeFile(join(workspace, 'reports', `${stem}.sarif.json`), sarifText);
  const lsp = checkLsp(configName, report);
  await writeJson(`reports/${stem}.lsp.json`, lsp);
  results[configName] = { exitCode: report.exitCode, expectedErrorSubcodes: expectedErrors,
    totalDiagnostics: report.findings.length, errors: errors.length, sarifMatches: true, lspMatches: true,
    findings: report.findings.map(({ ruleId, subcode, schemaPath, severity, note, remediation }) => ({ ruleId, subcode, schemaPath, severity, note, remediation })),
  };
}
const summary = {
  workspace, packageVersion: installedManifest.version, artifact,
  defaultConfig: 'doctor.json', editableFile: 'form.html', expectedInitialErrors: 2,
  firstFix: 'Add enctype="multipart/form-data" to the form and save. The encoding error clears; duplicate person.name remains.',
  secondFix: 'Remove the input whose value is "duplicate scalar" and save. Structural errors clear; the file-content unknown diagnostic remains.',
  variants: { invalid: 'variants/form.invalid.html', firstFix: 'variants/form.encoding-fixed.html', valid: 'variants/form.valid.html' },
  retainedUnknown: 'Opaque schema constraints and file content are not statically proved; valid means no structural defect.',
  results,
};
await writeJson('fixture-expectations.json', summary);
console.log(JSON.stringify(summary, null, 2));

function run(command: string[], expectedExit: number, timeout = 20_000): string {
  const result = spawnSync(command[0]!, command.slice(1), { cwd: workspace, encoding: 'utf8',
    timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, expectedExit, result.stderr || result.stdout);
  return result.stdout;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(join(workspace, path), `${JSON.stringify(value, null, 2)}\n`);
}

function checkLsp(configName: string, report: Report): readonly unknown[] {
  const packet = (message: object) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  };
  const result = spawnSync(node!, [cli, 'lsp', '--config', join(workspace, configName)], { cwd: workspace,
    input: Buffer.concat([packet({ id: 1, method: 'initialize', params: {} }), packet({ method: 'initialized', params: {} }),
      packet({ id: 2, method: 'shutdown' }), packet({ method: 'exit' })]),
    timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr.toString());
  const messages: { method?: string; params?: { diagnostics?: { code: string; data?: Record<string, unknown>; message: string }[] } }[] = [];
  for (let offset = 0; offset < result.stdout.length;) {
    const end = result.stdout.indexOf('\r\n\r\n', offset);
    assert.ok(end >= offset, 'complete LSP header');
    const length = /Content-Length:\s*(\d+)/i.exec(result.stdout.toString('ascii', offset, end));
    assert.ok(length, 'LSP content length');
    const bodyStart = end + 4;
    const bodyEnd = bodyStart + Number(length[1]);
    assert.ok(bodyEnd <= result.stdout.length, 'complete LSP body');
    messages.push(JSON.parse(result.stdout.toString('utf8', bodyStart, bodyEnd)));
    offset = bodyEnd;
  }
  const diagnostics = messages.find((message) => message.method === 'textDocument/publishDiagnostics' && message.params?.diagnostics?.length)?.params?.diagnostics;
  assert.ok(diagnostics, 'LSP published fixture findings');
  assert.equal(diagnostics.length, report.findings.length);
  for (const [index, finding] of report.findings.entries()) assert.deepEqual({ code: diagnostics[index]!.code,
    schemaPath: diagnostics[index]!.data?.schemaPath, reason: diagnostics[index]!.data?.reason,
    remediation: diagnostics[index]!.data?.remediation,
  }, { code: finding.ruleId, schemaPath: finding.schemaPath, reason: finding.reason, remediation: finding.remediation });
  return messages;
}
