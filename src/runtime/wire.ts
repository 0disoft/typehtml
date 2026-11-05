import type { HttpContract, ProtocolContract } from '../contract/types.ts';

/** HTTP status codes used by the wire layer. */
export type WireStatus = 400 | 413 | 415;

export class WireError extends Error {
  readonly status: WireStatus;
  readonly code: string;

  constructor(status: WireStatus, code: string, message = code) {
    super(message);
    this.name = 'WireError';
    this.status = status;
    this.code = code;
  }
}

export interface FormEntry {
  readonly key: string;
  readonly value: string;
}

export interface ParsedForm {
  readonly entries: readonly FormEntry[];
  /** Business fields only; protocol fields have been removed. */
  readonly fields: Readonly<Record<string, string>>;
  readonly csrf: string;
  readonly requestKey: string | null;
}

export interface FormReadOptions {
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly maxKeyBytes: number;
  readonly maxValueBytes: number;
  readonly csrfField: string;
  readonly requestKeyField: string;
  /** Set when the action belongs to an existing intent. */
  readonly expectRequestKey: boolean;
}

export function formReadOptions(
  http: HttpContract,
  protocol: ProtocolContract,
  expectRequestKey: boolean,
): FormReadOptions {
  return Object.freeze({
    maxBytes: http.maxBytes,
    maxEntries: http.maxEntries,
    maxKeyBytes: http.maxKeyBytes,
    maxValueBytes: http.maxValueBytes,
    csrfField: protocol.csrfField,
    requestKeyField: protocol.requestKeyField,
    expectRequestKey,
  });
}

const encoder = new TextEncoder();
const businessKey = /^[A-Za-z][A-Za-z0-9_]*$/;
const protocolKey = /^_[A-Za-z][A-Za-z0-9_]*$/;
const deniedKeys = new Set(['__proto__', 'constructor', 'prototype']);

function hex(byte: number): number {
  if (byte >= 48 && byte <= 57) return byte - 48;
  if (byte >= 65 && byte <= 70) return byte - 55;
  if (byte >= 97 && byte <= 102) return byte - 87;
  return -1;
}

function decodePart(bytes: Uint8Array): string {
  const out: number[] = [];
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!;
    if (byte === 37) {
      const high = bytes[index + 1];
      const low = bytes[index + 2];
      if (high === undefined || low === undefined || hex(high) < 0 || hex(low) < 0) {
        throw new WireError(400, 'INVALID_PERCENT');
      }
      out.push(hex(high) * 16 + hex(low));
      index += 2;
    } else {
      out.push(byte === 43 ? 32 : byte);
    }
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new Uint8Array(out));
  } catch {
    throw new WireError(400, 'INVALID_UTF8');
  }
  if (text.includes('\u0000')) throw new WireError(400, 'NUL_NOT_ALLOWED');
  return text;
}

function mediaType(request: Request): string {
  const raw = request.headers.get('content-type');
  if (raw === null) throw new WireError(415, 'UNSUPPORTED_MEDIA_TYPE');
  const parts = raw.split(';').map((part) => part.trim());
  const type = (parts.shift() ?? '').toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    throw new WireError(415, 'UNSUPPORTED_MEDIA_TYPE');
  }
  for (const parameter of parts) {
    if (parameter === '') continue;
    const separator = parameter.indexOf('=');
    if (separator < 0) throw new WireError(415, 'UNSUPPORTED_MEDIA_TYPE');
    const name = parameter.slice(0, separator).trim().toLowerCase();
    let value = parameter.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name === 'charset') {
      if (value.toLowerCase() !== 'utf-8') throw new WireError(415, 'UNSUPPORTED_CHARSET');
    } else {
      throw new WireError(415, 'UNSUPPORTED_MEDIA_TYPE');
    }
  }
  return type;
}

