import { makeCollector, type Collector } from './collector.ts';
import { AnalysisBudget, type AnalysisLimits } from './budget.ts';
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
import type { CollectionResult, ControlFact, EffectiveTarget, FormFact, ParsedDocument, TargetResult } from './html.ts';
import { DoctorConfigError, loadDoctorConfig, readConfiguredDocument, MAX_TOTAL_DOCUMENT_BYTES } from './config.ts';
import type { DoctorBindingConfig, DoctorDocumentConfig, LoadedDoctorConfig } from './types.ts';
import type {
  Diagnostic,
  DoctorReport,
  Severity,
  SourceLocation,
  SubmissionFact,
} from './types.ts';
import { diagnosticError, diagnosticUnknown } from './types.ts';
import { acceptsNativeInteger, nativeIntegerLimits, readNativeIntegerConstraints, selectNativeIntegerControl } from './constraints.ts';
import type { NativeIntegerControl, NativeIntegerLimit } from './constraints.ts';
import { indexEntries, type IndexedEntries } from './entries.ts';

const DOCTOR_EXIT = { success: 0, defect: 1, executionError: 2, incomplete: 3 } as const;

function targetPath(documentPath: string, binding: { formId: string }): string {
  return `${documentPath}#${binding.formId}`;
}

function fieldLocation(control: ControlFact | undefined): SourceLocation | null {
  return control?.location ?? null;
}

