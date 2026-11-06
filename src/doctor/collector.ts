import type { CoverageRow, Diagnostic, LoadedDoctorConfig, Severity } from './types.ts';

const MAX_REPORT_FINDINGS = 1000;
function severityRank(value: Severity): number {
  return value === 'error' ? 3 : value === 'warning' ? 2 : 1;
}

export interface Collector {
  readonly findings: Diagnostic[];
  readonly coverage: CoverageRow[];
  add(finding: Diagnostic): void;
  cover(row: CoverageRow): void;
  hasError(): boolean;
  isIncomplete(): boolean;
  scope(required: boolean, activation: string, target?: string): void;
  truncated(): boolean;
  completeBoundary(): void;
}

export function makeCollector(loaded: LoadedDoctorConfig): Collector {
  const findings: Diagnostic[] = [];
  const byKey = new Map<string, number>();
  const coverage: CoverageRow[] = [];
  const coverageKeys = new Map<string, number>();
  const activationsByTarget = new Map<string, Set<string>>();
  const coverageKey = (target: string, group: CoverageRow['ruleGroup'], path: string) => JSON.stringify([target, group, path]);
  const appendCoverage = (row: CoverageRow) => {
    coverageKeys.set(coverageKey(row.target, row.ruleGroup, row.activation!), coverage.length);
    coverage.push(row);
    if (row.activation !== 'binding') {
      let paths = activationsByTarget.get(row.target);
      if (!paths) activationsByTarget.set(row.target, paths = new Set());
      paths.add(row.activation!);
    }
  };
  let requiredBoundary = true;
  let activation = 'binding';
  let scopedTarget = '';
  let hasBlockingError = false;
  let findingsTruncated = false;
  let requiredTruncation = false;
  const statusRank = (status: CoverageRow['actualStatus']) => status === 'unsupported' ? 4 : status === 'unknown' ? 3 : status === 'not-evaluated' ? 2 : 1;
  return {
    findings,
    coverage,
    scope(required, path, target) { requiredBoundary = required; activation = path; if (target !== undefined) scopedTarget = target; },
    truncated() { return findingsTruncated; },
    completeBoundary() {
      const activations = [...(activationsByTarget.get(scopedTarget) ?? [])];
      for (const group of loaded.config.releaseRequiredRuleGroups) {
        const scopes = ['binding', 'runtime-security', 'bypass'].includes(group) ? ['binding'] : activations.length > 0 ? activations : ['binding'];
        for (const path of scopes) {
          if (!coverageKeys.has(coverageKey(scopedTarget, group, path))) appendCoverage({
            target: scopedTarget, ruleGroup: group, actualStatus: 'not-evaluated', evidenceRef: null,
            note: 'required rule group was not evaluated for this declared boundary and activation', activation: path, requiredBoundary,
          });
        }
      }
    },
    add(finding) {
      hasBlockingError ||= finding.outcome === 'defect' && finding.severity === 'error';
      const scoped = { ...finding, scope: { ...finding.scope, target: scopedTarget, activation } };
      const key = [scopedTarget, finding.ruleId, finding.causeKey, finding.subcode ?? '', finding.evidenceRef?.path ?? '', finding.evidenceRef?.offset ?? ''].join('|');
      const index = byKey.get(key);
      if (index === undefined) {
        if (findings.length >= MAX_REPORT_FINDINGS) { findingsTruncated = true; requiredTruncation ||= requiredBoundary; return; }
        byKey.set(key, findings.length);
        findings.push(scoped);
        return;
      }
      const current = findings[index];
      if (current && severityRank(finding.severity) > severityRank(current.severity)) findings[index] = scoped;
    },
    cover(row) {
      const key = coverageKey(row.target, row.ruleGroup, activation);
      const scoped = { ...row, activation, requiredBoundary };
      const index = coverageKeys.get(key);
      if (index !== undefined) {
        if (statusRank(row.actualStatus) > statusRank(coverage[index]!.actualStatus)) coverage[index] = scoped;
        return;
      }
      appendCoverage(scoped);
    },
    hasError() {
      return hasBlockingError;
    },
    isIncomplete() {
      return loaded.config.releaseRequiresCompleteDeclaredBoundary && (requiredTruncation || coverage.some((row) =>
        row.requiredBoundary && loaded.config.releaseRequiredRuleGroups.includes(row.ruleGroup) && row.actualStatus !== 'checked'));
    },
  };
}
