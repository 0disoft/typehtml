import { describe, expect, test } from 'bun:test';
import { configErrorReport } from '../../src/doctor/analyze.ts';
import { doctorToSarif, formatDoctorReport } from '../../src/doctor/format.ts';
import { diagnosticError, diagnosticUnknown, type DoctorReport } from '../../src/doctor/types.ts';

function report(): DoctorReport {
  return { ...configErrorReport('doctor.json', 'unused'), status: 'executed', productRun: true, error: undefined, exitCode: 3,
    findings: [diagnosticError('BC011', 'key', 'key', 'duplicate', 'duplicate scalar', { path: 'forms/a b.html', line: 2, column: 3, offset: 5 }),
      diagnosticUnknown('BC012', 'unknown', 'choice', 'conditional', 'conditional choice', null)],
    coverage: [{ target: 'forms/a b.html#form', ruleGroup: 'supply', actualStatus: 'unknown', evidenceRef: null, note: 'conditional' }],
    analysisTruncated: true };
}

describe('Doctor output formats', () => {
  test('retains JSON report and exit status', () => { expect(JSON.parse(formatDoctorReport(report()))).toEqual(report()); });
  test('text includes locations, unknown coverage and truncation', () => {
    const text = formatDoctorReport(report(), 'text');
    expect(text).toContain('forms/a b.html:2:3 ERROR BC011');
    expect(text).toContain('[unknown/none]');
    expect(text).toContain('1 coverage rows');
    expect(text).toContain('INCOMPLETE');
    expect(text).toContain('exit 3');
  });
  test('SARIF has stable rules, locations and review results without pretending completeness', () => {
    const sarif = doctorToSarif(report());
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0]?.tool.driver.rules.map((rule) => rule.id)).toEqual(['BC011', 'BC012']);
    const results = sarif.runs[0]!.results;
    expect(results[0]?.kind).toBe('fail');
    expect(results[0]?.locations?.[0]?.physicalLocation.artifactLocation.uri).toBe('forms/a%20b.html');
    expect(results[1]?.kind).toBe('review');
    expect(sarif.runs[0]?.properties.applicationCompleteness).toBe('not-evaluated');
    expect(sarif.runs[0]?.invocations[0]?.exitCode).toBe(3);
    expect(JSON.parse(formatDoctorReport(report(), 'sarif'))).toEqual(sarif);
  });
  test('configuration failures remain unsuccessful SARIF executions', () => {
    const sarif = doctorToSarif(configErrorReport('missing.json', 'file missing'));
    expect(sarif.runs[0]?.invocations[0]?.executionSuccessful).toBe(false);
    expect(sarif.runs[0]?.invocations[0]?.toolExecutionNotifications[0]?.message.text).toBe('file missing');
  });
});
