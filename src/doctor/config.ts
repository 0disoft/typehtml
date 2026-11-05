import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { readStrictJson } from '../contract/strict-json.ts';
import { loadFormCheck } from '../contract/load.ts';
import type { JsonObject, JsonValue } from '../contract/strict-json.ts';
import type { FormCheck } from '../contract/types.ts';
import type {
  DoctorBindingConfig,
  DoctorConfig,
  DoctorDocumentConfig,
  DoctorInputConfig,
  LoadedDoctorConfig,
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
  const inputs = array(root.inputs, '$.inputs').map((item, index): DoctorInputConfig => {
    const entry = object(item, `$.inputs[${index}]`);
    if (entry.kind !== 'form-projection') {
      throw new DoctorConfigError('CONFIG_INPUT_KIND', 'only form-projection inputs are supported');
    }
    return { kind: 'form-projection', path: string(entry.path, `$.inputs[${index}].path`) };
  });
  if (inputs.length === 0) throw new DoctorConfigError('CONFIG_INPUTS', 'at least one form projection is required');
  const formChecks = new Map<string, FormCheck>();
  let realBaseDir: string;
  try {
    realBaseDir = await realpath(baseDir);
  } catch (error) {
    throw new DoctorConfigError('CONFIG_ROOT_UNREADABLE', error instanceof Error ? error.message : 'cannot read Doctor root');
  }
  for (const input of inputs) {
    const lexicalPath = withinRoot(baseDir, resolve(baseDir, input.path));
    let path: string;
    try {
      path = await realpath(lexicalPath);
    } catch (error) {
      throw new DoctorConfigError('CONFIG_INPUT_UNREADABLE', error instanceof Error ? error.message : 'cannot read form projection');
    }
    withinRoot(realBaseDir, path);
    let loaded;
    try {
      loaded = await loadFormCheck(path);
    } catch (error) {
      throw new DoctorConfigError('CONFIG_FORM_CHECK', error instanceof Error ? error.message : 'cannot load form projection');
    }
    if (formChecks.has(loaded.formCheck.action.id)) {
      throw new DoctorConfigError('CONFIG_DUPLICATE_ACTION', `duplicate form projection for ${loaded.formCheck.action.id}`);
    }
    formChecks.set(loaded.formCheck.action.id, loaded.formCheck);
  }
  const documents = array(root.documents, '$.documents').map((item, index): DoctorDocumentConfig => {
    const entry = object(item, `$.documents[${index}]`);
    const bindings = array(entry.bindings, `$.documents[${index}].bindings`).map((binding, bindingIndex): DoctorBindingConfig => {
      const value = object(binding, `$.documents[${index}].bindings[${bindingIndex}]`);
      const policy = string(value.submitterPolicy ?? 'enumerate-native', `$.documents[${index}].bindings[${bindingIndex}].submitterPolicy`);
      if (policy !== 'enumerate-native' && policy !== 'implicit-only') {
        throw new DoctorConfigError('CONFIG_SUBMITTER_POLICY', 'unsupported submitterPolicy');
      }
      return {
        formId: string(value.formId, `$.documents[${index}].bindings[${bindingIndex}].formId`),
        actionId: string(value.actionId, `$.documents[${index}].bindings[${bindingIndex}].actionId`),
        required: boolean(value.required ?? true, `$.documents[${index}].bindings[${bindingIndex}].required`),
        submitterPolicy: policy,
        constraintMismatchSeverity: severity(
          value.constraintMismatchSeverity ?? 'warning',
          `$.documents[${index}].bindings[${bindingIndex}].constraintMismatchSeverity`,
        ),
      };
    });
    const documentUrl = string(entry.documentUrl, `$.documents[${index}].documentUrl`);
    try {
      const url = new URL(documentUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http');
    } catch {
      throw new DoctorConfigError('CONFIG_DOCUMENT_URL', `invalid documentUrl: ${documentUrl}`);
    }
    return {
      path: string(entry.path, `$.documents[${index}].path`),
      documentUrl,
      sourceKind: string(entry.sourceKind, `$.documents[${index}].sourceKind`),
      executionAssumption: string(entry.executionAssumption, `$.documents[${index}].executionAssumption`),
      bindings,
    };
  });
  if (documents.length === 0) throw new DoctorConfigError('CONFIG_DOCUMENTS', 'at least one document is required');
  if (documents.every((document) => document.bindings.length === 0)) {
    throw new DoctorConfigError('CONFIG_ZERO_BINDINGS', 'explicit bindings are required');
  }
  const config: DoctorConfig = {
    format: 'boundary-doctor/0.5-draft',
    root: rootPath,
    inputs,
    documents,
  };
  return { config, configPath: absoluteConfig, baseDir, formChecks };
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
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof DoctorConfigError) throw error;
    throw new DoctorConfigError('CONFIG_DOCUMENT_UNREADABLE', error instanceof Error ? error.message : 'cannot read document');
  }
}