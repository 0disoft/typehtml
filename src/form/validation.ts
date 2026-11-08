import { WireError, type FormEntry } from '../runtime/wire.ts';
import { fieldPath } from './fields.ts';
import type { DefinedSchemaForm } from './schema-form.ts';
import { validateSchemaEntries } from './schema-request.ts';
import type { InferStandardOutput } from './standard-schema.ts';
import type { BoundaryValidation } from './boundary.ts';

function wireBytes(value: string, limit: number, code: string): Uint8Array {
  if (value.length > limit) throw new WireError(413, code);
  if (value.includes('\u0000')) throw new WireError(400, 'NUL_NOT_ALLOWED');
  if (!value.isWellFormed()) throw new WireError(400, 'INVALID_UTF8');
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > limit) throw new WireError(413, code);
  return bytes;
}

/** URLSearchParams canonical encoding: space and *-._/alphanumerics take one byte, others three. */
function encodedLength(bytes: Uint8Array): number {
  let size = 0;
  for (const byte of bytes) size += byte === 32 || byte === 42 || byte === 45 || byte === 46 || byte === 95 ||
    byte >= 48 && byte <= 57 || byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 ? 1 : 3;
  return size;
}

/**
 * Validate decoded business entries only. No request, CSRF, authorization, endpoint, or operation is run.
 * Text/entry limits also bound this preview; maxBytes uses the canonical URL-encoded representation.
 * File data is not accepted: required uploads report issues until a real server request supplies them.
 */
export async function validateSchemaFormInput<Form extends DefinedSchemaForm>(
  form: Form, entries: readonly FormEntry[], options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<BoundaryValidation<InferStandardOutput<Form['input']>>> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  if (!Array.isArray(entries)) throw new TypeError('validation entries must be an array of string key/value pairs');
  if (entries.length > form.limits.maxEntries) throw new WireError(413, 'TOO_MANY_ENTRIES');
  const snapshot: FormEntry[] = [];
  let total = 0;
  for (const entry of entries) {
    signal.throwIfAborted();
    if (entry === null || typeof entry !== 'object' || typeof entry.key !== 'string' || typeof entry.value !== 'string') throw new TypeError('validation entries require string keys and values');
    const key = entry.key;
    const value = entry.value;
    const keyBytes = wireBytes(key, form.limits.maxKeyBytes, 'KEY_TOO_LARGE');
    const valueBytes = wireBytes(value, form.limits.maxValueBytes, 'VALUE_TOO_LARGE');
    try { fieldPath(key); } catch (cause) { throw new WireError(400, 'INVALID_KEY', 'validation accepts business field names only', { cause }); }
    const size = encodedLength(keyBytes) + encodedLength(valueBytes) + 1 + (snapshot.length === 0 ? 0 : 1);
    if (size > form.limits.maxBytes - total) throw new WireError(413, 'BODY_TOO_LARGE');
    total += size;
    snapshot.push(Object.freeze({ key, value }));
  }
  return validateSchemaEntries(form, Object.freeze(snapshot), { signal });
}
