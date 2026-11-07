import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2] ?? 'workspace';
if (process.argv.length > 3 || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('usage: bun scripts/vscode-ui-fixture.ts [new-workspace-name]');
const parent = join(root, '.typehtml', 'vscode-ui');
const workspace = join(parent, name);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string; version: string };
const artifact = join(root, 'artifacts', `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`);
const node = Bun.which('node');
assert.ok(node, 'Node.js 22+ is required for the actual installed CLI fixture check');
await mkdir(parent, { recursive: true });
// Refuse to replace any previous UI workspace or user edits.
await mkdir(workspace);
await mkdir(join(workspace, '.vscode'));
await mkdir(join(workspace, 'variants'));
await writeFile(join(workspace, 'package.json'), `${JSON.stringify({ name: 'typehtml-vscode-ui-fixture', private: true, type: 'module' }, null, 2)}\n`);
const installed = Bun.spawnSync([process.execPath, 'add', artifact, '--ignore-scripts'], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
if (installed.exitCode !== 0) throw new Error(`local package installation failed: ${installed.stderr.toString()}`);

// Import the installed artifact, not this repository's source or dist tree.
const installedEntry = pathToInstalledFile('dist/index.js');
const { defineForm, loadForm, projectForm } = await import(installedEntry);
const schema = { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } } as const;
const form = defineForm({ id: 'ui.submit', path: '/submit', input: schema, output: schema });
const formPath = join(workspace, 'form.json');
await writeFile(formPath, `${JSON.stringify(form.definition, null, 2)}\n`);
const loaded = await loadForm(formPath);
await writeFile(join(workspace, 'form-check.json'), `${JSON.stringify(projectForm(form, { sourcePath: 'form.json', sourceSha256: loaded.sourceSha256 }), null, 2)}\n`);

const html = (field: 'unknown' | 'name', large = false) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>TypeHTML UI verification</title></head>
<body>
<h1>TypeHTML saved HTML diagnostics</h1>
<form id="qa-form" method="post" action="/submit">
  <label>Display name <input name="${field}" value="Ada" required></label>
  <input type="hidden" name="_bc_csrf" value="ui-fixture-only">
  <button type="submit">Save</button>
</form>
${large ? `<!--${'x'.repeat(1_500_000)}-->\n` : ''}</body>
</html>
`;
for (const [file, text] of [
  ['form.html', html('unknown')], ['large.html', html('unknown', true)],
  ['variants/form.invalid.html', html('unknown')], ['variants/form.valid.html', html('name')],
  ['variants/large.invalid.html', html('unknown', true)], ['variants/large.valid.html', html('name', true)],
] as const) await writeFile(join(workspace, file), text);

const config = (paths: readonly string[]) => ({ format: 'boundary-doctor/0.5-draft', root: workspace,
  inputs: [{ kind: 'form-projection', path: 'form-check.json' }],
  documents: paths.map((path) => ({ path, documentUrl: `https://example.test/${path}`, sourceKind: 'snapshot',
    executionAssumption: 'native', bindings: [{ formId: 'qa-form', actionId: form.id }],
  })),
});
for (const [file, paths] of [
  ['doctor.json', ['form.html']], ['doctor-large.json', ['large.html']], ['doctor-all.json', ['form.html', 'large.html']],
  ['doctor-valid.json', ['variants/form.valid.html']],
] as const) await writeFile(join(workspace, file), `${JSON.stringify(config(paths), null, 2)}\n`);
await writeFile(join(workspace, '.vscode', 'settings.json'), `${JSON.stringify({ 'typehtml.doctorConfig': 'doctor.json', 'files.autoSave': 'off' }, null, 2)}\n`);

const results: Record<string, unknown> = {};
for (const [file, expectedCode] of [['doctor.json', 1], ['doctor-large.json', 1], ['doctor-valid.json', 0]] as const) {
  const checked: Bun.SyncSubprocess<'pipe', 'pipe'> = Bun.spawnSync([node, join(workspace, 'node_modules/@0disoft/typehtml/dist/cli.js'), 'doctor', '--config', join(workspace, file)], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
  assert.equal(checked.exitCode, expectedCode, checked.stderr.toString());
  const report = JSON.parse(checked.stdout.toString()) as { findings: { ruleId: string; note: string }[]; exitCode: number };
  if (expectedCode === 1) assert.ok(report.findings.some((finding) => finding.ruleId === 'BC010'));
  else assert.equal(report.findings.length, 0);
  results[file] = { exitCode: report.exitCode, findings: report.findings.map(({ ruleId, note }) => ({ ruleId, note })) };
}
const summary = { workspace, packageVersion: manifest.version, artifact, largeHtmlBytes: Buffer.byteLength(html('unknown', true)),
  defaultConfig: 'doctor.json', editableFile: 'form.html', fix: 'Replace name="unknown" with name="name", then save.',
  largeConfig: 'doctor-large.json', largeEditableFile: 'large.html', results,
};
await writeFile(join(workspace, 'fixture-expectations.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

function pathToInstalledFile(path: string): string {
  return pathToFileURL(join(workspace, 'node_modules/@0disoft/typehtml', path)).href;
}
