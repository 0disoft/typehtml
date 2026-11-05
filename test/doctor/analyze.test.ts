import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../../src/doctor/analyze.ts';

const dirs: string[] = [];

function hex(fill: string): string {
  return fill.repeat(64).slice(0, 64);
}

function formCheck(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'boundary-form-check/0.2-draft',
    status: 'generated-design-reference-not-product-output',
    source: {
      path: 'contract.json',
      sha256: hex('a'),
      generator: 'test',
      projection: 'exact-for-selected-structural-fields',
      runtimeCoverage: 'not-evaluated',
      behaviorSha256: hex('b'),
    },
    action: {
      id: 'test.submit',
      method: 'POST',
      path: '/submit',
      encoding: 'urlencoded',
      parserProfile: 'strict-urlencoded-utf8/1',
    },
    input: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 3 },
          quantity: { type: 'integer', minimum: 1, maximum: 10 },
        },
      },
      codecs: { name: 'text', quantity: 'decimal-integer' },
      unknownKeys: 'reject',
      duplicateScalars: 'reject',
      scalarSemantics: {
        missing: 'absent',
        emptyString: 'preserve',
        textNormalization: 'none',
        schemaStringLength: 'unicode-code-points',
        validationMutatesData: false,
      },
    },
    protocolFields: ['_bc_csrf', '_bc_request'],
    ...overrides,
  };
}

async function fixture(options: {
  html: string;
  formCheck?: Record<string, unknown>;
  bindings?: unknown[];
  documentUrl?: string;
  checkFiles?: boolean;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'boundary-doctor-'));
  dirs.push(dir);
  const checkPath = join(dir, 'form-check.json');
  const htmlPath = join(dir, 'form.html');
  if (options.checkFiles !== false) {
    await writeFile(checkPath, JSON.stringify(options.formCheck ?? formCheck()));
    await writeFile(htmlPath, options.html);
  }
  const config = {
    format: 'boundary-doctor/0.5-draft',
    root: dir,
    inputs: [{ kind: 'form-projection', path: 'form-check.json' }],
    documents: [
      {
        path: 'form.html',
        documentUrl: options.documentUrl ?? 'https://example.invalid/form',
        sourceKind: 'rendered-snapshot',
        executionAssumption: 'native-no-script-by-example',
        bindings: options.bindings ?? [
          { formId: 'test-form', actionId: 'test.submit', required: true, submitterPolicy: 'enumerate-native', constraintMismatchSeverity: 'warning' },
        ],
      },
    ],
  };
  const configPath = join(dir, 'doctor.config.json');
  await writeFile(configPath, JSON.stringify(config));
  return configPath;
}

function html(body: string): string {
  return `<!doctype html><html><body><form id="test-form" method="post" action="/submit">${body}<button type="submit">Send</button></form></body></html>`;
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('Doctor form-link analysis', () => {
  test('runs the selected snapshot without findings except a bounded constraint witness', async () => {
    const config = await fixture({
      html: html(
        '<input type="hidden" name="_bc_csrf" value="token"><input type="hidden" name="_bc_request" value="request"><input name="name" maxlength="3"><input name="quantity" type="number" min="1" max="20" value="2">',
      ),
    });
    const report = await runDoctor(config);
    expect(report.status).toBe('executed');
    expect(report.exitCode).toBe(0);
    expect(report.scope.paths).toBe(1);
    const witnesses = report.findings.filter((finding) => finding.ruleId === 'BC013');
    expect(witnesses).toHaveLength(1);
    expect(witnesses[0]?.witness).toEqual({
      rawValue: '11',
      codecValue: 11,
      hypotheticalServerMaximum: 10,
      unchangedHtmlMaximum: 20,
    });
  });

  test('reports a missing required field', async () => {
    const config = await fixture({
      html: html('<input type="hidden" name="_bc_csrf" value="token"><input type="hidden" name="_bc_request" value="request">'),
    });
    const report = await runDoctor(config);
    expect(report.exitCode).toBe(1);
    expect(report.findings.some((finding) => finding.ruleId === 'BC010' && finding.subcode === 'missing-required-field')).toBe(true);
  });

  test('reports an unregistered field and a duplicate scalar', async () => {
    const config = await fixture({
      html: html(
        '<input type="hidden" name="_bc_csrf" value="token"><input type="hidden" name="_bc_request" value="request"><input name="name"><input name="quantity" type="number"><input name="quantity" type="number"><input name="ownerId" value="forged">',
      ),
    });
    const report = await runDoctor(config);
    expect(report.exitCode).toBe(1);
    expect(report.findings.some((finding) => finding.ruleId === 'BC011' && finding.subcode === 'unregistered-field')).toBe(true);
    expect(report.findings.some((finding) => finding.ruleId === 'BC011' && finding.subcode === 'duplicate-scalar')).toBe(true);
  });

  test('reports a method or path mismatch', async () => {
    const config = await fixture({
      html: `<!doctype html><form id="test-form" method="get" action="/other"><input type="hidden" name="_bc_csrf" value="token"><input type="hidden" name="_bc_request" value="request"><input name="name"><input name="quantity" type="number"><button type="submit">Send</button></form>`,
    });
    const report = await runDoctor(config);
    expect(report.exitCode).toBe(1);
    expect(report.findings.some((finding) => finding.ruleId === 'BC011' && finding.subcode === 'method-mismatch')).toBe(true);
    expect(report.findings.some((finding) => finding.ruleId === 'BC011' && finding.subcode === 'path-mismatch')).toBe(true);
  });

  test('reports an external target and a missing form binding', async () => {
    const external = await fixture({
      html: `<!doctype html><form id="test-form" method="post" action="https://evil.invalid/submit"><input type="hidden" name="_bc_csrf" value="token"><input type="hidden" name="_bc_request" value="request"><input name="name"><input name="quantity" type="number"><button type="submit">Send</button></form>`,
    });
    const externalReport = await runDoctor(external);
    expect(externalReport.exitCode).toBe(1);
    expect(externalReport.findings.some((finding) => finding.subcode === 'external-origin')).toBe(true);

    const missing = await fixture({ html: '<!doctype html><form id="other"><input name="name"></form>' });
    const missingReport = await runDoctor(missing);
    expect(missingReport.exitCode).toBe(1);
    expect(missingReport.findings.some((finding) => finding.ruleId === 'BC014' && finding.subcode === 'form-missing')).toBe(true);
  });

  test('marks unsupported native transport incomplete instead of success', async () => {
    const config = await fixture({
      html: `<!doctype html><form id="test-form" method="post" action="/submit" enctype="multipart/form-data"><input name="name"><button type="submit">Send</button></form>`,
    });
    const report = await runDoctor(config);
    expect(report.exitCode).toBe(3);
    expect(report.findings.some((finding) => finding.ruleId === 'BC012')).toBe(true);
  });

  test('treats zero declared bindings as a configuration error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'boundary-doctor-'));
    dirs.push(dir);
    const configPath = join(dir, 'doctor.config.json');
    await writeFile(configPath, JSON.stringify({ format: 'boundary-doctor/0.5-draft', root: dir, inputs: [], documents: [] }));
    const report = await runDoctor(configPath);
    expect(report.status).toBe('configuration-error');
    expect(report.exitCode).toBe(2);
    expect(report.productRun).toBe(false);
  });
});