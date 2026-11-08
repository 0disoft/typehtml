import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceSha256 } from '../contract/behavior.ts';
import { VERSION } from '../version.ts';
import type { Diagnostic, DoctorReport } from './types.ts';

export type DoctorOutputFormat = 'json' | 'text' | 'sarif';

function artifactUri(path: string): string {
  return isAbsolute(path) ? pathToFileURL(path).href : path.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/');
}

function sarifResult(finding: Diagnostic, ruleIndex: number) {
  const location = finding.evidenceRef;
  return {
    ruleId: finding.ruleId, ruleIndex,
    level: finding.severity === 'info' ? 'note' : finding.severity,
    kind: finding.outcome === 'defect' ? 'fail' : finding.outcome === 'inconclusive' ? 'review' : finding.outcome === 'no-finding' ? 'pass' : 'notApplicable',
    message: { text: finding.remediation === undefined ? finding.note : `${finding.note}\nFix: ${finding.remediation}` },
    ...(location === null ? {} : { locations: [{ physicalLocation: {
      artifactLocation: { uri: artifactUri(location.path) },
      region: { startLine: Math.max(1, location.line), startColumn: Math.max(1, location.column) },
    } }] }),
    partialFingerprints: { 'typehtml/v1': sourceSha256(Buffer.from(JSON.stringify([finding.ruleId, finding.causeKey, finding.subcode, location?.path]))) },
    properties: {
      analysisStatus: finding.analysisStatus, certainty: finding.certainty, outcome: finding.outcome,
      scope: finding.scope, subcode: finding.subcode, comparativeValue: finding.comparativeValue,
      ...(finding.schemaPath === undefined ? {} : { schemaPath: finding.schemaPath }),
      ...(finding.reason === undefined ? {} : { reason: finding.reason }),
      ...(finding.remediation === undefined ? {} : { remediation: finding.remediation }),
    },
  };
}

/** SARIF preserves unknown coverage and exit status; an empty result list is not completeness proof. */
export function doctorToSarif(report: DoctorReport) {
  const rules = [...new Set(report.findings.map((finding) => finding.ruleId))].map((id) => ({ id, name: id,
    shortDescription: { text: `TypeHTML ${id}` }, helpUri: 'https://github.com/0disoft/typehtml#readme',
  }));
  const indices = new Map(rules.map((rule, index) => [rule.id, index]));
  const notifications: { level: string; message: { text: string } }[] = [];
  if (report.error) notifications.push({ level: 'error', message: { text: report.error } });
  if (report.analysisTruncated || report.findingsTruncated) notifications.push({ level: 'warning', message: { text: 'Analysis or report limits were reached; this run is incomplete.' } });
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'TypeHTML', semanticVersion: VERSION, informationUri: 'https://github.com/0disoft/typehtml', rules } },
      columnKind: 'utf16CodeUnits',
      invocations: [{ executionSuccessful: report.status === 'executed' && report.exitCode !== 2,
        exitCode: report.exitCode, toolExecutionNotifications: notifications }],
      results: report.findings.map((finding) => sarifResult(finding, indices.get(finding.ruleId)!)),
      properties: { applicationCompleteness: 'not-evaluated', scope: report.scope, coverage: report.coverage,
        analysisTruncated: report.analysisTruncated ?? false, findingsTruncated: report.findingsTruncated, exitCode: report.exitCode },
    }],
  };
}

export function formatDoctorReport(report: DoctorReport, format: DoctorOutputFormat = 'json'): string {
  if (format === 'json') return JSON.stringify(report, null, 2) + '\n';
  if (format === 'sarif') return JSON.stringify(doctorToSarif(report), null, 2) + '\n';
  if (format !== 'text') throw new TypeError('unsupported Doctor output format');
  const lines = [`TypeHTML Doctor: ${report.status}; exit ${report.exitCode}`, `${report.scope.documents} documents, ${report.scope.bindings} bindings, ${report.scope.paths} paths; application completeness not evaluated`];
  if (report.error) lines.push(`ERROR ${report.error}`);
  for (const finding of report.findings) {
    const source = finding.evidenceRef;
    const at = source === null ? '' : `${source.path}:${source.line}:${source.column} `;
    lines.push(`${at}${finding.severity.toUpperCase()} ${finding.ruleId} [${finding.analysisStatus}/${finding.certainty}] ${finding.note}`);
    if (finding.schemaPath !== undefined) lines.push(`  Schema: ${finding.schemaPath}`);
    if (finding.remediation !== undefined) lines.push(`  Fix: ${finding.remediation}`);
  }
  const incomplete = report.coverage.filter((row) => row.actualStatus !== 'checked').length;
  lines.push(`${report.findings.length} findings; ${incomplete} coverage rows remain unknown, unsupported, or not evaluated`);
  if (report.analysisTruncated || report.findingsTruncated) lines.push('INCOMPLETE: analysis or report limit reached');
  return lines.join('\n') + '\n';
}