function noteForName(name: string): string {
  return JSON.stringify(name);
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
    exitCode: DOCTOR_EXIT.executionError,
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
  collection: CollectionResult,
  entriesByName: ReadonlyMap<string, IndexedEntries>,
  documentPath: string,
  binding: { formId: string; actionId: string },
  location: SourceLocation,
): SupplyResult {
  const properties = new Set(Object.keys(check.input.schema.properties));
  const protocol = new Set(check.protocolFields);
  const allowed = new Set([...properties, ...protocol]);
  const required = new Set([...check.input.schema.required, ...check.protocolFields]);
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
          fieldLocation(entriesByName.get(name)?.first.control),
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
    if (entriesByName.has(name)) continue;
    if (collection.unsupportedNames.has(name) || form.hasDynamicControls) {
      checked = false;
      collector.add(
        diagnosticUnknown(
          'BC010',
          'missing-required-field',
          `${causeBase}/${name}/supply-unknown`,
          'required-supply-unknown',
          `required field ${noteForName(name)} may be supplied by an unsupported control`,
          fieldLocation(entriesByName.get(name)?.first.control),
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
  entriesByName: ReadonlyMap<string, IndexedEntries>,
  documentPath: string,
  binding: { formId: string; actionId: string; constraintMismatchSeverity: Severity },
  skipValidation: boolean,
): void {
  let compared = false;
  let incomplete = false;
  for (const [name, schema] of Object.entries(check.input.schema.properties)) {
    const entry = entriesByName.get(name)?.first;
    if (!entry) continue;
    const native = selectNativeIntegerControl(schema, entry.control, skipValidation);
    if (native === null) { incomplete = true; continue; }
    compared = true;
    emitConstraintWitnesses(collector, check, binding, name, native);
  }
  collector.cover({
    target: `${documentPath}#${binding.formId}`,
    ruleGroup: 'constraints',
    actualStatus: incomplete || !compared ? 'unknown' : 'checked',
    evidenceRef: null,
    note: compared ? 'bounded integer witnesses checked against native min/max/step or the known ASCII integer pattern; this is not equivalence proof' : 'no supported native integer constraint comparison; other constraint semantics remain unknown',
  });
}

function emitConstraintWitnesses(
  collector: Collector, check: FormCheck,
  binding: { actionId: string; constraintMismatchSeverity: Severity }, name: string, native: NativeIntegerControl,
): void {
  const constraints = readNativeIntegerConstraints(native);
  for (const limit of nativeIntegerLimits(native.schema, constraints)) {
    const { candidate, server } = limit;
    if (candidate === undefined || server === undefined || !acceptsNativeInteger(candidate, constraints)) continue;
    collector.add(constraintWitness(check, binding, name, native.control, { ...limit, candidate, server }));
  }
}

/** Calculate one public witness record without changing the schema, control, or collector. */
function constraintWitness(
  check: FormCheck, binding: { actionId: string; constraintMismatchSeverity: Severity }, name: string, control: ControlFact,
  limit: NativeIntegerLimit & { readonly candidate: number; readonly server: number },
): Diagnostic {
  return {
    ...diagnosticError('BC013', 'known-constraint-witness', `${binding.actionId}/${name}/${limit.kind}-witness`, `${limit.kind}-witness`, `native ${control.type} control permits ${limit.candidate}, which the selected contract rejects`, control.location, binding.constraintMismatchSeverity),
    witness: {
      rawValue: String(limit.candidate), codecValue: limit.candidate,
      codec: 'decimal-integer',
      schemaPointer: `/input/schema/properties/${name.replace(/~/g, '~0').replace(/\//g, '~1')}/${limit.kind === 'max' ? 'maximum' : 'minimum'}`,
      source: check.source,
      synthetic: true,
      nativeValidation: 'enabled-for-selected-activation',
      ...(limit.kind === 'max' ? { hypotheticalServerMaximum: limit.server } : { hypotheticalServerMinimum: limit.server }),
      ...(limit.kind === 'max' && limit.html !== null ? { unchangedHtmlMaximum: limit.html } : {}),
    },
  };
}

interface AnalysisState {
  readonly collector: Collector;
  readonly budget: AnalysisBudget;
  readonly submissions: SubmissionFact[];
  readonly executionErrors: string[];
  totalBytes: number;
  documents: number;
  forms: number;
  bindings: number;
  paths: number;
}

type DocumentSnapshot = Readonly<{
  document: DoctorDocumentConfig;
  parsed: ParsedDocument;
  artifactHash: string;
}>;

type BoundForm = Readonly<{
  snapshot: DocumentSnapshot;
  binding: DoctorBindingConfig;
  form: FormFact;
  check: FormCheck;
}>;

async function analyzeLoaded(loaded: LoadedDoctorConfig, limits: Partial<AnalysisLimits>): Promise<DoctorReport> {
  const state: AnalysisState = {
    collector: makeCollector(loaded), budget: new AnalysisBudget(limits), submissions: [], executionErrors: [],
    totalBytes: 0, documents: 0, forms: 0, bindings: 0, paths: 0,
  };
  for (const document of loaded.config.documents) {
    if (state.budget.exhausted) break;
    const snapshot = await readStableDocument(loaded, document, state);
    if (snapshot === 'budget-exceeded') break;
    if (snapshot === null) continue;
    state.documents += 1;
    state.forms += snapshot.parsed.forms.length;
    for (const binding of document.bindings) {
      if (state.budget.exhausted) break;
      state.collector.scope(binding.required, 'binding', targetPath(document.path, binding));
      state.bindings += 1;
      analyzeBinding(loaded, snapshot, binding, state);
    }
  }
  return completeReport(loaded, state);
}

async function readStableDocument(
  loaded: LoadedDoctorConfig, document: DoctorDocumentConfig, state: AnalysisState,
): Promise<DocumentSnapshot | 'budget-exceeded' | null> {
  let html: string;
  try { html = await readConfiguredDocument(loaded, document); }
  catch (error) {
    state.executionErrors.push(`${document.path}: ${error instanceof Error ? error.message : 'cannot read selected document'}`);
    return null;
  }
  state.totalBytes += Buffer.byteLength(html, 'utf8');
  if (state.totalBytes > MAX_TOTAL_DOCUMENT_BYTES) {
    state.executionErrors.push(`selected documents exceed ${MAX_TOTAL_DOCUMENT_BYTES} bytes in total`);
    return 'budget-exceeded';
  }
  let parsed: ParsedDocument;
  try { parsed = parseHtmlDocument(html, document.documentUrl, document.path); }
  catch (error) {
    state.executionErrors.push(`${document.path}: ${error instanceof Error ? error.message : 'cannot parse selected document'}`);
    return null;
  }
  const artifactHash = sourceSha256(Buffer.from(html, 'utf8'));
  let currentHash: string;
  try { currentHash = sourceSha256(Buffer.from(await readConfiguredDocument(loaded, document), 'utf8')); }
  catch (error) {
    state.executionErrors.push(`${document.path}: ${error instanceof Error ? error.message : 'cannot reread selected document'}`);
    return null;
  }
  if (artifactHash !== currentHash) {
    recordChangedDocument(state.collector, document);
    return null;
  }
  return { document, parsed, artifactHash };
}

function recordChangedDocument(collector: Collector, document: DoctorDocumentConfig): void {
  for (const binding of document.bindings) {
    collector.scope(binding.required, 'binding', targetPath(document.path, binding));
    collector.add(diagnosticUnknown('BC193', 'stale-source', `${document.path}/${binding.formId}/changed`, 'source-changed', 'document changed while it was being parsed; its facts were discarded', null));
    collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'binding', actualStatus: 'unknown', evidenceRef: null, note: 'source changed during analysis' });
  }
}

function resolveBinding(
  loaded: LoadedDoctorConfig, snapshot: DocumentSnapshot, binding: DoctorBindingConfig, collector: Collector,
): BoundForm | null {
  const { document, parsed } = snapshot;
  const candidates = parsed.formIds.get(binding.formId) ?? [];
  if (candidates.length === 0) {
    recordAbsentForm(collector, document.path, binding);
    return null;
  }
  if (candidates.length > 1 || parsed.duplicateIds.has(binding.formId)) {
    collector.add(diagnosticError('BC014', 'binding-duplicate', `${binding.actionId}/binding/form-duplicate`, 'form-duplicate',
      `declared form id ${noteForName(binding.formId)} is duplicated in the selected snapshot`, candidates[1]?.location ?? candidates[0]?.location ?? null));
    collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'binding', actualStatus: 'checked',
      evidenceRef: candidates[0]?.location ?? null, note: 'explicit binding is ambiguous because the form id is duplicated' });
    return null;
  }
  const form = candidates[0]!;
  const check = loaded.formChecks.get(binding.actionId);
  if (!check) {
    collector.add(diagnosticError('BC014', 'binding-missing', `${binding.actionId}/binding/action-missing`, 'action-missing',
      `declared action id ${noteForName(binding.actionId)} has no form projection input`, form.location));
    collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'binding', actualStatus: 'checked',
      evidenceRef: form.location, note: 'explicit binding references an action without a selected projection' });
    return null;
  }
  const sourceIssue = loaded.sourceIssues.get(binding.actionId);
  if (sourceIssue) {
    collector.add(diagnosticUnknown('BC193', 'stale-projection', `${document.path}/${binding.formId}/projection`, 'stale-projection', `selected form projection cannot be verified against its authoritative source: ${sourceIssue}`, form.location));
    collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'binding', actualStatus: 'unknown', evidenceRef: form.location, note: 'source bytes, behavior digest, and exact projection must agree before connection checks' });
    return null;
  }
  collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'binding', actualStatus: 'checked',
    evidenceRef: form.location, note: 'explicit form id and action id resolved to one form and one selected projection' });
  return { snapshot, binding, form, check };
}

