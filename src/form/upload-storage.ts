import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';

export interface UploadMetadata {
  readonly field: string;
  /** Untrusted display metadata, never a filesystem path. */
  readonly name: string;
  /** Untrusted client declaration, not a content inspection result. */
  readonly type: string;
}
export interface UploadedFile extends UploadMetadata {
  readonly kind: 'typehtml-upload/1';
  readonly size: number;
  /** Valid only while the handler is running. Await any durable copy inside execute. */
  readonly stream: () => ReadableStream<Uint8Array>;
}
export interface TemporaryUpload {
  readonly write: (bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
  readonly finish: () => Promise<UploadedFile>;
  readonly dispose: () => Promise<void>;
}
export interface TemporaryUploadStore {
  /** Must create private temporary storage, never a permanent/public destination. */
  readonly open: (metadata: UploadMetadata, signal: AbortSignal) => Promise<TemporaryUpload>;
}

const ownedUploads = new WeakSet<object>();
/** Mark a host temporary-store result without granting capabilities to request data. */
export function captureUploadedFile(file: UploadedFile, metadata: UploadMetadata, size: number): UploadedFile {
  if (file === null || typeof file !== 'object' || typeof file.stream !== 'function') throw new TypeError('temporary store must return an upload stream capability');
  const stream = file.stream;
  const captured: UploadedFile = Object.freeze({ ...metadata, kind: 'typehtml-upload/1', size,
    stream: () => Reflect.apply(stream, file, []),
  });
  ownedUploads.add(captured);
  return captured;
}

/** Clone decoded data while retaining immutable, request-owned file capabilities. */
export function cloneUploadInput(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && ownedUploads.has(value)) return value;
  if (Array.isArray(value)) return value.map(cloneUploadInput);
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) copy[key] = cloneUploadInput(item);
    return copy;
  }
  return structuredClone(value);
}

/** Node/Bun disk storage: memory use is bounded by stream buffers, not upload size. */
export function createTemporaryUploadStore(options: Readonly<{ directory?: string }> = {}): TemporaryUploadStore {
  const parent = resolve(options.directory ?? tmpdir());
  return Object.freeze({ async open(metadata: UploadMetadata, signal: AbortSignal): Promise<TemporaryUpload> {
    signal.throwIfAborted();
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'typehtml-upload-'));
    try {
      const path = join(directory, 'body');
      const file = await open(path, 'wx', 0o600);
      let size = 0;
      let closed = false;
      let disposed = false;
      const readers = new Set<ReturnType<typeof createReadStream>>();
      const close = async () => { if (!closed) { await file.close(); closed = true; } };
      return Object.freeze({
        async write(bytes: Uint8Array, active: AbortSignal) {
          active.throwIfAborted();
          if (closed || disposed) throw new Error('temporary upload is closed');
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
            if (bytesWritten === 0) throw new Error('temporary upload write made no progress');
            offset += bytesWritten;
            active.throwIfAborted();
          }
          size += bytes.length;
        },
        async finish() {
          if (disposed) throw new Error('temporary upload was disposed');
          await close();
          return Object.freeze({ ...metadata, kind: 'typehtml-upload/1' as const, size,
            stream() {
              if (disposed) throw new Error('upload is outside its request lifetime');
              const reader = createReadStream(path);
              readers.add(reader);
              reader.once('close', () => readers.delete(reader));
              // Node's node:stream/web and DOM declarations differ in their overloads.
              return Readable.toWeb(reader) as unknown as ReadableStream<Uint8Array>;
            },
          });
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          for (const reader of readers) reader.destroy();
          const errors: unknown[] = [];
          try { await close(); } catch (error) { errors.push(error); }
          try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); } catch (error) { errors.push(error); }
          if (errors.length > 0) throw new AggregateError(errors, 'temporary upload cleanup failed');
        },
      });
    } catch (error) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'temporary upload acquisition and cleanup failed', { cause: error }); }
      throw error;
    }
  } });
}
