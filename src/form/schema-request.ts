import type { DefinedSchemaForm } from './schema-form.ts';
import { getPreparedFormTransport, decodeFormTransport, resolveTransportField } from './transport.ts';
import { readUrlEncodedEntries, WireError, type FormEntry } from '../runtime/wire.ts';
import { readMultipartForm } from './multipart.ts';
import { decodeUploadFields } from './uploads.ts';
import { cloneUploadInput, type TemporaryUploadStore, type UploadedFile } from './upload-storage.ts';
import { fieldPath } from './fields.ts';
import { validateStandard, standardIssuesToInputIssues, type InferStandardOutput } from './standard-schema.ts';
import type { BoundaryValidation, RawFormValues } from './boundary.ts';

function assignUpload(root: Record<string, unknown>, name: string, value: unknown): void {
  const path = fieldPath(name);
  let node: Record<string | number, unknown> = root;
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index]!;
    node[key] ??= typeof path[index + 1] === 'number' ? [] : Object.create(null);
    node = node[key] as Record<string | number, unknown>;
  }
  node[path.at(-1)!] = value;
}
function sparse(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value) && Object.keys(value).length !== value.length) return true;
  return Object.values(value).some(sparse);
}

/** Internal input-only path; it has no authorization or business-operation callbacks. */
export async function validateSchemaEntries<Form extends DefinedSchemaForm>(form: Form, entries: readonly FormEntry[], request: Pick<Request, 'signal'>,
  files: ReadonlyMap<string, readonly UploadedFile[]> = new Map(),
): Promise<BoundaryValidation<InferStandardOutput<Form['input']>>> {
  const transport = getPreparedFormTransport(form.fields, form.collections);
  // Fixed indexed text and file slots may fill different rows of one dense array.
  // Check actual holes only after both declared domains have been assembled.
  const decoded = decodeFormTransport(transport, entries, { deferSparseCheck: Object.keys(form.uploads).length > 0 });
  const uploads = decodeUploadFields(form.uploads, files);
  if (!decoded.validation.ok || uploads.issues.length > 0) return {
    ok: false, issues: Object.freeze([...(decoded.validation.ok ? [] : decoded.validation.issues), ...uploads.issues]),
    unknownKeys: decoded.validation.ok ? [] : decoded.validation.unknownKeys,
  };
  const value = Object.keys(form.uploads).length === 0 ? decoded.validation.value : cloneUploadInput(decoded.validation.value) as Record<string, unknown>;
  for (const [name, file] of Object.entries(uploads.value)) assignUpload(value as Record<string, unknown>, name, file);
  if (sparse(value)) return { ok: false, issues: [{ field: null, code: 'SPARSE_ARRAY', message: 'Indexed form values must be contiguous from zero' }], unknownKeys: [] };
  const result = await validateStandard(form.input, value, { signal: request.signal, timeoutMs: form.validationTimeoutMs,
    ...(Object.keys(form.uploads).length === 0 ? {} : { cloneInput: cloneUploadInput }),
  });
  if (result.issues === undefined) return { ok: true, value: result.value as InferStandardOutput<Form['input']> };
  const issues = standardIssuesToInputIssues(result.issues).map((issue) => {
    const field = issue.field;
    if (field !== null && (resolveTransportField(transport, field) !== null || Object.hasOwn(form.uploads, field))) return issue;
    for (let index = field?.lastIndexOf('[') ?? -1; index > 0; index = field!.lastIndexOf('[', index - 1)) {
      const array = field!.slice(0, index);
      if (resolveTransportField(transport, array)?.cardinality === 'repeated' || Object.hasOwn(form.uploads, array)) return { ...issue, field: array };
    }
    let parent = field ?? '';
    while (parent !== '') {
      const separator = Math.max(parent.lastIndexOf('.'), parent.lastIndexOf('['));
      if (separator < 0) break;
      parent = parent.slice(0, separator);
      if (Object.hasOwn(form.uploads, parent)) return { ...issue, field: parent };
    }
    return { ...issue, field: null };
  });
  return { ok: false, issues: Object.freeze(issues), unknownKeys: [] };
}

export async function readSchemaRequest<Form extends DefinedSchemaForm>(form: Form, request: Request, acceptRequestKey: boolean, store?: TemporaryUploadStore): Promise<Readonly<{
  csrf: string; raw: RawFormValues; requestKey?: string; dispose?: () => Promise<void>;
  validate: () => Promise<BoundaryValidation<InferStandardOutput<Form['input']>>>;
}>> {
  const transport = getPreparedFormTransport(form.fields, form.collections);
  const multipart = form.multipart === undefined ? undefined : await readMultipartForm(request, form.multipart, form.limits,
    { names: [...transport.names, ...Object.keys(form.uploads)], repeatable: transport.repeatable }, form.uploads, store);
  try {
    const entries = multipart?.entries ?? await readUrlEncodedEntries(request, form.limits, {}, transport);
    let csrf: string | undefined;
    let requestKey: string | undefined;
    const business: FormEntry[] = [];
    for (const entry of entries) {
      if (entry.key === '_bc_csrf') { csrf = entry.value; continue; }
      if (entry.key === '_bc_request' && acceptRequestKey) { requestKey = entry.value; continue; }
      if (entry.key.startsWith('_')) throw new WireError(400, entry.key === '_bc_request' ? 'UNEXPECTED_REQUEST_KEY' : entry.key.startsWith('_th_') ? 'LEGACY_PROTOCOL_KEY' : 'UNKNOWN_RESERVED_KEY');
      business.push(entry);
    }
    if (csrf === undefined) throw new WireError(400, 'MISSING_CSRF');
    if (acceptRequestKey && requestKey === undefined) throw new WireError(400, 'MISSING_REQUEST_KEY');
    if (requestKey !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(requestKey)) throw new WireError(400, 'INVALID_REQUEST_KEY');
    const raw: Record<string, string | readonly string[]> = Object.create(null);
    for (const entry of business) {
      const field = resolveTransportField(transport, entry.key);
      if (field === null) continue;
      if (field.cardinality === 'repeated') {
        const values = raw[entry.key] as string[] | undefined;
        if (values === undefined) raw[entry.key] = [entry.value]; else values.push(entry.value);
      } else raw[entry.key] = entry.value;
    }
    for (const value of Object.values(raw)) if (Array.isArray(value)) Object.freeze(value);
    return { csrf, raw: Object.freeze(raw), ...(requestKey === undefined ? {} : { requestKey }),
      ...(multipart === undefined ? {} : { dispose: multipart.dispose }),
      validate: () => validateSchemaEntries(form, business, request, multipart?.files),
    };
  } catch (error) {
    if (multipart !== undefined) try { await multipart.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'multipart protocol and cleanup failed', { cause: error }); }
    throw error;
  }
}