function recordAbsentForm(collector: Collector, documentPath: string, binding: DoctorBindingConfig): void {
  if (!binding.required) {
    collector.cover({ target: targetPath(documentPath, binding), ruleGroup: 'binding', actualStatus: 'checked', evidenceRef: null,
      note: 'optional declared form is absent from this selected snapshot' });
    return;
  }
  collector.add(diagnosticError('BC014', 'binding-missing', `${binding.actionId}/binding/form-missing`, 'form-missing',
    `declared form id ${noteForName(binding.formId)} was not found in the selected snapshot`, null));
  collector.cover({ target: targetPath(documentPath, binding), ruleGroup: 'binding', actualStatus: 'checked', evidenceRef: null,
    note: 'explicit binding cannot be resolved to a form' });
}

function selectNativeActivations(form: FormFact, policy: DoctorBindingConfig['submitterPolicy']): (ControlFact | null)[] {
  const native = findSubmitters(form).filter((control) => !(control.tagName === 'input' && control.type === 'image'));
  const implicit = implicitActivations(form);
  if (policy === 'implicit-only') return implicit;
  return native.length > 0 ? native : implicit;
}

/** The first default submitter remains authoritative even when disabled or an image. */
function implicitActivations(form: FormFact): (ControlFact | null)[] {
  const defaultSubmitter = form.controls.find((control) =>
    (control.tagName === 'button' && control.type === 'submit') || (control.tagName === 'input' && ['submit', 'image'].includes(control.type)));
  if (defaultSubmitter) {
    if (defaultSubmitter.disabled || defaultSubmitter.type === 'image') return [];
    return [defaultSubmitter];
  }
  if (canImplicitlySubmit(form)) return [null];
  return [];
}

