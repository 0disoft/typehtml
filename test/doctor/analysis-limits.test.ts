import { describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { runDoctor } from '../../src/doctor/analyze.ts';
import { DEFAULT_ANALYSIS_LIMITS } from '../../src/doctor/budget.ts';
import { defineForm } from '../../src/form/definition.ts';
import { loadForm, projectForm } from '../../src/form/manifest.ts';

async function fixture(fields: number, buttons: number, work: (config: string, controls: number) => Promise<void>, options: { defect?: boolean; missingDocument?: boolean; optional?: boolean } = {}): Promise<void> {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'typehtml-analysis-limits-'));
  try {
    const properties = Object.fromEntries(Array.from({ length: fields }, (_, i) => [`f${i}`, { type: 'integer' as const, minimum: 1, maximum: 10 }]));
    const form = defineForm({ id: 'limits.submit', path: '/submit',
      input: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties },
      output: { type: 'object', additionalProperties: false, required: [], properties: { message: { type: 'string' } } },
    });
    await writeFile(join(directory, 'form.json'), JSON.stringify(form.definition));
    const loaded = await loadForm(join(directory, 'form.json'));
    const projection = projectForm(loaded.form, { sourcePath: 'form.json', sourceSha256: loaded.sourceSha256 });
    const body = Object.keys(properties).map((name) => `<input type="number" name="${name}" min="1" max="10">`).join('')
      + '<input type="hidden" name="_bc_csrf">'
      + Array.from({ length: buttons }, (_, i) => `<button${options.defect && i === 0 ? ' formmethod="get"' : ''}>Send</button>`).join('');
    const document = { path: 'form.html', documentUrl: 'https://example.test/form', sourceKind: 'rendered-snapshot',
      executionAssumption: 'native-no-script', bindings: [{ formId: 'f', actionId: form.id, required: !options.optional }] };
    await Promise.all([
      writeFile(join(directory, 'check.json'), JSON.stringify(projection)),
      writeFile(join(directory, 'form.html'), `<form id="f" method="post" action="/submit">${body}</form>`),
      writeFile(join(directory, 'doctor.json'), JSON.stringify({ format: 'boundary-doctor/0.5-draft', root: directory,
        inputs: [{ kind: 'form-projection', path: 'check.json' }], audit: { releaseRequiresCompleteDeclaredBoundary: false },
        documents: [document, ...(options.missingDocument ? [{ ...document, path: 'unread.html' }] : [])],
      })),
    ]);
    await work(join(directory, 'doctor.json'), fields + 1 + buttons);
  } finally {
    const target = await realpath(directory);
    if (resolve(target) !== resolve(directory) || dirname(target) !== parent || !basename(target).startsWith('typehtml-analysis-limits-')) {
      throw new Error('refusing cleanup outside the analysis-limit fixture');
    }
    await rm(target, { recursive: true, force: true });
  }
}

describe('bounded Doctor orchestration', () => {
  test('admits exact path/control limits and marks a partial optional audit incomplete', async () => {
    await fixture(2, 2, async (config, controls) => {
      const complete = await runDoctor(config, { maxPaths: 2, maxControlVisits: controls * 2 });
      expect(complete.exitCode).toBe(0);
      expect(complete.analysisTruncated).toBeUndefined();
      expect(complete.submissions).toHaveLength(2);
      for (const limits of [{ maxPaths: 1 }, { maxControlVisits: controls * 2 - 1 }]) {
        const partial = await runDoctor(config, limits);
        expect(partial.analysisTruncated).toBe(true);
        expect(partial.exitCode).toBe(3);
        expect(partial.submissions).toEqual(complete.submissions.slice(0, 1));
        expect(partial.findings.some((finding) => finding.subcode === 'analysis-budget-exceeded')).toBe(true);
        expect(partial.coverage.some((row) => row.ruleGroup === 'binding' && row.actualStatus === 'not-evaluated')).toBe(true);
      }
    }, { optional: true });
  });

  test('enforces exact submission byte boundaries before retaining a fact', async () => {
    await fixture(2, 1, async (config) => {
      const complete = await runDoctor(config);
      const bytes = Buffer.byteLength(JSON.stringify(complete.submissions));
      const exact = await runDoctor(config, { maxSubmissionBytes: bytes });
      expect(exact).toEqual(complete);
      const partial = await runDoctor(config, { maxSubmissionBytes: bytes - 1 });
      expect(partial.submissions).toHaveLength(0);
      expect(partial.analysisTruncated).toBe(true);
      expect(partial.exitCode).toBe(3);
      expect(partial.findings[0]?.note).toContain('maxSubmissionBytes');
    });
  });

  test('bounds the reported 500-field by 500-submitter amplification under the default budget', async () => {
    await fixture(500, 500, async (config) => {
      const report = await runDoctor(config);
      expect(report.analysisTruncated).toBe(true);
      expect(report.exitCode).toBe(3);
      expect(report.submissions.length).toBeGreaterThan(0);
      expect(report.submissions.length).toBeLessThan(500);
      expect(Buffer.byteLength(JSON.stringify(report.submissions))).toBeLessThanOrEqual(DEFAULT_ANALYSIS_LIMITS.maxSubmissionBytes);
      expect(report.findings.map((finding) => finding.subcode)).toEqual(['analysis-budget-exceeded']);
      expect(report.coverage.find((row) => row.ruleGroup === 'binding')?.actualStatus).toBe('not-evaluated');
    });
  });

  test('retains a confirmed defect before budget exhaustion and does not read later documents', async () => {
    await fixture(1, 2, async (config) => {
      const report = await runDoctor(config, { maxPaths: 1 });
      expect(report.analysisTruncated).toBe(true);
      expect(report.exitCode).toBe(1);
      expect(report.status).toBe('executed');
      expect(report.error).toBeUndefined();
      expect(report.scope.documents).toBe(1);
      expect(report.findings.some((finding) => finding.subcode === 'method-mismatch')).toBe(true);
      expect(report.coverage.some((row) => row.target === 'unread.html#f' && row.actualStatus === 'not-evaluated')).toBe(true);
    }, { defect: true, missingDocument: true });
  });

  test('reports invalid limits as a configuration failure', async () => {
    await fixture(1, 1, async (config) => {
      const report = await runDoctor(config, { maxPaths: 0 });
      expect(report.exitCode).toBe(2);
      expect(report.status).toBe('configuration-error');
      expect(report.submissions).toHaveLength(0);
    });
  });
});
