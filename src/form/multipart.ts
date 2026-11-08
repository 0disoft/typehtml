import { make, defaultIsFile, type PartInfo, type MultipartError } from 'multipasta';
import { WireError, type FormEntry, type FormEntryPolicy, type FormReadLimits } from '../runtime/wire.ts';
import { captureUploadedFile, createTemporaryUploadStore, type TemporaryUpload, type TemporaryUploadStore, type UploadedFile } from './upload-storage.ts';
import { UPLOAD_LIMITS, type UploadFields } from './uploads.ts';

export const MULTIPART_HEADER_BYTES = 16_384;
export const DEFAULT_MULTIPART_LIMITS = Object.freeze({ maxBytes: 10 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024,
  maxTotalFileBytes: 8 * 1024 * 1024, maxFiles: UPLOAD_LIMITS.defaultMultipleCount, maxParts: 64, readTimeoutMs: 30_000 });
export type MultipartLimits = Readonly<{ [Key in keyof typeof DEFAULT_MULTIPART_LIMITS]: number }>;

export function prepareMultipartLimits(options: Partial<MultipartLimits> = {}): MultipartLimits {
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (options === null || ![null, Object.prototype].includes(Object.getPrototypeOf(options))) throw new TypeError('multipart limits must be plain data');
  const limits = { ...DEFAULT_MULTIPART_LIMITS } as Record<string, number>;
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as string]!;
    if (typeof key !== 'string' || !Object.hasOwn(limits, key) || !descriptor.enumerable || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value < (key === 'maxFiles' ? 0 : 1) || descriptor.value > 2_147_483_647) throw new TypeError('invalid multipart limit');
    limits[key] = descriptor.value;
  }
  if (limits.maxFileBytes! > limits.maxTotalFileBytes! || limits.maxTotalFileBytes! > limits.maxBytes! || limits.maxFiles! > limits.maxParts!) throw new TypeError('inconsistent multipart limits');
  return Object.freeze(limits) as MultipartLimits;
}

/** Header-only gate, before authentication or acquiring request storage. */
export function assertMultipartTransport(request: Request, limits: MultipartLimits): void {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.length > 256) throw new WireError(415, 'INVALID_MULTIPART_BOUNDARY');
  const parts = contentType.split(';').map((part) => part.trim());
  if (parts.shift()?.toLowerCase() !== 'multipart/form-data' || parts.length !== 1) throw new WireError(415, 'UNSUPPORTED_MEDIA_TYPE');
  const match = /^boundary=(?:"([A-Za-z0-9'()+_,./:=? -]{1,70})"|([A-Za-z0-9'+_.-]{1,70}))$/i.exec(parts[0]!);
  const boundary = match?.[1] ?? match?.[2];
  if (boundary === undefined || boundary.endsWith(' ')) throw new WireError(415, 'INVALID_MULTIPART_BOUNDARY');
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== '' && encoding !== 'identity') throw new WireError(415, 'UNSUPPORTED_CONTENT_ENCODING');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || BigInt(length) > BigInt(limits.maxBytes))) throw new WireError(413, 'BODY_TOO_LARGE');
}

export interface MultipartReadResult {
  readonly entries: readonly FormEntry[];
  readonly files: ReadonlyMap<string, readonly UploadedFile[]>;
  readonly dispose: () => Promise<void>;
}