function analyzeBinding(loaded: LoadedDoctorConfig, snapshot: DocumentSnapshot, binding: DoctorBindingConfig, state: AnalysisState): void {
  const { collector } = state;
  const bound = resolveBinding(loaded, snapshot, binding, collector);
  if (bound === null) return;
  const { form } = bound;
  const { document } = snapshot;
  const submitters = selectNativeActivations(form, binding.submitterPolicy);
  if (submitters.length === 0) {
    collector.add(diagnosticUnknown('BC012', 'unsupported-activation', `${binding.actionId}/native/activation-missing`, 'no-native-activation',
      'form has no supported native submitter and no single-blocking-field implicit submission', form.location));
    collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'target', actualStatus: 'unsupported',
      evidenceRef: form.location, note: 'no native activation could be enumerated' });
    return;
  }
  for (const submitter of submitters) {
    if (!state.budget.beginPath(form.controls.length)) {
      recordAnalysisLimit(state, bound);
      break;
    }
    const activation = submitter ? `submitter@${submitter.location.offset}` : 'implicit-without-button';
    collector.scope(binding.required, activation);
    state.paths += 1;
    if (!analyzeActivation(state, bound, submitter, activation)) {
      recordAnalysisLimit(state, bound);
      break;
    }
  }
  collector.scope(binding.required, 'binding');
  collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'runtime-security', actualStatus: 'not-evaluated',
    evidenceRef: form.location, note: 'selected form projection does not establish CSRF, origin, session, authorization, or transaction behavior' });
  collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'bypass', actualStatus: 'not-evaluated', evidenceRef: null,
    note: 'application route graph and bypass scanning were not provided to the form-only Doctor' });
}

function recordAnalysisLimit(state: AnalysisState, bound: BoundForm): void {
  const { binding, snapshot: { document }, form } = bound;
  state.collector.scope(binding.required, 'binding');
  state.collector.add(diagnosticUnknown('BC012', 'analysis-budget', `${document.path}/${binding.formId}/analysis-budget`,
    'analysis-budget-exceeded', `analysis stopped at ${state.budget.reason}; remaining native paths were not evaluated`, form.location));
  state.collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'binding', actualStatus: 'not-evaluated',
    evidenceRef: form.location, note: 'analysis resource limit was reached; this boundary is incomplete' });
}

function analyzeActivation(state: AnalysisState, bound: BoundForm, submitter: ControlFact | null, activation: string): boolean {
  const { collector, submissions } = state;
  const { snapshot: { document }, binding, form, check } = bound;
  const location = submitter?.location ?? form.location;
  const resolved = resolveEffectiveTarget(form, submitter);
  const target = analyzeTarget(collector, bound, location, resolved);
  const collection = collectFormEntries(form, submitter);
  const entriesByName = indexEntries(collection.entries);
  const fact = submissionFact(bound, submitter, activation, resolved, collection, entriesByName);
  if (!state.budget.acceptSubmission(fact)) return false;
  submissions.push(fact);
  if (target === null) return true;
  checkSupply(collector, check, form, collection, entriesByName, document.path, binding, location);
  checkConstraints(collector, check, entriesByName, document.path, binding, target.skipValidation);
  return true;
}

