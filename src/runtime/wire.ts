import type { HttpContract, ProtocolContract } from '../contract/types.ts';

/** HTTP status codes used by the wire layer. */
export type WireStatus = 400 | 408 | 413 | 415;

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

export interface FormReadLimits {
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly maxKeyBytes: number;
  readonly maxValueBytes: number;
  readonly readTimeoutMs?: number;
}

export interface FormReadOptions extends FormReadLimits {
  readonly csrfField: string;
  readonly requestKeyField: string;
  /** Set when the action belongs to an existing intent. */
  readonly expectRequestKey: boolean;
}

export interface FormBodyReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

/** Optional transport dependencies; existing callers keep the platform defaults. */
export interface FormReadRuntime {
  /** Monotonic milliseconds, like performance.now(). */
  readonly now?: () => number;
  /** Schedule asynchronously and return a function that cancels that callback. */
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => () => void;
  readonly openReader?: (request: Request) => FormBodyReader | null;
  /** Additional cancellation; the request's own signal is always respected. */
  readonly signal?: AbortSignal;
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
      if (value.toLowerCase() !== 'utf-8') throw new WireError(400, 'UNSUPPORTED_CHARSET');
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

/** Header-only checks run before authentication and before acquiring a body reader. */
export function assertFormTransport(request: Request, maxBytes: number): void {
  mediaType(request);
  contentEncoding(request);
  const length = request.headers.get('content-length');
  if (length !== null) {
    if (!/^[0-9]+$/.test(length)) throw new WireError(400, 'INVALID_CONTENT_LENGTH');
    if (BigInt(length) > BigInt(maxBytes)) throw new WireError(413, 'BODY_TOO_LARGE');
  }
}

async function readBoundedBody(request: Request, options: FormReadLimits, runtime: FormReadRuntime): Promise<Uint8Array> {
  const timeoutMs = options.readTimeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('INVALID_BODY_READ_TIMEOUT');
  }
  const signals = runtime.signal === undefined || runtime.signal === request.signal
    ? [request.signal] : [request.signal, runtime.signal];
  const assertNotAborted = () => {
    if (signals.some((signal) => signal.aborted)) throw new WireError(400, 'BODY_READ_ABORTED');
  };
  assertNotAborted();
  const now = runtime.now ?? (() => performance.now());
  const scheduleTimeout = runtime.scheduleTimeout ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  });
  let lastTime = -Infinity;
  const clock = () => {
    const measured = now();
    if (!Number.isFinite(measured) || measured < 0 || measured < lastTime) throw new Error('INVALID_BODY_READ_CLOCK');
    return lastTime = measured;
  };
  const startedAt = clock();
  const remaining = () => timeoutMs - (clock() - startedAt);
  let reader: FormBodyReader | null;
  try { reader = runtime.openReader === undefined ? request.body?.getReader() ?? null : runtime.openReader(request); }
  catch { throw new WireError(400, 'BODY_READ_FAILED'); }
  if (reader === null) {
    assertNotAborted();
    if (remaining() <= 0) throw new WireError(408, 'BODY_READ_TIMEOUT');
    return new Uint8Array(0);
  }
  let body = new Uint8Array(0);
  let total = 0;
  let rejectRead: ((error: unknown) => void) | undefined;
  let stoppedError: { error: unknown } | undefined;
  const stop = (error: unknown) => {
    if (stoppedError === undefined) { stoppedError = { error }; rejectRead?.(error); }
  };
  const abort = () => stop(new WireError(400, 'BODY_READ_ABORTED'));
  const assertActive = () => {
    assertNotAborted();
    if (stoppedError !== undefined) throw stoppedError.error;
    if (remaining() <= 0) throw new WireError(408, 'BODY_READ_TIMEOUT');
  };
  let cancelTimer: (() => void) | undefined;
  const armTimeout = () => {
    const delay = remaining();
    if (delay <= 0) { stop(new WireError(408, 'BODY_READ_TIMEOUT')); return; }
    // Node clamps larger delays to 1ms. Re-arm long waits against the same deadline.
    cancelTimer = scheduleTimeout(() => {
      cancelTimer = undefined;
      try { armTimeout(); } catch (error) { stop(error); }
    }, Math.min(2_147_483_647, Math.max(1, Math.ceil(delay))));
  };
  try {
    for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
    assertActive();
    armTimeout();
    for (;;) {
      assertActive();
      let reading: ReturnType<FormBodyReader['read']>;
      try { reading = reader.read(); } catch { throw new WireError(400, 'BODY_READ_FAILED'); }
      let result: Awaited<ReturnType<FormBodyReader['read']>>;
      try {
        // Keep only the current read's cancellation callback.
        result = await new Promise<Awaited<ReturnType<FormBodyReader['read']>>>((resolve, reject) => {
          rejectRead = reject;
          reading.then(resolve, () => reject(new WireError(400, 'BODY_READ_FAILED')));
          if (stoppedError !== undefined) reject(stoppedError.error);
        });
      } finally { rejectRead = undefined; }
      // Check cancellation and deadlines even when the read was already fulfilled.
      assertActive();
      const { done, value } = result;
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      const nextTotal = total + value.byteLength;
      if (nextTotal > options.maxBytes) {
        throw new WireError(413, 'BODY_TOO_LARGE');
      }
      if (nextTotal > body.byteLength) {
        const expanded = new Uint8Array(Math.min(options.maxBytes, Math.max(nextTotal, body.byteLength * 2)));
        expanded.set(body.subarray(0, total));
        body = expanded;
      }
      // Copy now: a transport may reuse its buffer on the next read.
      body.set(value, total);
      total = nextTotal;
    }
  } catch (error) {
    try { void reader.cancel().catch(() => undefined); } catch { /* Preserve the read failure. */ }
    throw error;
  } finally {
    try { cancelTimer?.(); } catch { /* Cleanup must not replace the result. */ }
    for (const signal of signals) signal.removeEventListener('abort', abort);
    try { reader.releaseLock(); } catch { /* Preserve the result if the transport already failed. */ }
  }
  return body.subarray(0, total);
}

/** Shared bounded transport parser; route-specific allowlists and protocol checks follow. */
export async function readUrlEncodedEntries(
  request: Request,
  options: FormReadLimits,
  runtime: FormReadRuntime = {},
): Promise<readonly FormEntry[]> {
  assertFormTransport(request, options.maxBytes);
  const bytes = await readBoundedBody(request, options, runtime);
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
      if (deniedKeys.has(key) || (!businessKey.test(key) && !protocolKey.test(key))) {
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

  return Object.freeze(entries);
}

/** Bounded, strict URL-encoded parser for one already-validated request. */
export async function readUrlEncodedForm(request: Request, options: FormReadOptions, runtime: FormReadRuntime = {}): Promise<ParsedForm> {
  const entries = await readUrlEncodedEntries(request, options, runtime);
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
