import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineForm, loadForm, projectForm } from '@0disoft/typehtml';

const directory = resolve('editor-rpc-fixture');
await mkdir(directory);
const schema = { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } };
const form = defineForm({ id: 'editor.submit', path: '/submit', input: schema, output: schema });
const formPath = join(directory, 'form.json');
await writeFile(formPath, JSON.stringify(form.definition));
const loaded = await loadForm(formPath);
await writeFile(join(directory, 'projection.json'), JSON.stringify(projectForm(form, { sourcePath: 'form.json', sourceSha256: loaded.sourceSha256 })));
const htmlPath = join(directory, 'form.html');
await writeFile(htmlPath, `<!--${'x'.repeat(1_500_000)}--><form id="example" method="post" action="/submit"><input name="unknown"><input type="hidden" name="_bc_csrf"><button>Save</button></form>`);
const configPath = join(directory, 'doctor.json');
await writeFile(configPath, JSON.stringify({ format: 'boundary-doctor/0.5-draft', root: directory,
  inputs: [{ kind: 'form-projection', path: 'projection.json' }], documents: [{ path: 'form.html',
    documentUrl: 'https://example.test/form', sourceKind: 'snapshot', executionAssumption: 'native',
    bindings: [{ formId: 'example', actionId: form.id }],
  }],
}));

const packet = (message) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
};
// Mirrors the editor's tested metadata-only converter. The server reads the saved file.
const open = packet({ method: 'textDocument/didOpen', params: { textDocument: {
  uri: pathToFileURL(htmlPath).href, languageId: 'html', version: 1, text: '',
} } });
assert.ok(open.length < 1_024);
const result = spawnSync(process.execPath, [resolve('node_modules/@0disoft/typehtml/dist/cli.js'), 'lsp', '--config', configPath], {
  input: Buffer.concat([packet({ id: 1, method: 'initialize', params: {} }), packet({ method: 'initialized', params: {} }),
    open, packet({ id: 2, method: 'shutdown' }), packet({ method: 'exit' })]),
  timeout: 10_000, maxBuffer: 1_048_576, windowsHide: true,
});
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr.toString());
const messages = [];
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
assert.ok(messages.some((message) => message.method === 'textDocument/publishDiagnostics'
  && message.params.uri === pathToFileURL(htmlPath).href && message.params.diagnostics.some((issue) => issue.code === 'BC010')));
assert.ok(messages.some((message) => message.id === 1 && message.result.capabilities.textDocumentSync.change === 0));
assert.deepEqual(messages.at(-1), { jsonrpc: '2.0', id: 2, result: null });
console.log(JSON.stringify({ passed: true, savedHtmlBytes: 1_500_000, openFrameBytes: open.length }));
