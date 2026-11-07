import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = process.argv[2] ?? 'multiroot';
if (process.argv.length > 3 || !/^[a-z][a-z0-9-]{0,47}$/.test(prefix)) throw new Error('usage: bun scripts/vscode-multiroot-fixture.ts [new-fixture-prefix]');
const parent = join(root, '.typehtml', 'vscode-ui');
const names = [`${prefix}-a`, `${prefix}-b`] as const;
const workspacePath = join(parent, `${prefix}.code-workspace`);
const oneRootPath = join(parent, `${prefix}-one-root.code-workspace`);
for (const path of [...names.map((name) => join(parent, name)), workspacePath, oneRootPath]) {
  try { await lstat(path); throw new Error(`fixture already exists: ${path}`); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
}
for (const name of names) {
  const made = Bun.spawnSync([process.execPath, join(root, 'scripts/vscode-ui-fixture.ts'), name], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (made.exitCode !== 0) throw new Error(`fixture creation failed: ${made.stderr.toString()}`);
}

const beta = join(parent, names[1]);
const installedEntry = pathToFileURL(join(beta, 'node_modules/@0disoft/typehtml/dist/index.js')).href;
const { defineForm, loadForm, projectForm } = await import(installedEntry);
const original = JSON.parse(await readFile(join(beta, 'form.json'), 'utf8'));
const form = defineForm({ ...original, id: 'beta.submit', input: {
  type: 'object', additionalProperties: false, required: ['email'], properties: { email: { type: 'string' } },
} });
const formPath = join(beta, 'form.json');
await writeFile(formPath, `${JSON.stringify(form.definition, null, 2)}\n`);
const loaded = await loadForm(formPath);
await writeFile(join(beta, 'form-check.json'), `${JSON.stringify(projectForm(form, { sourcePath: 'form.json', sourceSha256: loaded.sourceSha256 }), null, 2)}\n`);
for (const file of ['form.html', 'large.html', 'variants/form.invalid.html', 'variants/form.valid.html', 'variants/large.invalid.html', 'variants/large.valid.html']) {
  const text = await readFile(join(beta, file), 'utf8');
  await writeFile(join(beta, file), text.replaceAll('name="unknown"', 'name="wrongEmail"').replaceAll('name="name"', 'name="email"').replaceAll('Display name', 'Email address'));
}
for (const file of ['doctor.json', 'doctor-large.json', 'doctor-all.json', 'doctor-valid.json']) {
  const config = JSON.parse(await readFile(join(beta, file), 'utf8'));
  for (const document of config.documents) for (const binding of document.bindings) binding.actionId = form.id;
  await writeFile(join(beta, file), `${JSON.stringify(config, null, 2)}\n`);
}

const folders = [{ name: 'Alpha Forms', path: names[0] }, { name: 'Beta Forms', path: names[1] }];
await writeFile(workspacePath, `${JSON.stringify({ folders }, null, 2)}\n`);
await writeFile(oneRootPath, `${JSON.stringify({ folders: folders.slice(0, 1) }, null, 2)}\n`);
const node = Bun.which('node');
assert.ok(node, 'Node.js is required to verify installed CLI fixtures');
const expectations: Record<string, unknown> = {};
for (const [index, name] of names.entries()) {
  const directory = join(parent, name);
  const field = index === 0 ? 'name' : 'email';
  const wrongField = index === 0 ? 'unknown' : 'wrongEmail';
  for (const [configName, expectedExit] of [['doctor.json', 1], ['doctor-valid.json', 0]] as const) {
    const checked: Bun.SyncSubprocess<'pipe', 'pipe'> = Bun.spawnSync([node, join(directory, 'node_modules/@0disoft/typehtml/dist/cli.js'), 'doctor', '--config', join(directory, configName)], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
    assert.equal(checked.exitCode, expectedExit, checked.stderr.toString());
    const report = JSON.parse(checked.stdout.toString());
    assert.equal(report.findings.length, expectedExit === 0 ? 0 : 2);
    if (expectedExit !== 0) {
      assert.ok(report.findings.some((finding: { ruleId: string; note: string }) => finding.ruleId === 'BC010' && finding.note.includes(`"${field}"`)));
      assert.ok(report.findings.some((finding: { ruleId: string; note: string }) => finding.ruleId === 'BC011' && finding.note.includes(`"${wrongField}"`)));
    }
    expectations[`${name}/${configName}`] = { exitCode: checked.exitCode, findings: report.findings.map(({ ruleId, note }: { ruleId: string; note: string }) => ({ ruleId, note })) };
  }
}
const summary = { workspacePath, oneRootPath, folders: names.map((name) => join(parent, name)), expectedTotalDiagnostics: 4,
  alphaFix: 'In Alpha Forms/form.html, replace name="unknown" with name="name" and save: Alpha clears, Beta retains BC010/BC011.',
  betaFix: 'In Beta Forms/form.html, replace name="wrongEmail" with name="email" and save: Beta clears independently.', expectations,
};
await writeFile(join(parent, `${prefix}-expectations.json`), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(join(beta, 'fixture-expectations.json'), `${JSON.stringify({ ...summary, root: beta, fix: summary.betaFix }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
