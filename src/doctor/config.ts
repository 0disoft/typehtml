import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { readStrictJson } from '../contract/strict-json.ts';
import { loadBoundaryContract, loadFormCheck } from '../contract/load.ts';
import { verifyFormCheckSource } from '../contract/project.ts';
import { FORM_FORMAT, loadForm, verifyFormSource } from '../form/index.ts';
import type { JsonObject, JsonValue } from '../contract/strict-json.ts';
import type { FormCheck } from '../contract/types.ts';
import type {
  DoctorBindingConfig,
  DoctorConfig,
  DoctorDocumentConfig,
  DoctorInputConfig,
  LoadedDoctorConfig,
  CoverageRow,
} from './types.ts';

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_DOCUMENT_BYTES = 100 * 1024 * 1024;

export class DoctorConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DoctorConfigError';
    this.code = code;
  }
}

function object(value: JsonValue | undefined, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DoctorConfigError('CONFIG_INVALID', `${path} must be an object`);
  }
  return value;
}

function array(value: JsonValue | undefined, path: string): JsonValue[] {
  if (!Array.isArray(value)) throw new DoctorConfigError('CONFIG_INVALID', `${path} must be an array`);
  return value;
}

function string(value: JsonValue | undefined, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DoctorConfigError('CONFIG_INVALID', `${path} must be a non-empty string`);
  }
  return value;
}

function boolean(value: JsonValue | undefined, path: string): boolean {
  if (typeof value !== 'boolean') throw new DoctorConfigError('CONFIG_INVALID', `${path} must be a boolean`);
  return value;
}

function severity(value: JsonValue | undefined, path: string): 'error' | 'warning' | 'info' {
  const text = string(value, path);
  if (text !== 'error' && text !== 'warning' && text !== 'info') {
    throw new DoctorConfigError('CONFIG_INVALID', `${path} must be error, warning, or info`);
  }
  return text;
}

function withinRoot(rootDir: string, candidate: string): string {
  const absoluteRoot = resolve(rootDir);
  const absolute = resolve(candidate);
  const rel = relative(absoluteRoot, absolute);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new DoctorConfigError('CONFIG_PATH_ESCAPE', 'configured path escapes the Doctor root');
  }
  return absolute;
}

const ALLOWED_RULE_GROUPS: readonly CoverageRow['ruleGroup'][] = ['binding', 'target', 'supply', 'cardinality', 'constraints', 'runtime-security', 'bypass'];
const DEFAULT_REQUIRED_RULE_GROUPS = ['binding', 'target', 'supply', 'cardinality'] as const;

function parseInputs(value: JsonValue | undefined): DoctorInputConfig[] {
  const inputs = array(value, '$.inputs').map((item, index): DoctorInputConfig => {
    const entry = object(item, `$.inputs[${index}]`);
    if (entry.kind !== 'form-projection') {
      throw new DoctorConfigError('CONFIG_INPUT_KIND', 'only form-projection inputs are supported');
    }
    return { kind: 'form-projection', path: string(entry.path, `$.inputs[${index}].path`) };
  });
  if (inputs.length === 0) throw new DoctorConfigError('CONFIG_INPUTS', 'at least one form projection is required');
  return inputs;
}

function parseBinding(item: JsonValue, path: string): DoctorBindingConfig {
  const value = object(item, path);
  const policy = string(value.submitterPolicy ?? 'enumerate-native', `${path}.submitterPolicy`);
  if (policy !== 'enumerate-native' && policy !== 'implicit-only') {
    throw new DoctorConfigError('CONFIG_SUBMITTER_POLICY', 'unsupported submitterPolicy');
  }
  return {
    formId: string(value.formId, `${path}.formId`),
    actionId: string(value.actionId, `${path}.actionId`),
    required: boolean(value.required ?? true, `${path}.required`),
    submitterPolicy: policy,
    constraintMismatchSeverity: severity(value.constraintMismatchSeverity ?? 'warning', `${path}.constraintMismatchSeverity`),
  };
}