/** Evidence size limits must not discard target diagnostics that were already resolved. */
function analyzeTarget(collector: Collector, bound: BoundForm, location: SourceLocation, resolved: TargetResult): EffectiveTarget | null {
  const { snapshot: { document }, binding, check } = bound;
  if (resolved.target === null) {
    recordUnsupportedTarget(collector, bound, location, resolved);
    return null;
  }
  if (resolved.target.url.origin !== new URL(document.documentUrl).origin) {
    collector.add(diagnosticError('BC011', 'method-path-mismatch', `${binding.actionId}/native/target-external`, 'external-origin',
      'effective action resolves outside the document origin', location));
    collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'target', actualStatus: 'checked', evidenceRef: location,
      note: 'external origin recorded as a target defect' });
  }
  compareTarget(collector, check, { url: resolved.target.url, method: resolved.target.method }, document.path, binding.formId, location);
  if (resolved.problem?.code === 'UNSUPPORTED_ENCODING' || resolved.problem?.code === 'UNSUPPORTED_METHOD') {
    collector.add(diagnosticUnknown('BC012', 'unsupported-transport', `${binding.actionId}/native/${resolved.problem.code}`, `unsupported-${resolved.problem.code.toLowerCase()}`, resolved.problem.message, location));
    collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'target', actualStatus: 'unsupported', evidenceRef: location, note: resolved.problem.message });
    return null;
  }
  return resolved.target;
}

/** New provenance records keep parsed controls and configured bindings unchanged. */
function submissionFact(
  bound: BoundForm, submitter: ControlFact | null, activation: string, resolved: TargetResult, collection: CollectionResult,
  entriesByName: ReadonlyMap<string, IndexedEntries>,
): SubmissionFact {
  const { snapshot: { document, parsed, artifactHash }, binding, form, check } = bound;
  return {
    artifact: { path: document.path, sha256: artifactHash, sourceKind: document.sourceKind },
    intendedAction: check.action, projectionSource: check.source, formId: binding.formId, formLocation: form.location,
    context: { documentUrl: document.documentUrl, baseUrl: parsed.baseUrl, executionAssumption: document.executionAssumption, hasScript: parsed.hasScript },
    activation, submitterLocation: submitter?.location ?? null,
    rawAction: attribute(form.element, 'action'), rawSubmitterAction: submitter ? attribute(submitter.element, 'formaction') : null,
    effectiveTarget: resolved.target ? { url: resolved.target.url.href, method: resolved.target.method, encoding: resolved.target.encoding, skipValidation: resolved.target.skipValidation } : null,
    fields: [...collection.possibleCounts].map(([name, possibleCount]) => ({ name, possibleCount, locations: entriesByName.get(name)!.locations })),
  };
}

function recordUnsupportedTarget(collector: Collector, bound: BoundForm, location: SourceLocation, resolved: TargetResult): void {
  const { snapshot: { document }, binding } = bound;
  const code = resolved.problem?.code ?? 'UNSUPPORTED_METHOD';
  collector.add(diagnosticUnknown('BC012', 'unsupported-transport', `${binding.actionId}/native/transport-${code}`, `unsupported-${code.toLowerCase()}`,
    resolved.problem?.message ?? 'native target cannot be analyzed by the form-only profile', location));
  collector.cover({ target: targetPath(document.path, binding), ruleGroup: 'target', actualStatus: 'unsupported', evidenceRef: location,
    note: `effective target could not be evaluated: ${code}` });
}

function completeReport(loaded: LoadedDoctorConfig, state: AnalysisState): DoctorReport {
  const { collector, submissions, executionErrors, documents, forms, bindings, paths } = state;
  for (const document of loaded.config.documents) for (const binding of document.bindings) {
    collector.scope(binding.required, 'binding', targetPath(document.path, binding));
    collector.completeBoundary();
  }
  const exitCode = executionErrors.length > 0 ? DOCTOR_EXIT.executionError
    : collector.hasError() ? DOCTOR_EXIT.defect : state.budget.exhausted || collector.isIncomplete() ? DOCTOR_EXIT.incomplete : DOCTOR_EXIT.success;
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
    ...(state.budget.exhausted ? { analysisTruncated: true } : {}),
    exitCode,
    ...(executionErrors.length > 0 ? { error: executionErrors.join('\n') } : {}),
  };
}

export async function runDoctor(configPath: string, limits: Partial<AnalysisLimits> = {}): Promise<DoctorReport> {
  try {
    const selectedLimits: Partial<AnalysisLimits> = Object.fromEntries(Object.entries(limits));
    const loaded = await loadDoctorConfig(configPath);
    return await analyzeLoaded(loaded, selectedLimits);
  } catch (error) {
    if (error instanceof DoctorConfigError) return configErrorReport(configPath, error.message);
    return configErrorReport(configPath, error instanceof Error ? error.message : 'unexpected Doctor failure');
  }
}

export { configErrorReport };
