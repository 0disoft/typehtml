import type { FormCheck, IntegerFieldSchema, StringFieldSchema } from '../contract/types.ts';
import {
  canImplicitlySubmit,
  collectFormEntries,
  findSubmitters,
  parseHtmlDocument,
  resolveEffectiveTarget,
  attribute,
} from './html.ts';
import type { ControlFact, FormFact, ParsedDocument } from './html.ts';
import { DoctorConfigError, loadDoctorConfig, readConfiguredDocument, MAX_TOTAL_DOCUMENT_BYTES } from './config.ts';
import type { LoadedDoctorConfig } from './types.ts';
import type {
  CoverageRow,
  Diagnostic,
  DoctorReport,
  Severity,
  SourceLocation,
} from './types.ts';
import { diagnosticError, diagnosticUnknown } from './types.ts';

const MAX_REPORT_FINDINGS = 1000;

function severityRank(value: Severity): number {
  return value === 'error' ? 3 : value === 'warning' ? 2 : 1;
}

function targetPath(documentPath: string, binding: { formId: string }): string {
  return `${documentPath}#${binding.formId}`;
}

function fieldLocation(control: ControlFact | undefined): SourceLocation | null {
  return control?.location ?? null;
}

function noteForName(name: string): string {
  return JSON.stringify(name);
}

interface Collector {
  readonly findings: Diagnostic[];
  readonly coverage: CoverageRow[];
  add(finding: Diagnostic): void;
  cover(row: CoverageRow): void;
  hasError(): boolean;
  isIncomplete(): boolean;
}

function makeCollector(): Collector {
  const findings: Diagnostic[] = [];
  const byKey = new Map<string, number>();
  const coverage: CoverageRow[] = [];
  const coverageKeys = new Set<string>();
  return {
    findings,
    coverage,
        add(finding) {
      if (findings.length >= MAX_REPORT_FINDINGS) return;
      const key = [finding.ruleId, finding.causeKey, finding.subcode ?? ''].join('|');
      const index = byKey.get(key);
      if (index === undefined) {
        byKey.set(key, findings.length);
        findings.push(finding);
        return;
      }
      const current = findings[index];
      if (current && severityRank(finding.severity) > severityRank(current.severity)) findings[index] = finding;
    },
    cover(row) {
      const key = `${row.target}|${row.ruleGroup}`;
      if (coverageKeys.has(key)) return;
      coverageKeys.add(key);
      coverage.push(row);
    },
    hasError() {
      return findings.some((finding) => finding.outcome === 'defect' && finding.severity === 'error');
    },
    isIncomplete() {
      return (
        findings.some((finding) => finding.analysisStatus === 'unknown' || finding.analysisStatus === 'unsupported') ||
        coverage.some((row) => row.actualStatus === 'unknown' || row.actualStatus === 'unsupported')
      );
    },
  };
}

function configErrorReport(configPath: string, message: string): DoctorReport {
  return {
    format: 'boundary-doctor-report/0.1-draft',
    status: 'configuration-error',
    productRun: false,
    configPath,
    scope: { documents: 0, forms: 0, bindings: 0, paths: 0, applicationCompleteness: 'not-evaluated' },
    findings: [],
    coverage: [],
    exitCode: 2,
    error: message,
  };
}

function actionPathMatches(actual: string, expected: string): boolean {
  return actual === expected;
}

