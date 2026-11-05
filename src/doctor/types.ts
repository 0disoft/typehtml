import type { FormCheck } from '../contract/types.ts';

export type DiagnosticOutcome = 'defect' | 'no-finding' | 'inconclusive' | 'not-applicable';
export type AnalysisStatus = 'checked' | 'unknown' | 'unsupported' | 'not-evaluated';
export type Certainty = 'confirmed' | 'conditional' | 'none';
export type Severity = 'error' | 'warning' | 'info';

export interface SourceLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

export interface Diagnostic {
  readonly ruleId: string;
  readonly engineOrigin: 'boundary';
  readonly originalRuleId: string;
  readonly causeKey: string;
  readonly stage: 'static-form' | 'configuration';
  readonly outcome: DiagnosticOutcome;
  readonly analysisStatus: AnalysisStatus;
  readonly certainty: Certainty;
  readonly severity: Severity;
  readonly evidenceRef: SourceLocation | null;
  readonly comparativeValue: 'not-evaluated';
  readonly ruleStatus: 'checked' | 'unknown' | 'unsupported' | 'not-evaluated';
  readonly scope: {
    readonly kind: 'selected-snapshot';
    readonly applicationCompleteness: 'not-evaluated';
  };
  readonly note: string;
  readonly subcode?: string;
  readonly witness?: {
    readonly rawValue: string;
    readonly codecValue: string | number;
    readonly hypotheticalServerMinimum?: number;
    readonly hypotheticalServerMaximum?: number;
    readonly unchangedHtmlMaximum?: number;
  };
}

export interface CoverageRow {
  readonly target: string;
  readonly ruleGroup: 'binding' | 'target' | 'supply' | 'cardinality' | 'constraints' | 'runtime-security' | 'bypass';
  readonly actualStatus: AnalysisStatus;
  readonly evidenceRef: SourceLocation | null;
  readonly note: string;
}

export interface DoctorReport {
  readonly format: 'boundary-doctor-report/0.1-draft';
  readonly status: 'executed' | 'configuration-error';
  readonly productRun: boolean;
  readonly configPath: string;
  readonly scope: {
    readonly documents: number;
    readonly forms: number;
    readonly bindings: number;
    readonly paths: number;
    readonly applicationCompleteness: 'not-evaluated';
  };
  readonly findings: readonly Diagnostic[];
  readonly coverage: readonly CoverageRow[];
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly error?: string;
}

export interface DoctorBindingConfig {
  readonly formId: string;
  readonly actionId: string;
  readonly required: boolean;
  readonly submitterPolicy: 'enumerate-native' | 'implicit-only';
  readonly constraintMismatchSeverity: Severity;
}

export interface DoctorDocumentConfig {
  readonly path: string;
  readonly documentUrl: string;
  readonly sourceKind: string;
  readonly executionAssumption: string;
  readonly bindings: readonly DoctorBindingConfig[];
}

export interface DoctorInputConfig {
  readonly kind: 'form-projection';
  readonly path: string;
}

export interface DoctorConfig {
  readonly format: 'boundary-doctor/0.5-draft';
  readonly root: string;
  readonly inputs: readonly DoctorInputConfig[];
  readonly documents: readonly DoctorDocumentConfig[];
}

export interface LoadedDoctorConfig {
  readonly config: DoctorConfig;
  readonly configPath: string;
  readonly baseDir: string;
  readonly formChecks: ReadonlyMap<string, FormCheck>;
}

export function diagnosticError(
  ruleId: string,
  originalRuleId: string,
  causeKey: string,
  code: string,
  note: string,
  location: SourceLocation | null,
  severity: Severity = 'error',
): Diagnostic {
  return {
    ruleId,
    engineOrigin: 'boundary',
    originalRuleId,
    causeKey,
    stage: 'static-form',
    outcome: 'defect',
    analysisStatus: 'checked',
    certainty: 'confirmed',
    severity,
    evidenceRef: location,
    comparativeValue: 'not-evaluated',
    ruleStatus: 'checked',
    scope: { kind: 'selected-snapshot', applicationCompleteness: 'not-evaluated' },
    note,
    subcode: code,
  };
}

export function diagnosticUnknown(
  ruleId: string,
  originalRuleId: string,
  causeKey: string,
  code: string,
  note: string,
  location: SourceLocation | null,
): Diagnostic {
  return {
    ruleId,
    engineOrigin: 'boundary',
    originalRuleId,
    causeKey,
    stage: 'static-form',
    outcome: 'inconclusive',
    analysisStatus: 'unknown',
    certainty: 'none',
    severity: 'info',
    evidenceRef: location,
    comparativeValue: 'not-evaluated',
    ruleStatus: 'unknown',
    scope: { kind: 'selected-snapshot', applicationCompleteness: 'not-evaluated' },
    note,
    subcode: code,
  };
}