/** Streaming parser and request-owned temporary storage; never writes a durable/public file. */
export async function readMultipartForm(request: Request, limits: MultipartLimits, text: FormReadLimits,
  policy: FormEntryPolicy, uploads: UploadFields, store: TemporaryUploadStore = createTemporaryUploadStore(),
): Promise<MultipartReadResult> {
  assertMultipartTransport(request, limits);
  if (request.body === null) throw new WireError(400, 'MISSING_MULTIPART_BODY');
  // Acquire before installing timers/listeners: an already-locked body throws synchronously.
  const reader = request.body.getReader();
  const owned: TemporaryUpload[] = [];
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    for (const upload of owned) try { await upload.dispose(); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(errors, 'temporary upload cleanup failed');
  };
  const controller = new AbortController();
  const abortRequest = () => controller.abort(new WireError(400, 'BODY_READ_ABORTED', 'BODY_READ_ABORTED', { cause: request.signal.reason }));
  request.signal.addEventListener('abort', abortRequest, { once: true });
  if (request.signal.aborted) abortRequest();
  const deadline = performance.now() + limits.readTimeoutMs;
  const timeout = setTimeout(() => controller.abort(new WireError(408, 'BODY_READ_TIMEOUT')), limits.readTimeoutMs);
  const signal = controller.signal;
  const active = () => {
    signal.throwIfAborted();
    if (performance.now() >= deadline) controller.abort(new WireError(408, 'BODY_READ_TIMEOUT'));
    signal.throwIfAborted();
  };
  const names = new Set([...policy.names, ...Object.keys(uploads), '_bc_csrf', '_bc_request']);
  const repeatable = new Set(policy.repeatable);
  const entries: FormEntry[] = [];
  const seen = new Set<string>();
  const files = new Map<string, UploadedFile[]>();
  let pending: Promise<void>[] = [];
  let totalFileBytes = 0;
  let fileCount = 0;
  let totalBytes = 0;
  let partCount = 0;
  // AbortController retains the first reason, including parser errors followed by onDone.
  const stop = (error: unknown) => { controller.abort(error); };
  const allowed = (name: string) => {
    active();
    if (!names.has(name) || name.includes('\0')) throw new WireError(400, 'UNKNOWN_FIELD');
    if (Buffer.byteLength(name) > text.maxKeyBytes) throw new WireError(413, 'KEY_TOO_LARGE');
    if (++partCount > text.maxEntries) throw new WireError(413, 'TOO_MANY_ENTRIES');
    if (partCount > limits.maxParts) throw new WireError(413, 'TOO_MANY_PARTS');
  };
  const parseError = (error: MultipartError): WireError => {
    if (error._tag === 'ReachedLimit') return new WireError(413, error.limit === 'MaxParts' ? 'TOO_MANY_PARTS' : error.limit === 'MaxFieldSize' ? 'VALUE_TOO_LARGE' : error.limit === 'MaxPartSize' ? 'FILE_TOO_LARGE' : 'BODY_TOO_LARGE');
    if (error._tag === 'BadHeaders' && ['HeaderTooLarge', 'TooManyHeaders'].includes(error.error.reason)) return new WireError(413, 'HEADERS_TOO_LARGE');
    return new WireError(400, 'INVALID_MULTIPART', 'INVALID_MULTIPART', { cause: error });
  };
  const inspect = (info: PartInfo): void => {
    for (const key of ['content-disposition', 'content-type', 'content-transfer-encoding']) if (Array.isArray(info.headers[key])) throw new WireError(400, 'DUPLICATE_PART_HEADER');
    const charset = info.contentTypeParameters.charset?.toLowerCase();
    if (charset !== undefined && charset !== 'utf-8' && charset !== 'utf8') throw new WireError(415, 'UNSUPPORTED_CHARSET');
    const encoding = info.headers['content-transfer-encoding'];
    if (typeof encoding === 'string' && !['7bit', '8bit', 'binary'].includes(encoding.toLowerCase())) throw new WireError(415, 'UNSUPPORTED_TRANSFER_ENCODING');
  };
  const storage = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
    try { return await operation(); }
    catch (cause) { active(); throw new UploadStorageError(cause); }
  };
  let ended = false;
  const abortRead = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', abortRead, { once: true });
  let rejectStopped: ((reason: unknown) => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  void stopped.catch(() => undefined);
  const rejectAbort = () => rejectStopped!(signal.reason);
  signal.addEventListener('abort', rejectAbort, { once: true });
  const flush = async () => {
    const work = pending; pending = [];
    await Promise.all(work);
    active();
  };
  try {
    active();
    let complete = false;
    const parser = make({ headers: { 'content-type': request.headers.get('content-type')! },
      // Parser part size includes headers; payload-specific counters below own the tighter limits.
      maxParts: limits.maxParts, maxTotalSize: limits.maxBytes, maxPartSize: limits.maxBytes, maxFieldSize: text.maxValueBytes,
      isFile(info) { inspect(info); return defaultIsFile(info); },
      onError: (error) => stop(parseError(error)),
      onDone: () => { complete = true; }, // Never clear an earlier error, even in the same chunk.
      onField(info, bytes) {
        allowed(info.name);
        if (Object.hasOwn(uploads, info.name)) throw new WireError(400, 'EXPECTED_FILE');
        let value: string;
        try { value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch (cause) { throw new WireError(400, 'INVALID_UTF8', 'INVALID_UTF8', { cause }); }
        if (value.includes('\0')) throw new WireError(400, 'NUL_NOT_ALLOWED');
        if (seen.has(info.name) && !repeatable.has(info.name)) throw new WireError(400, 'DUPLICATE_KEY');
        seen.add(info.name); entries.push(Object.freeze({ key: info.name, value }));
      },
      onFile(info) {
        const name = info.name;
        allowed(name);
        if (!Object.hasOwn(uploads, name)) throw new WireError(400, 'UNEXPECTED_FILE');
        const placeholder = info.filename === undefined || info.filename === '';
        if (!placeholder && ++fileCount > limits.maxFiles) throw new WireError(413, 'TOO_MANY_FILES');
        const selected = files.get(name) ?? [];
        if (!files.has(name)) files.set(name, selected);
        const index = selected.length;
        selected.push(undefined as unknown as UploadedFile);
        let size = 0;
        const metadata = Object.freeze({ field: name, name: info.filename ?? '', type: info.contentType });
        let upload: TemporaryUpload | undefined;
        let chain = Promise.resolve();
        const enqueue = (operation: () => Promise<void>) => {
          chain = chain.then(async () => { active(); await operation(); }).catch(stop);
          pending.push(chain);
        };
        if (!placeholder) enqueue(async () => { upload = await storage(() => store.open(metadata, signal)); owned.push(upload); });
        return (chunk) => {
          active();
          if (chunk === null) {
            if (!placeholder) enqueue(async () => { selected[index] = await storage(async () => captureUploadedFile(await upload!.finish(), metadata, size)); });
            return;
          }
          size += chunk.byteLength;
          totalFileBytes += chunk.byteLength;
          if (size > limits.maxFileBytes) throw new WireError(413, 'FILE_TOO_LARGE');
          if (totalFileBytes > limits.maxTotalFileBytes) throw new WireError(413, 'TOTAL_FILES_TOO_LARGE');
          if (placeholder && size > 0) throw new WireError(400, 'EMPTY_FILENAME_CONTENT');
          if (!placeholder) { const copy = chunk.slice(); enqueue(() => storage(() => upload!.write(copy, signal))); }
        };
      },
    });
    for (;;) {
      const next = await Promise.race([reader.read(), stopped]);
      active();
      if (next.done) { ended = true; break; }
      totalBytes += next.value.byteLength;
      if (totalBytes > limits.maxBytes) throw new WireError(413, 'BODY_TOO_LARGE');
      // Bound queued disk writes even when an upstream stream emits a huge chunk.
      for (let offset = 0; offset < next.value.length; offset += 4096) {
        parser.write(next.value.subarray(offset, offset + 4096));
        await flush();
      }
    }
    parser.end();
    await flush();
    if (!complete) throw new WireError(400, 'INVALID_MULTIPART');
    active();
    const captured = new Map<string, readonly UploadedFile[]>();
    for (const [name, selected] of files) captured.set(name, Object.freeze(selected.filter((file) => file !== undefined)));
    return Object.freeze({ entries: Object.freeze(entries), files: captured, dispose });
  } catch (error) {
    stop(error);
    await Promise.all(pending);
    try { await dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'multipart read and cleanup failed', { cause: error }); }
    if (signal.aborted && signal.reason instanceof WireError) throw signal.reason;
    if (error instanceof WireError) throw error;
    if (error instanceof UploadStorageError) throw error;
    throw new WireError(400, 'INVALID_MULTIPART', 'INVALID_MULTIPART', { cause: error });
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abortRequest);
    signal.removeEventListener('abort', abortRead);
    signal.removeEventListener('abort', rejectAbort);
    if (!ended) { try { void reader.cancel().catch(() => undefined); } catch { /* Preserve the primary failure. */ } }
    reader.releaseLock();
  }
}

export class UploadStorageError extends Error {
  constructor(cause: unknown) { super('temporary upload storage failed', { cause }); this.name = 'UploadStorageError'; }
}