function compareTarget(
  collector: Collector,
  check: FormCheck,
  target: { url: URL; method: string },
  documentPath: string,
  formId: string,
  location: SourceLocation,
): boolean {
  let ok = true;
  const cause = `${check.action.id}/native/target`;
  if (target.method.toLowerCase() !== check.action.method.toLowerCase()) {
    collector.add(
      diagnosticError(
        'BC011',
        'method-path-mismatch',
        `${cause}/method`,
        'method-mismatch',
        `native method ${target.method.toUpperCase()} does not match contract method ${check.action.method}`,
        location,
      ),
    );
    ok = false;
  }
  if (!actionPathMatches(target.url.pathname, check.action.path)) {
    collector.add(
      diagnosticError(
        'BC011',
        'method-path-mismatch',
        `${cause}/path`,
        'path-mismatch',
        `native path ${target.url.pathname} does not match contract path ${check.action.path}`,
        location,
      ),
    );
    ok = false;
  }
  if (target.url.search !== '' || target.url.hash !== '') {
    collector.add(
      diagnosticError(
        'BC011',
        'method-path-mismatch',
        `${cause}/query`,
        'query-not-in-contract',
        'native action carries query or fragment that the contract path does not define',
        location,
      ),
    );
    ok = false;
  }
  collector.cover({
    target: `${documentPath}#${formId}`,
    ruleGroup: 'target',
    actualStatus: 'checked',
    evidenceRef: location,
    note: ok ? 'native target compared with the selected projection' : 'target mismatch recorded as a defect',
  });
  return ok;
}

interface SupplyResult {
  readonly checked: boolean;
  readonly unsupportedNames: ReadonlySet<string>;
  readonly entries: ReturnType<typeof collectFormEntries>;
}

function checkSupply(
  collector: Collector,
  check: FormCheck,
  form: FormFact,
  submitter: ControlFact | null,
  documentPath: string,
  binding: { formId: string; actionId: string },
  location: SourceLocation,
): SupplyResult {
  const collection = collectFormEntries(form, submitter);
  const properties = new Set(Object.keys(check.input.schema.properties));
  const protocol = new Set(check.protocolFields);
  const allowed = new Set([...properties, ...protocol]);
  const required = new Set([...check.input.schema.required, ...check.protocolFields]);
  const names = new Set(collection.entries.map((entry) => entry.name));
  let checked = collection.unsupportedNames.size === 0;
  const causeBase = `${binding.actionId}/native`;
  for (const entry of collection.entries) {
    if (!allowed.has(entry.name)) {
      collector.add(
        diagnosticError(
          'BC011',
          'unregistered-field',
          `${causeBase}/${entry.name}/unregistered`,
          'unregistered-field',
          `native field ${noteForName(entry.name)} is not declared by the selected contract`,
          entry.control.location,
        ),
      );
    }
  }
  for (const [name, count] of collection.possibleCounts) {
    if (allowed.has(name) && count > 1) {
      collector.add(
        diagnosticError(
          'BC011',
          'duplicate-scalar',
          `${causeBase}/${name}/duplicate`,
          'duplicate-scalar',
          `native form can supply scalar ${noteForName(name)} more than once`,
          fieldLocation(collection.entries.find((entry) => entry.name === name)?.control),
        ),
      );
    }
  }
  for (const control of collection.unsupportedControls) {
    if (control.control.name && allowed.has(control.control.name)) checked = false;
    collector.add(
      diagnosticUnknown(
        'BC012',
        'unsupported-control',
        `${causeBase}/${control.control.name ?? 'unnamed'}/unsupported-${control.reason}`,
        `unsupported-control-${control.reason}`,
        `native control cannot be represented by the form-only profile: ${control.reason}`,
        control.control.location,
      ),
    );
  }
  for (const name of required) {
    if (names.has(name)) continue;
    if (collection.unsupportedNames.has(name)) {
      checked = false;
      collector.add(
        diagnosticUnknown(
          'BC010',
          'missing-required-field',
          `${causeBase}/${name}/supply-unknown`,
          'required-supply-unknown',
          `required field ${noteForName(name)} may be supplied by an unsupported control`,
          fieldLocation(collection.entries.find((entry) => entry.name === name)?.control),
        ),
      );
      continue;
    }
    collector.add(
      diagnosticError(
        'BC010',
        'missing-required-field',
        `${causeBase}/${name}/missing`,
        'missing-required-field',
        `required field ${noteForName(name)} has no successful native control`,
        location,
      ),
    );
  }
  collector.cover({
    target: `${documentPath}#${binding.formId}`,
    ruleGroup: 'supply',
    actualStatus: checked ? 'checked' : 'unknown',
    evidenceRef: location,
    note: checked
      ? 'required fields and declared key namespace compared against enumerated native controls'
      : 'at least one required or declared field is supplied by an unsupported control',
  });
  collector.cover({
    target: `${documentPath}#${binding.formId}`,
    ruleGroup: 'cardinality',
    actualStatus: checked ? 'checked' : 'unknown',
    evidenceRef: location,
    note: 'scalar multiplicity is approximated from the native control set; submitter paths are enumerated separately',
  });
  return { checked, unsupportedNames: collection.unsupportedNames, entries: collection };
}

