import type { FormCheck } from '../contract/types.ts';
import { sourceSha256 } from '../contract/behavior.ts';
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
  SubmissionFact,
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
  scope(required: boolean, activation: string, target?: string): void;
  truncated(): boolean;
  completeBoundary(): void;
}

function makeCollector(loaded: LoadedDoctorConfig): Collector {
  const findings: Diagnostic[] = [];
  const byKey = new Map<string, number>();
  const coverage: CoverageRow[] = [];
  const coverageKeys = new Map<string, number>();
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
      const activations = [...new Set(coverage.filter((row) => row.target === scopedTarget && row.activation !== 'binding').map((row) => row.activation!))];
      for (const group of loaded.config.releaseRequiredRuleGroups) {
        const scopes = ['binding', 'runtime-security', 'bypass'].includes(group) ? ['binding'] : activations.length > 0 ? activations : ['binding'];
        for (const path of scopes) {
          if (!coverage.some((row) => row.target === scopedTarget && row.ruleGroup === group && row.activation === path)) coverage.push({
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
      const key = `${row.target}|${row.ruleGroup}|${activation}`;
      const scoped = { ...row, activation, requiredBoundary };
      const index = coverageKeys.get(key);
      if (index !== undefined) {
        if (statusRank(row.actualStatus) > statusRank(coverage[index]!.actualStatus)) coverage[index] = scoped;
        return;
      }
      coverageKeys.set(key, coverage.length);
      coverage.push(scoped);
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

function configErrorReport(configPath: string, message: string): DoctorReport {
  return {
    format: 'boundary-doctor-report/0.1-draft',
    status: 'configuration-error',
    productRun: false,
    configPath,
    scope: { documents: 0, forms: 0, bindings: 0, paths: 0, applicationCompleteness: 'not-evaluated' },
    findings: [],
    coverage: [],
    submissions: [],
    findingsTruncated: false,
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
  if (target.url.search !== '') {
    collector.add(
      diagnosticError(
        'BC011',
        'method-path-mismatch',
        `${cause}/query`,
        'query-not-in-contract',
        'native action carries a query that the contract path does not define',
        location,
      ),
    );
    ok = false;
  }
  if (target.url.hash !== '') collector.add(diagnosticError('BC011', 'method-path-mismatch', `${cause}/fragment`, 'fragment-not-in-request', 'action fragment is preserved as URL evidence but is not sent in the HTTP request path', location, 'warning'));
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
  let checked = collection.unsupportedControls.length === 0 && !form.hasDynamicControls;
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
    if (collection.unsupportedNames.has(name) || form.hasDynamicControls) {
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
  if (form.hasDynamicControls) {
    collector.add(diagnosticUnknown('BC012', 'unsupported-control', `${causeBase}/custom-element`, 'unsupported-custom-element', 'custom elements may provide entries outside the native-form/1 control model', form.location));
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

function checkConstraints(
  collector: Collector,
  check: FormCheck,
  collection: ReturnType<typeof collectFormEntries>,
  documentPath: string,
  binding: { formId: string; actionId: string; constraintMismatchSeverity: Severity },
  skipValidation: boolean,
): void {
  let compared = false;
  let incomplete = false;
  for (const [name, schema] of Object.entries(check.input.schema.properties)) {
    const entry = collection.entries.find((candidate) => candidate.name === name);
    if (!entry) continue;
    const control = entry.control;
    // The witness proves native acceptance, not just a difference between attributes.
    if (skipValidation || control.readonly || control.tagName !== 'input') {
      incomplete = true;
      continue;
    }
    const pattern = attribute(control.element, 'pattern');
    const knownTextPattern = control.type === 'text' && pattern === '([1-9]|1[0-9]|20)';
    if (schema.type !== 'integer' || (control.type !== 'number' && !knownTextPattern)) {
      incomplete = true;
      continue;
    }
    compared = true;
    const numberAttribute = (key: string): number | null => {
      const raw = attribute(control.element, key);
      if (raw === null || raw.trim() === '' || !/^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(raw)) return null;
      const number = Number(raw);
      return Number.isFinite(number) ? number : null;
    };
    const htmlMin = control.type === 'number' ? numberAttribute('min') : null;
    const htmlMax = control.type === 'number' ? numberAttribute('max') : null;
    const rawStep = attribute(control.element, 'step');
    const numberStep = numberAttribute('step');
    const step = rawStep?.toLowerCase() === 'any' ? null : numberStep !== null && numberStep > 0 ? numberStep : 1;
    const base = htmlMin ?? numberAttribute('value') ?? 0;
    const accepts = (candidate: number) => {
      if (!Number.isSafeInteger(candidate) || (htmlMin !== null && candidate < htmlMin) || (htmlMax !== null && candidate > htmlMax)) return false;
      if (knownTextPattern) {
        const raw = String(candidate);
        const minimumLength = numberAttribute('minlength');
        const maximumLength = numberAttribute('maxlength');
        return /^(?:[1-9]|1[0-9]|20)$/.test(raw) && (minimumLength === null || raw.length >= minimumLength) && (maximumLength === null || raw.length <= maximumLength);
      }
      if (step === null) return true;
      const quotient = (candidate - base) / step;
      return Math.abs(quotient - Math.round(quotient)) < 1e-9;
    };
    const limits = [
      { kind: 'max', server: schema.maximum, candidate: schema.maximum === undefined ? undefined : schema.maximum + 1, html: htmlMax },
      { kind: 'min', server: schema.minimum, candidate: schema.minimum === undefined ? undefined : schema.minimum - 1, html: htmlMin },
    ] as const;
    for (const limit of limits) {
      if (limit.candidate === undefined || limit.server === undefined || !accepts(limit.candidate)) continue;
      collector.add({
        ...diagnosticError('BC013', 'known-constraint-witness', `${binding.actionId}/${name}/${limit.kind}-witness`, `${limit.kind}-witness`, `native ${control.type} control permits ${limit.candidate}, which the selected contract rejects`, control.location, binding.constraintMismatchSeverity),
        witness: {
          rawValue: String(limit.candidate), codecValue: limit.candidate,
          ...(limit.kind === 'max' ? { hypotheticalServerMaximum: limit.server } : { hypotheticalServerMinimum: limit.server }),
          ...(limit.kind === 'max' && limit.html !== null ? { unchangedHtmlMaximum: limit.html } : {}),
        },
      });
    }
  }
  collector.cover({
    target: `${documentPath}#${binding.formId}`,
    ruleGroup: 'constraints',
    actualStatus: incomplete || !compared ? 'unknown' : 'checked',
    evidenceRef: null,
    note: compared ? 'bounded integer witnesses checked against native min/max/step or the known ASCII integer pattern; this is not equivalence proof' : 'no supported native integer constraint comparison; other constraint semantics remain unknown',
  });
}
async function analyzeLoaded(loaded: LoadedDoctorConfig): Promise<DoctorReport> {
  const collector = makeCollector(loaded);
  const submissions: SubmissionFact[] = [];
  const executionErrors: string[] = [];
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
      executionErrors.push(`${document.path}: ${error instanceof Error ? error.message : 'cannot read selected document'}`);
      continue;
    }
    totalBytes += Buffer.byteLength(html, 'utf8');
    if (totalBytes > MAX_TOTAL_DOCUMENT_BYTES) {
      executionErrors.push(`selected documents exceed ${MAX_TOTAL_DOCUMENT_BYTES} bytes in total`);
      break;
    }
    let parsed: ParsedDocument;
    try {
      parsed = parseHtmlDocument(html, document.documentUrl, document.path);
    } catch (error) {
      executionErrors.push(`${document.path}: ${error instanceof Error ? error.message : 'cannot parse selected document'}`);
      continue;
    }
    const artifactHash = sourceSha256(Buffer.from(html, 'utf8'));
    let currentHash: string;
    try { currentHash = sourceSha256(Buffer.from(await readConfiguredDocument(loaded, document), 'utf8')); }
    catch (error) { executionErrors.push(`${document.path}: ${error instanceof Error ? error.message : 'cannot reread selected document'}`); continue; }
    if (artifactHash !== currentHash) {
      for (const binding of document.bindings) {
        collector.scope(binding.required, 'binding', targetPath(document.path, binding));
        collector.add(diagnosticUnknown('BC193', 'stale-source', `${document.path}/${binding.formId}/changed`, 'source-changed', 'document changed while it was being parsed; its facts were discarded', null));
        collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'binding', actualStatus: 'unknown', evidenceRef: null, note: 'source changed during analysis' });
      }
      continue;
    }
    documents += 1;
    forms += parsed.forms.length;
    for (const binding of document.bindings) {
      collector.scope(binding.required, 'binding', targetPath(document.path, binding));
      bindings += 1;
      const formCandidates = parsed.formIds.get(binding.formId) ?? [];
      if (formCandidates.length === 0) {
        if (!binding.required) {
          collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'binding', actualStatus: 'checked', evidenceRef: null, note: 'optional declared form is absent from this selected snapshot' });
          continue;
        }
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
      if (formCandidates.length > 1 || parsed.duplicateIds.has(binding.formId)) {
        collector.add(
          diagnosticError(
            'BC014',
            'binding-duplicate',
            `${binding.actionId}/binding/form-duplicate`,
            'form-duplicate',
            `declared form id ${noteForName(binding.formId)} is duplicated in the selected snapshot`,
            formCandidates[1]?.location ?? formCandidates[0]?.location ?? null,
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
      const sourceIssue = loaded.sourceIssues.get(binding.actionId);
      if (sourceIssue) {
        collector.add(diagnosticUnknown('BC193', 'stale-projection', `${document.path}/${binding.formId}/projection`, 'stale-projection', `selected form projection cannot be verified against its authoritative source: ${sourceIssue}`, form.location));
        collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'binding', actualStatus: 'unknown', evidenceRef: form.location, note: 'source bytes, behavior digest, and exact projection must agree before connection checks' });
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
      const defaultSubmitter = form.controls.find((control) => (control.tagName === 'button' && control.type === 'submit') || (control.tagName === 'input' && ['submit', 'image'].includes(control.type)));
      const implicitSubmitters: (ControlFact | null)[] = defaultSubmitter
        ? defaultSubmitter.disabled || defaultSubmitter.type === 'image' ? [] : [defaultSubmitter]
        : canImplicitlySubmit(form) ? [null] : [];
      const submitters: (ControlFact | null)[] = binding.submitterPolicy === 'implicit-only'
        ? implicitSubmitters
        : nativeSubmitters.length > 0 ? nativeSubmitters : implicitSubmitters;
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
        const activation = submitter ? `submitter@${submitter.location.offset}` : 'implicit-without-button';
        collector.scope(binding.required, activation);
        paths += 1;
        const resolved = resolveEffectiveTarget(form, submitter);
        const collection = collectFormEntries(form, submitter);
        submissions.push({
          artifact: { path: document.path, sha256: artifactHash, sourceKind: document.sourceKind },
          intendedAction: check.action, formId: binding.formId, formLocation: form.location,
          context: { documentUrl: document.documentUrl, baseUrl: parsed.baseUrl, executionAssumption: document.executionAssumption, hasScript: parsed.hasScript },
          activation, submitterLocation: submitter?.location ?? null,
          rawAction: attribute(form.element, 'action'), rawSubmitterAction: submitter ? attribute(submitter.element, 'formaction') : null,
          effectiveTarget: resolved.target ? { url: resolved.target.url.href, method: resolved.target.method, encoding: resolved.target.encoding, skipValidation: resolved.target.skipValidation } : null,
          fields: [...collection.possibleCounts].map(([name, possibleCount]) => ({ name, possibleCount, locations: collection.entries.filter((entry) => entry.name === name).map((entry) => entry.control.location) })),
        });
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
        if (resolved.target.url.origin !== new URL(document.documentUrl).origin) {
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
        }
        compareTarget(collector, check, { url: resolved.target.url, method: resolved.target.method }, document.path, binding.formId, submitter?.location ?? form.location);
        if (resolved.problem?.code === 'UNSUPPORTED_ENCODING' || resolved.problem?.code === 'UNSUPPORTED_METHOD') {
          collector.add(diagnosticUnknown('BC012', 'unsupported-transport', `${binding.actionId}/native/${resolved.problem.code}`, `unsupported-${resolved.problem.code.toLowerCase()}`, resolved.problem.message, submitter?.location ?? form.location));
          collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'target', actualStatus: 'unsupported', evidenceRef: submitter?.location ?? form.location, note: resolved.problem.message });
          continue;
        }
        const supply = checkSupply(
          collector,
          check,
          form,
          submitter,
          document.path,
          binding,
          submitter?.location ?? form.location,
        );
        checkConstraints(collector, check, supply.entries, document.path, binding, resolved.target.skipValidation);
      }
      collector.scope(binding.required, 'binding');
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
  for (const document of loaded.config.documents) for (const binding of document.bindings) {
    collector.scope(binding.required, 'binding', targetPath(document.path, binding));
    collector.completeBoundary();
  }
  const exitCode: DoctorReport['exitCode'] = executionErrors.length > 0 ? 2 : collector.hasError() ? 1 : collector.isIncomplete() ? 3 : 0;
  return {
    format: 'boundary-doctor-report/0.1-draft',
    status: executionErrors.length > 0 ? 'configuration-error' : 'executed',
    productRun: true,
    configPath: loaded.configPath,
    scope: { documents, forms, bindings, paths, applicationCompleteness: 'not-evaluated' },
    findings: collector.findings,
    coverage: collector.coverage,
    submissions,
    findingsTruncated: collector.truncated(),
    exitCode,
    ...(executionErrors.length > 0 ? { error: executionErrors.join('\n') } : {}),
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
