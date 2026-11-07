import { mkdir, open, realpath, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DEFAULT_MAX_BYTES, decodeStrictJson, readBoundedJsonBytes, StrictJsonError } from '../contract/strict-json.ts';
import { defineForm, FORM_FORMAT, type FormDefinition } from '../form/definition.ts';
import { createFormCatalog, renderFormCatalog, serializeFormCatalog, CATALOG_FORMAT, CATALOG_LIMITS } from './index.ts';

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }

async function readSource(path: string, remaining: number): Promise<Uint8Array> {
  try { return await readBoundedJsonBytes(path, Math.min(DEFAULT_MAX_BYTES, remaining)); }
  catch (error) {
    if (remaining < DEFAULT_MAX_BYTES && error instanceof StrictJsonError && error.code === 'JSON_TOO_LARGE') {
      throw new TypeError('catalog source byte limit exceeded', { cause: error });
    }
    throw error;
  }
}

/** Static manifests are read as bounded JSON. No imported application module or server is run. */
export async function writeFormCatalog(options: Readonly<{ configPath: string; directory: string }>): Promise<Readonly<{
  format: typeof CATALOG_FORMAT; status: 'written'; files: readonly string[]; forms: number;
}>> {
  const configPath = await realpath(resolve(options.configPath));
  const configBytes = await readSource(configPath, CATALOG_LIMITS.maxSourceBytes);
  const config = decodeStrictJson(configBytes);
  if (config === null || typeof config !== 'object' || Array.isArray(config) || config.format !== CATALOG_FORMAT
    || Object.keys(config).some((key) => !['format', 'title', 'forms'].includes(key))
    || !Array.isArray(config.forms) || config.forms.length === 0 || config.forms.length > CATALOG_LIMITS.maxForms
    || config.forms.some((path) => typeof path !== 'string' || path.length === 0)
    || (config.title !== undefined && typeof config.title !== 'string')) throw new TypeError('invalid catalog config');
  const root = dirname(configPath);
  const sourcePaths: string[] = [configPath];
  const seenPaths = new Set<string>();
  const ids = new Set<string>();
  const routes = new Set<string>();
  let sourceBytes = configBytes.byteLength;
  const forms = [];
  for (const path of config.forms as string[]) {
    if (sourceBytes >= CATALOG_LIMITS.maxSourceBytes) throw new TypeError('catalog source byte limit exceeded');
    const sourcePath = await realpath(resolve(root, path));
    if (!contained(root, sourcePath)) throw new TypeError('catalog manifest must be within the config directory');
    if (seenPaths.has(sourcePath)) throw new TypeError('duplicate catalog manifest');
    seenPaths.add(sourcePath);
    const bytes = await readSource(sourcePath, CATALOG_LIMITS.maxSourceBytes - sourceBytes);
    sourceBytes += bytes.byteLength;
    const value = decodeStrictJson(bytes, { integerOnly: true });
    if (value === null || typeof value !== 'object' || Array.isArray(value) || value.format !== FORM_FORMAT) {
      throw new TypeError(`expected a ${FORM_FORMAT} manifest`);
    }
    const form = defineForm(value as unknown as FormDefinition);
    if (ids.has(form.id) || routes.has(form.path)) throw new TypeError('duplicate catalog form ID or route');
    ids.add(form.id); routes.add(form.path);
    sourcePaths.push(sourcePath);
    forms.push(form);
  }
  const catalog = createFormCatalog(forms, { title: config.title as string | undefined });
  const files = new Map([['catalog.json', serializeFormCatalog(catalog)], ['index.html', renderFormCatalog(catalog)]]);
  const requested = resolve(options.directory);
  const parent = await realpath(dirname(requested));
  const output = resolve(parent, basename(requested));
  const segments = output.replaceAll('\\', '/').toLowerCase().split('/');
  if (segments.some((segment, index) => segment === 'docs' && segments[index + 1] === 'design')) throw new TypeError('design snapshots are immutable');
  if (sourcePaths.some((path) => contained(output, path))) throw new TypeError('catalog sources must be outside output');
  // A fresh directory never replaces user files or an existing design snapshot, including symlinks.
  await mkdir(output);
  const created: string[] = [];
  try {
    for (const [name, content] of files) {
      const path = resolve(output, name);
      const file = await open(path, 'wx');
      created.push(path);
      try { await file.writeFile(content); } finally { await file.close(); }
    }
    return { format: CATALOG_FORMAT, status: 'written', forms: forms.length, files: [...files.keys()].map((name) => resolve(output, name)) };
  } catch (error) {
    // Only files successfully created by this invocation are candidates for cleanup.
    for (const path of created) {
      try { await rm(path); } catch (cleanupError) { if (!missing(cleanupError)) throw new AggregateError([error, cleanupError], 'catalog write and cleanup failed'); }
    }
    try { await rmdir(output); } catch (cleanupError) { if (!missing(cleanupError)) throw new AggregateError([error, cleanupError], 'catalog write and cleanup failed'); }
    throw error;
  }
}