function integerAttribute(control: ControlFact, name: string): number | null {
  const raw = attribute(control.element, name);
  if (raw === null || raw.trim() === '') return null;
  if (!/^-?(0|[1-9][0-9]*)$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function stringAttribute(control: ControlFact, name: string): number | null {
  const raw = attribute(control.element, name);
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function checkConstraints(
  collector: Collector,
  check: FormCheck,
  collection: ReturnType<typeof collectFormEntries>,
  documentPath: string,
  binding: { formId: string; actionId: string; constraintMismatchSeverity: Severity },
): void {
  let evaluated = false;
  const witness = (finding: Omit<Diagnostic, 'witness'> & { witness: NonNullable<Diagnostic['witness']> }) => {
    evaluated = true;
    collector.add({ ...finding, witness: finding.witness });
  };
  for (const [name, schema] of Object.entries(check.input.schema.properties)) {
    const entry = collection.entries.find((candidate) => candidate.name === name);
    if (!entry) continue;
    const control = entry.control;
    if (schema.type === 'integer') {
      const integer = schema as IntegerFieldSchema;
      const htmlMax = integerAttribute(control, 'max');
      const htmlMin = integerAttribute(control, 'min');
      if (integer.maximum !== undefined && htmlMax !== null && htmlMax > integer.maximum) {
        const raw = String(integer.maximum + 1);
        witness({
          ...diagnosticError(
            'BC013',
            'known-constraint-witness',
            `${binding.actionId}/${name}/max-witness`,
            'max-witness',
            `native max ${htmlMax} permits ${raw}, which the selected contract rejects`,
            control.location,
            binding.constraintMismatchSeverity,
          ),
          witness: {
            rawValue: raw,
            codecValue: integer.maximum + 1,
            hypotheticalServerMaximum: integer.maximum,
            unchangedHtmlMaximum: htmlMax,
          },
        });
      }
      if (integer.minimum !== undefined && htmlMin !== null && htmlMin < integer.minimum) {
        const candidate = integer.minimum - 1;
        witness({
          ...diagnosticError(
            'BC013',
            'known-constraint-witness',
            `${binding.actionId}/${name}/min-witness`,
            'min-witness',
            `native min ${htmlMin} permits ${candidate}, which the selected contract rejects`,
            control.location,
            binding.constraintMismatchSeverity,
          ),
          witness: {
            rawValue: String(candidate),
            codecValue: candidate,
            hypotheticalServerMinimum: integer.minimum,
          },
        });
      }
    } else {
      const string = schema as StringFieldSchema;
      const htmlMaxLength = stringAttribute(control, 'maxlength');
      const htmlMinLength = stringAttribute(control, 'minlength');
      if (string.maxLength !== undefined && htmlMaxLength !== null && htmlMaxLength > string.maxLength && string.pattern === undefined) {
        const raw = 'x'.repeat(string.maxLength + 1);
        witness({
          ...diagnosticError(
            'BC013',
            'known-constraint-witness',
            `${binding.actionId}/${name}/maxlength-witness`,
            'maxlength-witness',
            `native maxlength ${htmlMaxLength} permits ${raw.length} code points, which the selected contract rejects`,
            control.location,
            binding.constraintMismatchSeverity,
          ),
          witness: {
            rawValue: raw,
            codecValue: raw,
            unchangedHtmlMaximum: htmlMaxLength,
          },
        });
      }
      if (string.minLength !== undefined && htmlMinLength !== null && htmlMinLength < string.minLength && string.pattern === undefined) {
        const raw = 'x'.repeat(string.minLength - 1);
        witness({
          ...diagnosticError(
            'BC013',
            'known-constraint-witness',
            `${binding.actionId}/${name}/minlength-witness`,
            'minlength-witness',
            `native minlength ${htmlMinLength} permits ${raw.length} code points, which the selected contract rejects`,
            control.location,
            binding.constraintMismatchSeverity,
          ),
          witness: { rawValue: raw, codecValue: raw, unchangedHtmlMaximum: htmlMinLength },
        });
      }
    }
  }
  collector.cover({
    target: `${documentPath}#${binding.formId}`,
    ruleGroup: 'constraints',
    actualStatus: evaluated ? 'checked' : 'checked',
    evidenceRef: null,
    note: evaluated ? 'bounded concrete witness enumerated for known mirrored constraints' : 'no comparable HTML constraint witness was found',
  });
}

interface AnalyzeResult {
  report: DoctorReport;
}

async function analyzeLoaded(loaded: LoadedDoctorConfig): Promise<DoctorReport> {
  const collector = makeCollector();
  let documents = 0;
  let forms = 0;
  let totalBytes = 0;
  let bindings = 0;
  let paths = 0;
  for (const document of loaded.config.documents) {
    let html: string;
    try {
      html = await readConfiguredDocument(loaded, document);
    } catch (error) {
      throw error;
    }
    totalBytes += Buffer.byteLength(html, 'utf8');
    if (totalBytes > MAX_TOTAL_DOCUMENT_BYTES) {
      throw new DoctorConfigError('CONFIG_TOTAL_TOO_LARGE', `selected documents exceed ${MAX_TOTAL_DOCUMENT_BYTES} bytes in total`);
    }
    let parsed: ParsedDocument;
    try {
      parsed = parseHtmlDocument(html, document.documentUrl, document.path);
    } catch (error) {
      throw new DoctorConfigError('CONFIG_DOCUMENT_PARSE', error instanceof Error ? error.message : 'cannot parse document');
    }
    documents += 1;
    forms += parsed.forms.length;
    for (const binding of document.bindings) {
      bindings += 1;
      const formCandidates = parsed.formIds.get(binding.formId) ?? [];
      if (formCandidates.length === 0) {
        collector.add(
          diagnosticError(
            'BC014',
            'binding-missing',
            `${binding.actionId}/binding/form-missing`,
            'form-missing',
            `declared form id ${noteForName(binding.formId)} was not found in the selected snapshot`,
            null,
          ),
        );
        collector.cover({
          target: targetPath(document.path, binding),
          ruleGroup: 'binding',
          actualStatus: 'checked',
          evidenceRef: null,
          note: 'explicit binding cannot be resolved to a form',
        });
        continue;
      }
      if (formCandidates.length > 1) {
        collector.add(
          diagnosticError(
            'BC014',
            'binding-duplicate',
            `${binding.actionId}/binding/form-duplicate`,
            'form-duplicate',
            `declared form id ${noteForName(binding.formId)} matches more than one form in the selected snapshot`,
            formCandidates[1]?.location ?? null,
          ),
        );
        collector.cover({
          target: targetPath(document.path, binding),
          ruleGroup: 'binding',
          actualStatus: 'checked',
          evidenceRef: formCandidates[0]?.location ?? null,
          note: 'explicit binding is ambiguous because the form id is duplicated',
        });
        continue;
      }
      const form = formCandidates[0]!;
      const check = loaded.formChecks.get(binding.actionId);
      if (!check) {
        collector.add(
          diagnosticError(
            'BC014',
            'binding-missing',
            `${binding.actionId}/binding/action-missing`,
            'action-missing',
            `declared action id ${noteForName(binding.actionId)} has no form projection input`,
            form.location,
          ),
        );
        collector.cover({
          target: targetPath(document.path, binding),
          ruleGroup: 'binding',
          actualStatus: 'checked',
          evidenceRef: form.location,
          note: 'explicit binding references an action without a selected projection',
        });
        continue;
      }
      collector.cover({
        target: targetPath(document.path, binding),
        ruleGroup: 'binding',
        actualStatus: 'checked',
        evidenceRef: form.location,
        note: 'explicit form id and action id resolved to one form and one selected projection',
      });
      const nativeSubmitters = findSubmitters(form).filter(
        (control) => !(control.tagName === 'input' && control.type === 'image'),
      );
      const submitters: (ControlFact | null)[] =
        nativeSubmitters.length > 0 ? nativeSubmitters : canImplicitlySubmit(form) ? [null] : [];
      if (submitters.length === 0) {
        collector.add(
          diagnosticUnknown(
            'BC012',
            'unsupported-activation',
            `${binding.actionId}/native/activation-missing`,
            'no-native-activation',
            'form has no supported native submitter and no single-blocking-field implicit submission',
            form.location,
          ),
        );
        collector.cover({
          target: targetPath(document.path, binding),
          ruleGroup: 'target',
          actualStatus: 'unsupported',
          evidenceRef: form.location,
          note: 'no native activation could be enumerated',
        });
        continue;
      }
      for (const submitter of submitters) {
        paths += 1;
        const resolved = resolveEffectiveTarget(form, submitter);
        if (resolved.target === null) {
          const code = resolved.problem?.code ?? 'UNSUPPORTED_METHOD';
          collector.add(
            diagnosticUnknown(
              'BC012',
              'unsupported-transport',
              `${binding.actionId}/native/transport-${code}`,
              `unsupported-${code.toLowerCase()}`,
              resolved.problem?.message ?? 'native target cannot be analyzed by the form-only profile',
              submitter?.location ?? form.location,
            ),
          );
          collector.cover({
            target: targetPath(document.path, binding),
            ruleGroup: 'target',
            actualStatus: 'unsupported',
            evidenceRef: submitter?.location ?? form.location,
            note: `effective target could not be evaluated: ${code}`,
          });
          continue;
        }
        if (resolved.problem?.code === 'EXTERNAL_ORIGIN') {
          collector.add(
            diagnosticError(
              'BC011',
              'method-path-mismatch',
              `${binding.actionId}/native/target-external`,
              'external-origin',
              'effective action resolves outside the document origin',
              submitter?.location ?? form.location,
            ),
          );
          collector.cover({
            target: targetPath(document.path, binding),
            ruleGroup: 'target',
            actualStatus: 'checked',
            evidenceRef: submitter?.location ?? form.location,
            note: 'external origin recorded as a target defect',
          });
          continue;
        }
        compareTarget(
          collector,
          check,
          { url: resolved.target.url, method: resolved.target.method },
          document.path,
          binding.formId,
          submitter?.location ?? form.location,
        );
        const supply = checkSupply(
          collector,
          check,
          form,
          submitter,
          document.path,
          binding,
          submitter?.location ?? form.location,
        );
        checkConstraints(collector, check, supply.entries, document.path, binding);
      }
      collector.cover({
        target: targetPath(document.path, binding),
        ruleGroup: 'runtime-security',
        actualStatus: 'not-evaluated',
        evidenceRef: form.location,
        note: 'selected form projection does not establish CSRF, origin, session, authorization, or transaction behavior',
      });
      collector.cover({
        target: targetPath(document.path, binding),
        ruleGroup: 'bypass',
        actualStatus: 'not-evaluated',
        evidenceRef: null,
        note: 'application route graph and bypass scanning were not provided to the form-only Doctor',
      });
    }
  }
  const exitCode: DoctorReport['exitCode'] = collector.hasError() ? 1 : collector.isIncomplete() ? 3 : 0;
  return {
    format: 'boundary-doctor-report/0.1-draft',
    status: 'executed',
    productRun: true,
    configPath: loaded.configPath,
    scope: { documents, forms, bindings, paths, applicationCompleteness: 'not-evaluated' },
    findings: collector.findings,
    coverage: collector.coverage,
    exitCode,
  };
}

export async function runDoctor(configPath: string): Promise<DoctorReport> {
  try {
    const loaded = await loadDoctorConfig(configPath);
    return await analyzeLoaded(loaded);
  } catch (error) {
    if (error instanceof DoctorConfigError) return configErrorReport(configPath, error.message);
    return configErrorReport(configPath, error instanceof Error ? error.message : 'unexpected Doctor failure');
  }
}

export { configErrorReport };