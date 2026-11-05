import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../../src/doctor/analyze.ts';
import { loadBoundaryContract } from '../../src/contract/load.ts';
import { projectFormCheck } from '../../src/contract/project.ts';
import { sourceSha256 } from '../../src/contract/behavior.ts';

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
  audit?: Record<string, unknown>;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'boundary-doctor-'));
  dirs.push(dir);
  const checkPath = join(dir, 'form-check.json');
  const htmlPath = join(dir, 'form.html');
  if (options.checkFiles !== false) {
    const check = options.formCheck ?? formCheck();
    const template = JSON.parse(await readFile(new URL('../../docs/design/v0.5/examples/order.boundary.json', import.meta.url), 'utf8'));
    template.id = (check.action as Record<string, unknown>).id;
    template.http.path = (check.action as Record<string, unknown>).path;
    template.input = check.input;
    template.page.intentInitialization.inputFields = Object.keys((check.input as { schema: { properties: object } }).schema.properties);
    const sourcePath = join(dir, 'contract.json');
    await writeFile(sourcePath, JSON.stringify(template));
    const source = await loadBoundaryContract(sourcePath);
    const projection = projectFormCheck(source.contract, source.value, { sourcePath: 'contract.json', sourceSha256: source.sourceSha256 });
    await writeFile(checkPath, JSON.stringify(projection));
    await writeFile(htmlPath, options.html);
  }
  const config = {
    format: 'boundary-doctor/0.5-draft',
    root: dir,
    inputs: [{ kind: 'form-projection', path: 'form-check.json' }],
    ...(options.audit ? { audit: options.audit } : {}),
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

  test('records independent submission provenance and every submitter coverage status', async () => {
    const config = await fixture({ html: '<form id="test-form" method="post" action="/submit"><input name="name"><input type="hidden" name="_bc_csrf"><input type="hidden" name="_bc_request"><button>Send</button><button formenctype="multipart/form-data">Upload</button></form>' });
    const report = await runDoctor(config);
    expect(report.exitCode).toBe(3);
    expect(report.submissions).toHaveLength(2);
    expect(report.submissions[0]?.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.submissions[0]?.intendedAction.path).toBe('/submit');
    expect(report.submissions[1]?.effectiveTarget?.encoding).toBe('multipart/form-data');
    expect(report.coverage.filter((row) => row.ruleGroup === 'target').map((row) => row.actualStatus)).toEqual(['checked', 'unsupported']);
  });

  test('hashes the original document bytes including a UTF-8 BOM without exposing values', async () => {
    const source = '\ufeff' + html('<input name="name" value="private-value"><input type="hidden" name="_bc_csrf" value="private-csrf"><input type="hidden" name="_bc_request">');
    const config = await fixture({ html: source });
    const report = await runDoctor(config);
    expect(report.exitCode).toBe(0);
    expect(report.submissions[0]?.artifact.sha256).toBe(sourceSha256(Buffer.from(source, 'utf8')));
    expect(JSON.stringify(report)).not.toContain('private-value');
    expect(JSON.stringify(report)).not.toContain('private-csrf');
  });

  test('does not turn unsupported choice controls into missing or duplicate scalar defects', async () => {
    const config = await fixture({ html: html('<input type="hidden" name="_bc_csrf"><input type="hidden" name="_bc_request"><input type="radio" name="name" value="a"><input type="radio" name="name" value="b">') });
    const report = await runDoctor(config);
    expect(report.exitCode).toBe(3);
    expect(report.findings.some((finding) => finding.subcode === 'unsupported-control-radio-input')).toBe(true);
    expect(report.findings.some((finding) => finding.subcode === 'missing-required-field' || finding.subcode === 'duplicate-scalar')).toBe(false);
  });

  test('keeps a confirmed target defect beside unsupported control facts', async () => {
    const config = await fixture({ html: '<form id="test-form" method="post" action="https://external.invalid/submit"><select name="name"><option>A</option></select><input type="hidden" name="_bc_csrf"><input type="hidden" name="_bc_request"><button>Send</button></form>' });
    const report = await runDoctor(config);
    expect(report.exitCode).toBe(1);
    expect(report.findings.some((finding) => finding.subcode === 'external-origin')).toBe(true);
    expect(report.findings.some((finding) => finding.subcode === 'unsupported-control-select')).toBe(true);
  });

  test('ignores datalist and reset controls while preserving first-legend fieldset exceptions', async () => {
    const config = await fixture({ html: html('<fieldset disabled><legend><input name="name"></legend><input name="unknown"></fieldset><input type="hidden" name="_bc_csrf"><input type="hidden" name="_bc_request"><datalist><input name="unknown"></datalist><input type="reset" name="name">') });
    const report = await runDoctor(config);
    expect(report.exitCode).toBe(0);
    expect(report.findings).toHaveLength(0);
  });

  test('uses the default button for implicit-only and includes hidden protocol fields without a button', async () => {
    const binding = [{ formId: 'test-form', actionId: 'test.submit', required: true, submitterPolicy: 'implicit-only' }];
    const explicit = await fixture({ bindings: binding, html: '<form id="test-form" method="post" action="/submit"><input name="name"><input type="hidden" name="_bc_csrf"><input type="hidden" name="_bc_request"><button>Send</button><button formaction="/wrong">Other</button></form>' });
    expect((await runDoctor(explicit)).scope.paths).toBe(1);
    expect((await runDoctor(explicit)).exitCode).toBe(0);
    const implicit = await fixture({ bindings: binding, html: '<form id="test-form" method="post" action="/submit"><input name="name"><input type="hidden" name="_bc_csrf"><input type="hidden" name="_bc_request"></form>' });
    const report = await runDoctor(implicit);
    expect(report.exitCode).toBe(0);
    expect(report.submissions[0]?.activation).toBe('implicit-without-button');
    const disabled = await fixture({ bindings: binding, html: '<form id="test-form" method="post" action="/submit"><input name="name"><button disabled>Send</button></form>' });
    expect((await runDoctor(disabled)).exitCode).toBe(3);
  });

  test('does not claim witnesses blocked by step, pattern, readonly, or disabled native validation', async () => {
    for (const attributes of ['type="number" min="2" max="20" step="2"', 'type="number" min="1" max="20" readonly', 'type="text" min="1" max="20" pattern="[0-9]"']) {
      const config = await fixture({ html: html(`<input type="hidden" name="_bc_csrf"><input type="hidden" name="_bc_request"><input name="name"><input name="quantity" ${attributes}>`) });
      expect((await runDoctor(config)).findings.some((finding) => finding.ruleId === 'BC013')).toBe(false);
    }
    const config = await fixture({ html: '<form id="test-form" method="post" action="/submit" novalidate><input name="name"><input type="hidden" name="_bc_csrf"><input type="hidden" name="_bc_request"><input name="quantity" type="number" min="1" max="20"><button>Send</button></form>' });
    expect((await runDoctor(config)).findings.some((finding) => finding.ruleId === 'BC013')).toBe(false);
  });

  test('finds the design C3 witness through its known ASCII integer text pattern', async () => {
    const config = await fixture({ html: html('<input type="hidden" name="_bc_csrf"><input type="hidden" name="_bc_request"><input name="name"><input name="quantity" type="text" required maxlength="2" pattern="([1-9]|1[0-9]|20)">') });
    const report = await runDoctor(config);
    expect(report.exitCode).toBe(0);
    expect(report.findings.find((finding) => finding.ruleId === 'BC013')?.witness?.rawValue).toBe('11');
  });

  test('treats fragment as warning and empty formaction as document URL despite a base', async () => {
    const config = await fixture({ documentUrl: 'https://example.invalid/submit', html: '<base href="https://external.invalid/"><form id="test-form" method="post" action="/wrong"><input name="name"><input type="hidden" name="_bc_csrf"><input type="hidden" name="_bc_request"><button formaction="">Send</button><button formaction="https://example.invalid/submit#receipt">Fragment</button></form>' });
    const report = await runDoctor(config);
    expect(report.exitCode).toBe(0);
    expect(report.submissions[0]?.effectiveTarget?.url).toBe('https://example.invalid/submit');
    expect(report.findings.find((finding) => finding.subcode === 'fragment-not-in-request')?.severity).toBe('warning');
  });

  test('stops stale projection connection checks with BC193', async () => {
    const config = await fixture({ html: html('<input name="forged">') });
    const projectionPath = join(dirs[dirs.length - 1]!, 'form-check.json');
    const projection = JSON.parse(await readFile(projectionPath, 'utf8'));
    projection.source.sha256 = hex('0');
    await writeFile(projectionPath, JSON.stringify(projection));
    const report = await runDoctor(config);
    expect(report.exitCode).toBe(3);
    expect(report.findings.map((finding) => finding.ruleId)).toEqual(['BC193']);
    expect(report.submissions).toHaveLength(0);
  });

  test('does not mark a duplicate id shared with a non-form element as a unique binding', async () => {
    const config = await fixture({ html: '<div id="test-form"></div><form id="test-form" method="post" action="/submit"><input name="name"><button>Send</button></form>' });
    const report = await runDoctor(config);
    expect(report.exitCode).toBe(1);
    expect(report.findings.some((finding) => finding.ruleId === 'BC014' && finding.subcode === 'form-duplicate')).toBe(true);
  });

  test('honors optional bindings and audit-only partial policy', async () => {
    const optional = await fixture({ html: '<p>No form in this branch</p>', bindings: [{ formId: 'test-form', actionId: 'test.submit', required: false }] });
    expect((await runDoctor(optional)).exitCode).toBe(0);
    const partial = await fixture({ html: html('<select name="name"></select>'), audit: { releaseRequiresCompleteDeclaredBoundary: false } });
    const report = await runDoctor(partial);
    // Protocol supply errors still block an audit even when incomplete coverage is allowed.
    expect(report.exitCode).toBe(1);
    expect(report.coverage.some((row) => row.actualStatus === 'unknown')).toBe(true);
    const auditOnly = await fixture({ html: html('<select name="name"></select><input type="hidden" name="_bc_csrf"><input type="hidden" name="_bc_request">'), audit: { releaseRequiresCompleteDeclaredBoundary: false } });
    expect((await runDoctor(auditOnly)).exitCode).toBe(0);
  });

  test('rejects invalid UTF-8 and authoritative source paths outside the root', async () => {
    const malformed = await fixture({ html: html('<input name="name">') });
    await writeFile(join(dirs[dirs.length - 1]!, 'form.html'), Buffer.from([0xc3, 0x28]));
    expect((await runDoctor(malformed)).exitCode).toBe(2);
    const escaped = await fixture({ html: html('<input name="name">') });
    const projectionPath = join(dirs[dirs.length - 1]!, 'form-check.json');
    const projection = JSON.parse(await readFile(projectionPath, 'utf8'));
    projection.source.path = '../contract.json';
    await writeFile(projectionPath, JSON.stringify(projection));
    expect((await runDoctor(escaped)).exitCode).toBe(2);
  });

  test('keeps the blocking exit status when the diagnostic output limit is reached', async () => {
    const files = Array.from({ length: 1000 }, (_, index) => `<input type="file" name="file${index}">`).join('');
    const config = await fixture({ html: html(files) });
    const report = await runDoctor(config);
    expect(report.findings).toHaveLength(1000);
    expect(report.findingsTruncated).toBe(true);
    expect(report.findings.every((finding) => finding.analysisStatus === 'unknown')).toBe(true);
    expect(report.exitCode).toBe(1);
  });

  test('retains confirmed findings when another selected document cannot be read', async () => {
    const config = await fixture({ html: html('<input type="hidden" name="_bc_csrf"><input type="hidden" name="_bc_request">') });
    const value = JSON.parse(await readFile(config, 'utf8'));
    value.documents.push({ ...value.documents[0], path: 'missing.html' });
    await writeFile(config, JSON.stringify(value));
    const report = await runDoctor(config);
    expect(report.exitCode).toBe(2);
    expect(report.scope.documents).toBe(1);
    expect(report.findings.some((finding) => finding.ruleId === 'BC010')).toBe(true);
    expect(report.coverage.some((row) => row.target === 'missing.html#test-form' && row.actualStatus === 'not-evaluated')).toBe(true);
  });

  test('requires configured rule groups on every activation even if no result row was produced', async () => {
    const audit = { releaseRequiredRuleGroups: ['supply'] };
    const noActivation = await fixture({ html: '<form id="test-form" method="post" action="/submit"><input name="name"><input name="quantity"></form>', audit });
    expect((await runDoctor(noActivation)).exitCode).toBe(3);
    const partlySupported = await fixture({ html: html('<input name="name"><input type="hidden" name="_bc_csrf"><input type="hidden" name="_bc_request"><button formenctype="multipart/form-data">Upload</button>'), audit });
    const report = await runDoctor(partlySupported);
    expect(report.exitCode).toBe(3);
    expect(report.coverage.some((row) => row.ruleGroup === 'supply' && row.actualStatus === 'not-evaluated')).toBe(true);
  });

  test('does not report complete required coverage when bounded warnings were truncated', async () => {
    const check = formCheck();
    const input = check.input as { schema: { properties: Record<string, unknown> }; codecs: Record<string, string> };
    for (let index = 0; index < 1001; index++) {
      input.schema.properties[`count${index}`] = { type: 'integer', minimum: 1, maximum: 10 };
      input.codecs[`count${index}`] = 'decimal-integer';
    }
    const fields = Array.from({ length: 1001 }, (_, index) => `<input name="count${index}" type="number" min="1" max="20">`).join('');
    const config = await fixture({ formCheck: check, html: html(`<input name="name"><input type="hidden" name="_bc_csrf"><input type="hidden" name="_bc_request">${fields}`) });
    const report = await runDoctor(config);
    expect(report.findingsTruncated).toBe(true);
    expect(report.findings.every((finding) => finding.severity === 'warning')).toBe(true);
    expect(report.exitCode).toBe(3);
  });
});
