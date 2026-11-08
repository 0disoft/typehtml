import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineWireForm, type WireFormDefinition } from '../../src/form/wire-manifest.ts';
import { generateFiles } from '../../src/generate.ts';
import { runDoctor } from '../../src/doctor/analyze.ts';
import { formatDoctorReport } from '../../src/doctor/format.ts';
import { runDoctorLanguageServer } from '../../src/doctor/lsp.ts';
import { readLspFrames } from '../../src/doctor/lsp-frames.ts';

const scalar = { type: 'object', additionalProperties: false, required: [], properties: { title: { type: 'string' } } } as const;
const rows = { items: { maxItems: 3, rowKey: 'rowId', fields: {
  rowId: { type: 'string', required: true, minLength: 1, maxLength: 64 }, quantity: { type: 'integer', required: true },
} } } as const;

async function fixture(definition: WireFormDefinition, html: string, options: Readonly<{ sourceKind?: string; constraintsRequired?: boolean }> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'typehtml-rich-doctor-'));
  const sourcePath = join(directory, 'form.json');
  const configPath = join(directory, 'doctor.json');
  const writeHtml = (body: string) => writeFile(join(directory, 'index.html'), body);
  try {
    await writeFile(sourcePath, JSON.stringify(defineWireForm(definition).definition));
    await generateFiles({ contractPath: sourcePath, outDir: join(directory, 'generated'), rootDir: directory });
    await writeHtml(html);
    await writeFile(configPath, JSON.stringify({ format: 'boundary-doctor/0.5-draft', root: directory,
      inputs: [{ kind: 'form-projection', path: 'generated/form-check.generated.json' }],
      documents: [{ path: 'index.html', documentUrl: 'https://example.test/form', sourceKind: options.sourceKind ?? 'rendered-snapshot',
        executionAssumption: 'selected-persisted-native-state', bindings: [{ formId: 'f', actionId: definition.id, required: true }] }],
      ...(options.constraintsRequired ? { audit: { releaseRequiredRuleGroups: ['binding', 'target', 'supply', 'cardinality', 'constraints'] } } : {}),
    }));
    return { directory, sourcePath, configPath, writeHtml, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

const form = (body: string, encoding = '') => `<form id="f" action="/send" method="post" ${encoding}><input type="hidden" name="_bc_csrf" value="fixture">${body}<button>Send</button></form>`;
const row = (index: number, key: string) => `<input type="hidden" name="items[${index}].rowId" value="${key}"><input type="hidden" name="items[${index}].quantity" value="1">`;

describe('rich Doctor generation and analysis pipeline', () => {
  test('finds every expected corpus defect without rejecting valid repeated and nested values', async () => {
    const definition: WireFormDefinition = { id: 'rich.send', path: '/send', fields: {
      'person.name': { type: 'string', required: true }, accepted: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    } };
    const base = '<input name="person.name"><input type="checkbox" name="accepted">';
    const cases = [
      { html: base + '<input name="tags"><input name="tags">', expected: null },
      { html: base + '<input name="person.name">', expected: 'duplicate-scalar' },
      { html: base + '<input name="tags"><input name="tags"><input name="tags">', expected: 'max-occurrences' },
      { html: base + '<input name="person.unknown">', expected: 'unknown-wire-field' },
      { html: '<input name="tags">', expected: 'missing-wire-field' },
    ];
    const run = await fixture(definition, form(cases[0]!.html));
    try {
      for (const item of cases) {
        await run.writeHtml(form(item.html));
        const report = await runDoctor(run.configPath);
        if (item.expected === null) expect(report.exitCode).toBe(0);
        else {
          expect(report.exitCode).toBe(1);
          expect(report.findings.some((finding) => finding.subcode === item.expected)).toBe(true);
        }
        expect(report.coverage.find((item) => item.ruleGroup === 'constraints')?.actualStatus).toBe('unknown');
      }
      const generated = await readFile(join(run.directory, 'generated/form-definition.ts'), 'utf8');
      expect(generated).toContain('defineWireForm');
      expect(generated).not.toContain('output:');
      expect((await generateFiles({ contractPath: run.sourcePath, outDir: join(run.directory, 'generated'), rootDir: run.directory, check: true })).status).toBe('current');
    } finally { await run.dispose(); }
  });

  test('checks active rows, sparse indexes, stable identity collision and undeclared row bounds', async () => {
    const run = await fixture({ id: 'rows.send', path: '/send', fields: {}, collections: rows }, form(row(0, 'a') + row(1, 'b')));
    try {
      expect((await runDoctor(run.configPath)).exitCode).toBe(0);
      for (const [html, code] of [[row(1, 'b'), 'sparse-collection-rows'], [row(0, 'a') + row(1, 'a'), 'duplicate-row-identity'], [row(3, 'd'), 'unknown-wire-field']] as const) {
        await run.writeHtml(form(html));
        const report = await runDoctor(run.configPath);
        expect(report.exitCode).toBe(1);
        expect(report.findings.some((finding) => finding.subcode === code)).toBe(true);
      }
    } finally { await run.dispose(); }
  });

  test('accepts explicitly declared multipart structure and diagnoses encoding and file-control mismatch', async () => {
    const run = await fixture({ id: 'file.send', path: '/send', fields: {}, uploads: { attachment: { required: true } }, multipart: {} },
      form('<input type="file" name="attachment" required>', 'enctype="multipart/form-data"'));
    try {
      const valid = await runDoctor(run.configPath);
      expect(valid.exitCode).toBe(0);
      expect(valid.findings.find((finding) => finding.subcode === 'file-content-not-analyzed')?.analysisStatus).toBe('unknown');
      expect(valid.submissions[0]?.intendedAction.encoding).toBe('multipart');
      await run.writeHtml(form('<input type="file" name="attachment" required>'));
      expect((await runDoctor(run.configPath)).findings.some((finding) => finding.subcode === 'encoding-mismatch')).toBe(true);
      await run.writeHtml(form('<input name="attachment">', 'enctype="multipart/form-data"'));
      expect((await runDoctor(run.configPath)).findings.some((finding) => finding.subcode === 'wire-kind-mismatch')).toBe(true);
    } finally { await run.dispose(); }
  });

  test('retains bounded count evidence for 1000 checkboxes and fails closed on path/evidence budgets', async () => {
    const run = await fixture({ id: 'large.send', path: '/send', limits: { maxEntries: 1_002 }, fields: { tags: { type: 'array', items: { type: 'string' } } } },
      form('<input type="checkbox" name="tags">'.repeat(1_000)));
    try {
      const report = await runDoctor(run.configPath);
      expect(report.exitCode).toBe(0);
      expect(report.scope.paths).toBe(1);
      expect(report.submissions[0]?.fields.find((field) => field.name === 'tags')).toMatchObject({ minimumCount: 0, maximumCount: 1_000 });
      const bounded = await runDoctor(run.configPath, { maxControlVisits: 1_000 });
      expect(bounded.exitCode).toBe(3);
      expect(bounded.analysisTruncated).toBe(true);
      expect((await runDoctor(run.configPath, { maxSubmissionBytes: 2 })).exitCode).toBe(3);
    } finally { await run.dispose(); }
  });

  test('diagnoses guaranteed request entry limits, possible overflows and multipart placeholder parts', async () => {
    const guaranteed = await fixture({ id: 'entries.send', path: '/send', limits: { maxEntries: 2 },
      fields: { title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
    }, form('<input name="title"><input name="tags">'));
    try {
      const report = await runDoctor(guaranteed.configPath);
      expect(report.exitCode).toBe(1);
      expect(report.findings.find((finding) => finding.subcode === 'entry-budget-mismatch')).toMatchObject({ schemaPath: '/limits/maxEntries', certainty: 'confirmed' });
      await guaranteed.writeHtml(form('<input type="checkbox" name="tags"><input type="checkbox" name="tags">'));
      const conditional = await runDoctor(guaranteed.configPath);
      expect(conditional.exitCode).toBe(3);
      expect(conditional.findings.some((finding) => finding.subcode === 'conditional-entry-budget')).toBe(true);
    } finally { await guaranteed.dispose(); }
    const files = await fixture({ id: 'parts.send', path: '/send', fields: {}, uploads: { first: {}, second: {} },
      multipart: { maxParts: 2, maxFiles: 2 },
    }, form('<input type="file" name="first"><input type="file" name="second">', 'enctype="multipart/form-data"'));
    try {
      const report = await runDoctor(files.configPath);
      expect(report.findings.find((finding) => finding.subcode === 'entry-budget-mismatch')).toMatchObject({ schemaPath: '/multipart/maxParts' });
    } finally { await files.dispose(); }
  });

  test('rejects stale rich source and does not treat opaque or redacted validation as checked', async () => {
    const run = await fixture({ id: 'opaque.send', path: '/send', fields: { age: { type: 'integer', maximum: 10 } } },
      form('<input type="number" name="age" max="11">'), { constraintsRequired: true });
    try {
      const mismatch = await runDoctor(run.configPath);
      expect(mismatch.findings.some((finding) => finding.subcode === 'max-witness')).toBe(true);
      await run.writeHtml(form('<input type="number" name="age" max="10">'));
      expect((await runDoctor(run.configPath)).exitCode).toBe(3);
      await writeFile(run.sourcePath, (await readFile(run.sourcePath, 'utf8')) + '\n');
      const stale = await runDoctor(run.configPath);
      expect(stale.exitCode).toBe(3);
      expect(stale.findings.some((finding) => finding.subcode === 'stale-projection')).toBe(true);
    } finally { await run.dispose(); }
    const redacted = await fixture({ id: 'redacted.send', path: '/send', fields: {}, collections: rows },
      form(row(0, '[REDACTED]') + row(1, '[REDACTED]')), { sourceKind: 'redacted-snapshot' });
    try {
      const report = await runDoctor(redacted.configPath);
      expect(report.findings.some((finding) => finding.subcode === 'duplicate-row-identity' || finding.subcode === 'native-choice-rejected')).toBe(false);
      expect(report.findings.some((finding) => finding.subcode === 'redacted-row-identity')).toBe(true);
      expect(report.exitCode).toBe(3);
    } finally { await redacted.dispose(); }
  });

  test('supports legacy and rich projections together and carries actionable metadata through SARIF and LSP', async () => {
    const run = await fixture({ id: 'rich.send', path: '/send', fields: { title: { type: 'string' } } }, form('<input name="title"><input name="title">'));
    try {
      const legacyPath = join(run.directory, 'legacy.json');
      await writeFile(legacyPath, JSON.stringify({ format: 'typehtml-form/1', id: 'legacy.send', path: '/legacy', input: scalar, output: scalar }));
      await generateFiles({ contractPath: legacyPath, outDir: join(run.directory, 'legacy-generated'), rootDir: run.directory });
      const config = JSON.parse(await readFile(run.configPath, 'utf8'));
      config.inputs.push({ kind: 'form-projection', path: 'legacy-generated/form-check.generated.json' });
      await writeFile(run.configPath, JSON.stringify(config));
      const report = await runDoctor(run.configPath);
      const sarif = JSON.parse(formatDoctorReport(report, 'sarif'));
      expect(sarif.runs[0].results.find((result: any) => result.properties.subcode === 'duplicate-scalar').properties).toMatchObject({
        schemaPath: '/transport/declarations/title', remediation: expect.any(String), reason: expect.any(String),
      });
      const output: Uint8Array[] = [];
      async function* input() {
        for (const message of [{ method: 'initialize', id: 1 }, { method: 'initialized' }, { method: 'shutdown', id: 2 }, { method: 'exit' }]) {
          const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
          yield Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
        }
      }
      await runDoctorLanguageServer(run.configPath, input(), { write(chunk, callback) { output.push(chunk); callback(); return true; } });
      async function* chunks() { for (const chunk of output) yield chunk; }
      const messages: any[] = [];
      for await (const packet of readLspFrames(chunks())) messages.push(JSON.parse(Buffer.from(packet).toString()));
      const diagnostic = messages.flatMap((message) => message.params?.diagnostics ?? []).find((item) => item.data?.schemaPath === '/transport/declarations/title');
      expect(diagnostic.data).toMatchObject({ remediation: expect.any(String), reason: expect.any(String) });
    } finally { await run.dispose(); }
  });
});