function parseDocument(item: JsonValue, index: number): DoctorDocumentConfig {
  const path = `$.documents[${index}]`;
  const entry = object(item, path);
  const bindings = array(entry.bindings, `${path}.bindings`).map((binding, bindingIndex) => parseBinding(binding, `${path}.bindings[${bindingIndex}]`));
  const documentUrl = string(entry.documentUrl, `${path}.documentUrl`);
  try {
    const url = new URL(documentUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http');
  } catch {
    throw new DoctorConfigError('CONFIG_DOCUMENT_URL', `invalid documentUrl: ${documentUrl}`);
  }
  return {
    path: string(entry.path, `${path}.path`),
    documentUrl,
    sourceKind: string(entry.sourceKind, `${path}.sourceKind`),
    executionAssumption: string(entry.executionAssumption, `${path}.executionAssumption`),
    bindings,
  };
}

function parseDocuments(value: JsonValue | undefined): DoctorDocumentConfig[] {
  const documents = array(value, '$.documents').map(parseDocument);
  if (documents.length === 0) throw new DoctorConfigError('CONFIG_DOCUMENTS', 'at least one document is required');
  if (documents.every((document) => document.bindings.length === 0)) {
    throw new DoctorConfigError('CONFIG_ZERO_BINDINGS', 'explicit bindings are required');
  }
  return documents;
}

function parseAudit(value: JsonValue | undefined): Pick<DoctorConfig, 'releaseRequiresCompleteDeclaredBoundary' | 'releaseRequiredRuleGroups'> {
  const audit = value === undefined ? undefined : object(value, '$.audit');
  const requiredGroups = audit?.releaseRequiredRuleGroups === undefined
    ? [...DEFAULT_REQUIRED_RULE_GROUPS]
    : array(audit.releaseRequiredRuleGroups, '$.audit.releaseRequiredRuleGroups').map((item) => {
      const name = string(item, '$.audit.releaseRequiredRuleGroups[]');
      if (!ALLOWED_RULE_GROUPS.includes(name as CoverageRow['ruleGroup'])) throw new DoctorConfigError('CONFIG_RULE_GROUP', `unknown required rule group ${name}`);
      return name as CoverageRow['ruleGroup'];
    });
  return {
    releaseRequiresCompleteDeclaredBoundary: boolean(audit?.releaseRequiresCompleteDeclaredBoundary ?? true, '$.audit.releaseRequiresCompleteDeclaredBoundary'),
    releaseRequiredRuleGroups: requiredGroups,
  };
}

async function readProjection(baseDir: string, realBaseDir: string, input: DoctorInputConfig): Promise<FormCheck> {
  const lexicalPath = withinRoot(baseDir, resolve(baseDir, input.path));
  let path: string;
  try {
    path = await realpath(lexicalPath);
  } catch (error) {
    throw new DoctorConfigError('CONFIG_INPUT_UNREADABLE', error instanceof Error ? error.message : 'cannot read form projection');
  }
  withinRoot(realBaseDir, path);
  if ((await stat(path)).size > MAX_DOCUMENT_BYTES) throw new DoctorConfigError('CONFIG_INPUT_TOO_LARGE', 'form projection exceeds the file size limit');
  try {
    return (await loadFormCheck(path)).formCheck;
  } catch (error) {
    throw new DoctorConfigError('CONFIG_FORM_CHECK', error instanceof Error ? error.message : 'cannot load form projection');
  }
}

async function sourceIssue(baseDir: string, realBaseDir: string, check: FormCheck): Promise<string | null> {
  try {
    const sourcePath = withinRoot(baseDir, resolve(baseDir, check.source.path));
    const realSourcePath = await realpath(sourcePath);
    withinRoot(realBaseDir, realSourcePath);
    if ((await stat(realSourcePath)).size > MAX_DOCUMENT_BYTES) throw new Error('authoritative source exceeds the file size limit');
    const source = await readStrictJson(realSourcePath, { integerOnly: true });
    if (source !== null && typeof source === 'object' && !Array.isArray(source) && source.format === FORM_FORMAT) {
      verifyFormSource(check, await loadForm(realSourcePath));
    } else {
      verifyFormCheckSource(check, await loadBoundaryContract(realSourcePath));
    }
    return null;
  } catch (error) {
    if (error instanceof DoctorConfigError) throw error;
    return error instanceof Error ? error.message : 'authoritative source cannot be verified';
  }
}

async function loadProjections(baseDir: string, inputs: readonly DoctorInputConfig[]) {
  const formChecks = new Map<string, FormCheck>();
  const sourceIssues = new Map<string, string>();
  let realBaseDir: string;
  try {
    realBaseDir = await realpath(baseDir);
  } catch (error) {
    throw new DoctorConfigError('CONFIG_ROOT_UNREADABLE', error instanceof Error ? error.message : 'cannot read Doctor root');
  }
  for (const input of inputs) {
    const check = await readProjection(baseDir, realBaseDir, input);
    if (formChecks.has(check.action.id)) {
      throw new DoctorConfigError('CONFIG_DUPLICATE_ACTION', `duplicate form projection for ${check.action.id}`);
    }
    formChecks.set(check.action.id, check);
    const issue = await sourceIssue(baseDir, realBaseDir, check);
    if (issue !== null) sourceIssues.set(check.action.id, issue);
  }
  return { formChecks, sourceIssues };
}

export async function loadDoctorConfig(configPath: string): Promise<LoadedDoctorConfig> {
  const absoluteConfig = resolve(configPath);
  let value: JsonValue;
  try {
    value = await readStrictJson(absoluteConfig);
  } catch (error) {
    throw new DoctorConfigError('CONFIG_UNREADABLE', error instanceof Error ? error.message : 'cannot read Doctor config');
  }
  const root = object(value, '$');
  if (root.format !== 'boundary-doctor/0.5-draft') {
    throw new DoctorConfigError('CONFIG_FORMAT', 'unsupported Doctor config format');
  }
  const rootPath = string(root.root ?? '.', '$.root');
  const baseDir = resolve(rootPath);
  const inputs = parseInputs(root.inputs);
  const { formChecks, sourceIssues } = await loadProjections(baseDir, inputs);
  const documents = parseDocuments(root.documents);
  const audit = parseAudit(root.audit);
  const config: DoctorConfig = {
    format: 'boundary-doctor/0.5-draft',
    root: rootPath,
    inputs,
    documents,
    ...audit,
  };
  return { config, configPath: absoluteConfig, baseDir, formChecks, sourceIssues };
}

export async function readConfiguredDocument(loaded: LoadedDoctorConfig, document: DoctorDocumentConfig): Promise<string> {
  const lexicalPath = withinRoot(loaded.baseDir, resolve(loaded.baseDir, document.path));
  let path: string;
  try {
    path = await realpath(lexicalPath);
    withinRoot(await realpath(loaded.baseDir), path);
    const info = await stat(path);
    if (!info.isFile()) throw new DoctorConfigError('CONFIG_DOCUMENT_UNREADABLE', 'configured document is not a regular file');
    if (info.size > MAX_DOCUMENT_BYTES) {
      throw new DoctorConfigError('CONFIG_DOCUMENT_TOO_LARGE', `document exceeds ${MAX_DOCUMENT_BYTES} bytes`);
    }
    const handle = await open(path, 'r');
    try {
      const bytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const result = await handle.read(bytes, size, bytes.length - size, null);
        if (result.bytesRead === 0) break;
        size += result.bytesRead;
      }
      if (size > MAX_DOCUMENT_BYTES) throw new DoctorConfigError('CONFIG_DOCUMENT_TOO_LARGE', `document exceeds ${MAX_DOCUMENT_BYTES} bytes`);
      // Preserve a UTF-8 BOM in the decoded snapshot so re-encoding hashes the original bytes.
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof DoctorConfigError) throw error;
    throw new DoctorConfigError('CONFIG_DOCUMENT_UNREADABLE', error instanceof Error ? error.message : 'cannot read document');
  }
}