function contentEncoding(request: Request): void {
  const raw = request.headers.get('content-encoding');
  if (raw === null) return;
  const normalized = raw.trim().toLowerCase();
  if (normalized !== '' && normalized !== 'identity') {
    throw new WireError(415, 'UNSUPPORTED_CONTENT_ENCODING');
  }
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WireError(413, 'BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Bounded, strict URL-encoded parser for one already-validated request. */
export async function readUrlEncodedForm(
  request: Request,
  options: FormReadOptions,
): Promise<ParsedForm> {
  mediaType(request);
  contentEncoding(request);
  const bytes = await readBoundedBody(request, options.maxBytes);
  const entries: FormEntry[] = [];
  const seen = new Set<string>();
  let start = 0;
  for (let end = 0; end <= bytes.length; end++) {
    if (end < bytes.length && bytes[end] !== 38) continue;
    if (end > start) {
      if (entries.length >= options.maxEntries) throw new WireError(413, 'TOO_MANY_ENTRIES');
      let split = start;
      while (split < end && bytes[split] !== 61) split++;
      const key = decodePart(bytes.subarray(start, split));
      const value = decodePart(bytes.subarray(split < end ? split + 1 : end, end));
      if (deniedKeys.has(key) || decoderKeyProblem(key, options)) {
        throw new WireError(400, 'INVALID_KEY');
      }
      if (encoder.encode(key).length > options.maxKeyBytes) {
        throw new WireError(413, 'KEY_TOO_LARGE');
      }
      if (encoder.encode(value).length > options.maxValueBytes) {
        throw new WireError(413, 'VALUE_TOO_LARGE');
      }
      if (seen.has(key)) throw new WireError(400, 'DUPLICATE_KEY');
      seen.add(key);
      entries.push(Object.freeze({ key, value }));
    }
    start = end + 1;
  }

  let csrf: string | null = null;
  let requestKey: string | null = null;
  const fields: Record<string, string> = Object.create(null);
  for (const entry of entries) {
    if (entry.key === options.csrfField) {
      csrf = entry.value;
      continue;
    }
    if (entry.key === options.requestKeyField) {
      if (!options.expectRequestKey) throw new WireError(400, 'UNEXPECTED_REQUEST_KEY');
      requestKey = entry.value;
      continue;
    }
    if (protocolKey.test(entry.key)) {
      throw new WireError(400, entry.key.startsWith('_th_') ? 'LEGACY_PROTOCOL_KEY' : 'UNKNOWN_RESERVED_KEY');
    }
    if (!businessKey.test(entry.key)) throw new WireError(400, 'INVALID_KEY');
    fields[entry.key] = entry.value;
  }
  if (csrf === null) throw new WireError(400, 'MISSING_CSRF');
  if (options.expectRequestKey && requestKey === null) throw new WireError(400, 'MISSING_REQUEST_KEY');
  if (requestKey !== null && requestKey.length === 0) throw new WireError(400, 'INVALID_REQUEST_KEY');
  return Object.freeze({
    entries: Object.freeze(entries),
    fields: Object.freeze(fields),
    csrf,
    requestKey,
  });
}

function decoderKeyProblem(key: string, options: FormReadOptions): boolean {
  if (key === options.csrfField || key === options.requestKeyField) return false;
  if (protocolKey.test(key)) return false;
  return !businessKey.test(key);
}

/** Parses the only supported integer codec syntax: canonical decimal, no exponent, no leading zero. */
export function decimalInteger(raw: string): number {
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(raw)) throw new WireError(400, 'INVALID_INTEGER_SYNTAX');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new WireError(400, 'INTEGER_RANGE');
  return value;
}

/**
 * Canonical decoded-input form used for the input hash. Sorted keys and explicit
 * scalar type tags keep "1" and 1 distinct without relying on JSON number quirks.
 */
export function canonicalInput(input: Readonly<Record<string, string | number>>): string {
  const entries = Object.keys(input)
    .sort()
    .map((key) => {
      const value = input[key];
      if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
          throw new WireError(400, 'INVALID_DOMAIN_INTEGER');
        }
        return [key, 'integer', value];
      }
      if (typeof value !== 'string') throw new WireError(400, 'INVALID_DOMAIN_VALUE');
      if (
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(encoder.encode(value)) !== value
      ) {
        throw new WireError(400, 'INVALID_DOMAIN_UNICODE');
      }
      return [key, 'string', value];
    });
  return JSON.stringify(['bc-input/1', entries]);
}

/** Length units used by the design: strings are ranged by Unicode code points. */
export function lengthUnits(text: string): Readonly<{ codePoints: number; utf16: number; utf8: number }> {
  return { codePoints: [...text].length, utf16: text.length, utf8: encoder.encode(text).length };
}
