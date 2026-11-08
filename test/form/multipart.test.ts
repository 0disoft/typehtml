import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertMultipartTransport, prepareMultipartLimits, readMultipartForm, UploadStorageError, type MultipartLimits } from '../../src/form/multipart.ts';
import { createTemporaryUploadStore, type TemporaryUploadStore, type UploadedFile } from '../../src/form/upload-storage.ts';
import { WireError, type FormReadLimits, type WireStatus } from '../../src/runtime/wire.ts';
import { createSchemaFormHandler, defineSchemaForm } from '../../src/form/schema-form.ts';
import { getFormProps } from '../../src/form/attributes.ts';
import { getSchemaFieldProps } from '../../src/form/schema-html.ts';

const boundary = 'TypeHTML-test-boundary';
const encoder = new TextEncoder();
type Part = Readonly<{ name: string; value: string | Uint8Array; filename?: string; extraHeaders?: string }>;
const limits = (overrides: Partial<MultipartLimits> = {}) => prepareMultipartLimits({ maxBytes: 64 * 1024, maxFileBytes: 16 * 1024, maxTotalFileBytes: 32 * 1024, maxFiles: 4, maxParts: 16, readTimeoutMs: 1000, ...overrides });
const text: FormReadLimits = { maxBytes: 64 * 1024, maxEntries: 16, maxKeyBytes: 128, maxValueBytes: 1024 };
const policy = { names: ['title', 'tags', 'attachment', 'other'], repeatable: ['tags'] } as const;
const uploads = { attachment: { multiple: true }, other: {} } as const;

function body(parts: readonly Part[], closing = true): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const disposition = `Content-Disposition: form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}`;
    chunks.push(encoder.encode(`--${boundary}\r\n${disposition}\r\n${part.filename === undefined ? '' : 'Content-Type: application/octet-stream\r\n'}${part.extraHeaders ?? ''}\r\n`));
    chunks.push(typeof part.value === 'string' ? encoder.encode(part.value) : part.value, encoder.encode('\r\n'));
  }
  if (closing) chunks.push(encoder.encode(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function request(bytes: Uint8Array, options: Readonly<{ chunkSize?: number; signal?: AbortSignal; headers?: Record<string, string>; cancel?: () => void }> = {}): Request {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(offset + (options.chunkSize ?? bytes.length), bytes.length);
    controller.enqueue(bytes.slice(offset, end)); offset = end;
  }, cancel() { options.cancel?.(); } });
  return new Request('https://app.test/upload', { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...options.headers }, body: stream, signal: options.signal, duplex: 'half' } as RequestInit);
}

async function withStore(run: (store: TemporaryUploadStore, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'typehtml-multipart-test-'));
  try { await run(createTemporaryUploadStore({ directory }), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function wireFailure(promise: Promise<unknown>, code: string, status?: WireStatus): Promise<WireError> {
  let error: unknown;
  try { await promise; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(WireError);
  expect((error as WireError).code).toBe(code);
  if (status !== undefined) expect((error as WireError).status).toBe(status);
  return error as WireError;
}

describe('bounded multipart transport', () => {
  test.each([1, 2, 7, 65536])('parses split boundaries with %i-byte chunks and preserves file/text wire order', async (chunkSize) => {
    await withStore(async (store, directory) => {
      const result = await readMultipartForm(request(body([
        { name: '_bc_csrf', value: 'token' }, { name: 'tags', value: 'b' },
        { name: 'attachment', filename: 'first.bin', value: new Uint8Array([0, 255, 13, 10, 65]) },
        { name: 'tags', value: 'a' }, { name: 'tags', value: 'b' },
        { name: 'attachment', filename: 'second.txt', value: 'second' },
      ]), { chunkSize }), limits(), text, policy, uploads, store);
      try {
        expect(result.entries).toEqual([{ key: '_bc_csrf', value: 'token' }, { key: 'tags', value: 'b' }, { key: 'tags', value: 'a' }, { key: 'tags', value: 'b' }]);
        const files = result.files.get('attachment')!;
        expect(files.map(({ name, size }) => [name, size])).toEqual([['first.bin', 5], ['second.txt', 6]]);
        expect(new Uint8Array(await new Response(files[0]!.stream()).arrayBuffer())).toEqual(new Uint8Array([0, 255, 13, 10, 65]));
      } finally { await result.dispose(); }
      expect(await readdir(directory)).toEqual([]);
      await result.dispose();
      expect(() => result.files.get('attachment')![0]!.stream()).toThrow('lifetime');
    });
  });

  test('accepts exact per-file and aggregate byte bounds and rejects the next byte', async () => {
    await withStore(async (store, directory) => {
      const small = limits({ maxFileBytes: 4, maxTotalFileBytes: 8 });
      const result = await readMultipartForm(request(body([{ name: 'attachment', filename: 'a', value: '1234' }, { name: 'attachment', filename: 'b', value: '5678' }])), small, text, policy, uploads, store);
      expect(result.files.get('attachment')!.map(({ size }) => size)).toEqual([4, 4]);
      await result.dispose();
      await wireFailure(readMultipartForm(request(body([{ name: 'attachment', filename: 'a', value: '12345' }])), small, text, policy, uploads, store), 'FILE_TOO_LARGE', 413);
      await wireFailure(readMultipartForm(request(body([{ name: 'attachment', filename: 'a', value: '1234' }, { name: 'attachment', filename: 'b', value: '5678' }, { name: 'attachment', filename: 'c', value: '9' }])), small, text, policy, uploads, store), 'TOTAL_FILES_TOO_LARGE', 413);
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('file payload capacity does not include its multipart header overhead', async () => {
    await withStore(async (store, directory) => {
      const result = await readMultipartForm(request(body([{ name: 'attachment', filename: 'max.bin', value: new Uint8Array(16384) }])), limits(), text, policy, uploads, store);
      expect(result.files.get('attachment')![0]!.size).toBe(16384);
      await result.dispose(); expect(await readdir(directory)).toEqual([]);
    });
  });

  test('accepts exact body bytes and rejects the next byte without Content-Length', async () => {
    await withStore(async (store, directory) => {
      const bytes = body([{ name: 'attachment', filename: 'a', value: '1234' }]);
      const small = limits({ maxBytes: bytes.length, maxFileBytes: 4, maxTotalFileBytes: 4 });
      const result = await readMultipartForm(request(bytes), small, text, policy, uploads, store);
      await result.dispose();
      await wireFailure(readMultipartForm(request(bytes), limits({ ...small, maxBytes: bytes.length - 1 }), text, policy, uploads, store), 'BODY_TOO_LARGE', 413);
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('accepts exact file and part counts and rejects the next item', async () => {
    await withStore(async (store, directory) => {
      const parts = [{ name: 'attachment', filename: 'a', value: '1' }, { name: 'attachment', filename: 'b', value: '2' }];
      const result = await readMultipartForm(request(body(parts)), limits({ maxFiles: 2, maxParts: 2 }), text, policy, uploads, store);
      expect(result.files.get('attachment')).toHaveLength(2);
      await result.dispose();
      await wireFailure(readMultipartForm(request(body([...parts, { name: 'attachment', filename: 'c', value: '3' }])), limits({ maxFiles: 2, maxParts: 4 }), text, policy, uploads, store), 'TOO_MANY_FILES', 413);
      await wireFailure(readMultipartForm(request(body([...parts, { name: 'title', value: 'third' }])), limits({ maxFiles: 2, maxParts: 2 }), text, policy, uploads, store), 'TOO_MANY_PARTS', 413);
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('rejects oversized headers, text limits, duplicate/prototype keys, and file/text confusion', async () => {
    await withStore(async (store, directory) => {
      const cases = [
        [[{ name: 'title', value: 'x'.repeat(1025) }], 'VALUE_TOO_LARGE'],
        [[{ name: 'title', value: 'one' }, { name: 'title', value: 'two' }], 'DUPLICATE_KEY'],
        [[{ name: '__proto__', value: 'x' }], 'UNKNOWN_FIELD'],
        [[{ name: 'attachment', value: 'text' }], 'EXPECTED_FILE'],
        [[{ name: 'title', filename: 'unexpected', value: 'x' }], 'UNEXPECTED_FILE'],
        [[{ name: 'attachment', filename: '', value: 'x' }], 'EMPTY_FILENAME_CONTENT'],
        [[{ name: 'attachment', filename: 'a', value: 'x', extraHeaders: 'Content-Type: text/plain\r\n' }], 'DUPLICATE_PART_HEADER'],
        [[{ name: 'attachment', filename: 'a', value: 'eA==', extraHeaders: 'Content-Transfer-Encoding: base64\r\n' }], 'UNSUPPORTED_TRANSFER_ENCODING'],
      ] as const;
      for (const [parts, code] of cases) await wireFailure(readMultipartForm(request(body(parts)), limits(), text, policy, uploads, store), code);
      await wireFailure(readMultipartForm(request(body([{ name: 'attachment', filename: 'a', value: 'x', extraHeaders: 'X-Long: ' + 'x'.repeat(16384) + '\r\n' }])), limits({ maxFileBytes: 32 * 1024 }), text, policy, uploads, store), 'HEADERS_TOO_LARGE');
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('limits decoded UTF-8 text and declared key names by bytes', async () => {
    await withStore(async (store, directory) => {
      const key = 'k'.repeat(128);
      const result = await readMultipartForm(request(body([{ name: key, value: '가'.repeat(341) + 'a' }])), limits(), text, { names: [key] }, {}, store);
      expect(result.entries[0]!.value).toBe('가'.repeat(341) + 'a'); await result.dispose();
      await wireFailure(readMultipartForm(request(body([{ name: key + 'k', value: 'a' }])), limits(), text, { names: [key + 'k'] }, {}, store), 'KEY_TOO_LARGE', 413);
      await wireFailure(readMultipartForm(request(body([{ name: 'title', value: '가'.repeat(342) }])), limits(), text, policy, uploads, store), 'VALUE_TOO_LARGE', 413);
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('distinguishes empty browser placeholders from selected zero-byte files', async () => {
    await withStore(async (store, directory) => {
      const result = await readMultipartForm(request(body([{ name: 'attachment', filename: '', value: '' }, { name: 'attachment', filename: 'empty.txt', value: '' }])), limits({ maxFiles: 1 }), text, policy, uploads, store);
      expect(result.files.get('attachment')!.map(({ name, size }) => [name, size])).toEqual([['empty.txt', 0]]);
      await result.dispose(); expect(await readdir(directory)).toEqual([]);
    });
  });

  test('retains the declared text entry count in multipart mode', async () => {
    await withStore(async (store, directory) => {
      const two = body([{ name: 'tags', value: 'a' }, { name: 'tags', value: 'b' }]);
      const result = await readMultipartForm(request(two), limits(), { ...text, maxEntries: 2 }, policy, uploads, store);
      expect(result.entries).toHaveLength(2); await result.dispose();
      await wireFailure(readMultipartForm(request(two), limits(), { ...text, maxEntries: 1 }, policy, uploads, store), 'TOO_MANY_ENTRIES', 413);
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('rejects invalid UTF-8 rather than changing submitted text to replacement characters', async () => {
    await withStore(async (store, directory) => {
      const valid = await readMultipartForm(request(body([{ name: 'title', value: '한글 😀 �' }]), { chunkSize: 1 }), limits(), text, policy, uploads, store);
      expect(valid.entries).toEqual([{ key: 'title', value: '한글 😀 �' }]); await valid.dispose();
      await wireFailure(readMultipartForm(request(body([{ name: 'title', value: new Uint8Array([0xc3, 0x28]) }])), limits(), text, policy, uploads, store), 'INVALID_UTF8', 400);
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('rejects a non-UTF-8 text charset instead of implicitly transcoding input', async () => {
    await withStore(async (store, directory) => {
      const valid = await readMultipartForm(request(body([{ name: 'title', value: '한글 �', extraHeaders: 'Content-Type: text/plain; charset=UTF-8\r\n' }])), limits(), text, policy, uploads, store);
      expect(valid.entries[0]?.value).toBe('한글 �'); await valid.dispose();
      let error: unknown;
      try { await readMultipartForm(request(body([{ name: 'title', value: new Uint8Array([0xe9]), extraHeaders: 'Content-Type: text/plain; charset=iso-8859-1\r\n' }])), limits(), text, policy, uploads, store); }
      catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(WireError);
      expect((error as WireError).status).toBe(415);
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('keeps original storage failures as cause and cleans already acquired files', async () => {
    await withStore(async (store, directory) => {
      const cause = new Error('disk write failed');
      const failing: TemporaryUploadStore = { async open(metadata, signal) {
        const upload = await store.open(metadata, signal);
        return { ...upload, write: async () => { throw cause; } };
      } };
      let error: unknown;
      try { await readMultipartForm(request(body([{ name: 'attachment', filename: 'a', value: 'x' }])), limits(), text, policy, uploads, failing); }
      catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(UploadStorageError);
      expect((error as UploadStorageError).cause).toBe(cause);
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('times out a stalled source, cancels it, and propagates an explicit abort cause', async () => {
    let cancelled = 0;
    const stalled = () => new Request('https://app.test/upload', { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: new ReadableStream({ cancel() { cancelled++; } }), duplex: 'half' } as RequestInit);
    await wireFailure(readMultipartForm(stalled(), limits({ readTimeoutMs: 10 }), text, policy, uploads), 'BODY_READ_TIMEOUT', 408);
    expect(cancelled).toBe(1);
    const controller = new AbortController();
    const reason = new Error('client disconnected');
    controller.abort(reason);
    const error = await wireFailure(readMultipartForm(request(body([{ name: 'title', value: 'x' }]), { signal: controller.signal }), limits(), text, policy, uploads), 'BODY_READ_ABORTED', 400);
    expect(error.cause).toBe(reason);
  });

  test('cancellation while acquiring a real temporary file still cleans it up', async () => {
    await withStore(async (store, directory) => {
      const controller = new AbortController(); const reason = new Error('disconnect during storage open');
      const cancelling: TemporaryUploadStore = { async open(metadata, signal) {
        const upload = await store.open(metadata, signal);
        controller.abort(reason);
        return upload;
      } };
      const error = await wireFailure(readMultipartForm(request(body([{ name: 'attachment', filename: 'a', value: 'bytes' }]), { signal: controller.signal }), limits(), text, policy, uploads, cancelling), 'BODY_READ_ABORTED', 400);
      expect(error.cause).toBe(reason);
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('100 malformed uploads leave no temporary paths behind', async () => {
    await withStore(async (store, directory) => {
      for (let index = 0; index < 100; index++) await wireFailure(readMultipartForm(request(body([{ name: 'attachment', filename: `file-${index}`, value: 'bytes' }], false)), limits(), text, policy, uploads, store), 'INVALID_MULTIPART');
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('header gates and configuration validation precede storage acquisition', () => {
    const invalidHeaders: readonly Record<string, string>[] = [{ 'content-type': 'multipart/form-data' }, { 'content-type': 'multipart/form-data; boundary=x; charset=utf-8' }, { 'content-encoding': 'gzip' }, { 'content-length': '999999' }];
    for (const headers of invalidHeaders) expect(() => assertMultipartTransport(request(new Uint8Array(), { headers }), limits())).toThrow(WireError);
    for (const options of [{ maxFileBytes: 0 }, { maxFiles: -1 }, { maxParts: NaN }, { maxBytes: 3, maxTotalFileBytes: 4 }, { readTimeoutMs: 2 ** 31 }]) expect(() => prepareMultipartLimits(options)).toThrow();
  });
});

const uploadForm = defineSchemaForm({ id: 'upload.save', path: '/upload', fields: {},
  uploads: { attachment: { required: true, accept: ['.txt'] } }, multipart: {},
  input: z.object({ attachment: z.custom<UploadedFile>((value) => (value as UploadedFile)?.kind === 'typehtml-upload/1') }), output: z.string(),
});
const uploadParts: readonly Part[] = [{ name: '_bc_csrf', value: 'token' }, { name: 'attachment', filename: 'a.bin', value: 'private bytes' }];
const uploadRequest = (parts = uploadParts, signal?: AbortSignal, headers: Record<string, string> = {}) => request(body(parts), { signal, headers: { origin: 'https://app.test', ...headers } });

describe('multipart schema form request lifetime', () => {
  test('checks fixed array holes after text and file slots are merged, while rejecting real gaps', async () => {
    await withStore(async (store, directory) => {
      let executed = 0;
      for (const index of [1, 2]) {
        const form = defineSchemaForm({ id: `upload.rows${index}`, path: '/upload',
          fields: { [`rows[${index}].caption`]: { type: 'string', required: true } },
          uploads: { 'rows[0].file': { required: true } }, multipart: {},
          input: z.object({ rows: z.array(z.object({ caption: z.string().optional(), file: z.custom<UploadedFile>((value) => (value as UploadedFile)?.kind === 'typehtml-upload/1').optional() })) }), output: z.string(),
        });
        const handle = createSchemaFormHandler(form, { uploadStore: store, allowedOrigins: ['https://app.test'],
          authenticate: () => ({}), csrfToken: () => 'token', authorize: () => true,
          execute: async ({ input }) => { executed++; expect(input.rows).toHaveLength(2); expect(input.rows[1]!.caption).toBe('second'); expect(await new Response(input.rows[0]!.file!.stream()).text()).toBe('file bytes'); return 'saved'; },
          project: (value) => value, success: () => ({ location: '/done' }),
        });
        const response = await handle(uploadRequest([{ name: '_bc_csrf', value: 'token' },
          { name: `rows[${index}].caption`, value: 'second' }, { name: 'rows[0].file', filename: 'a.txt', value: 'file bytes' }]));
        expect(response.status).toBe(index === 1 ? 303 : 422);
        expect(await readdir(directory)).toEqual([]);
      }
      expect(executed).toBe(1);
    });
  });

  test('file-only form validates real capabilities, executes once, redirects and releases storage', async () => {
    await withStore(async (store, directory) => {
      const calls: string[] = []; let saved: UploadedFile | undefined;
      const handle = createSchemaFormHandler(uploadForm, { uploadStore: store, allowedOrigins: ['https://app.test'],
        authenticate: () => { calls.push('authenticate'); return {}; }, csrfToken: () => { calls.push('csrf'); return 'token'; },
        authorize: ({ input }) => { calls.push('authorize'); expect(input.attachment.size).toBe(13); return true; },
        execute: async ({ input }) => { calls.push('execute'); saved = input.attachment; expect(await new Response(input.attachment.stream()).text()).toBe('private bytes'); return 'saved'; },
        project: (value) => value, success: () => ({ location: '/done' }),
      });
      const response = await handle(uploadRequest());
      expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('/done');
      expect(calls).toEqual(['authenticate', 'csrf', 'authorize', 'execute']);
      expect(await readdir(directory)).toEqual([]);
      expect(() => saved!.stream()).toThrow('lifetime');
      expect(getFormProps(uploadForm).enctype).toBe('multipart/form-data');
      expect(getSchemaFieldProps(uploadForm, 'attachment')).toMatchObject({ type: 'file', name: 'attachment', required: true, accept: '.txt' });
      expect(getSchemaFieldProps(uploadForm, 'attachment').value).toBeUndefined();
    });
  });

  test.each(['csrf', 'authorization', 'invalid', 'execute', 'cancel'] as const)('releases actual files after %s failure and prevents unauthorized effects', async (mode) => {
    await withStore(async (store, directory) => {
      const controller = new AbortController(); const reason = new Error(`failure in ${mode}`);
      let executed = 0; let authorized = 0; let observed: unknown;
      const handle = createSchemaFormHandler(uploadForm, { uploadStore: store, allowedOrigins: ['https://app.test'], authenticate: () => ({}), csrfToken: () => 'token',
        authorize: () => { authorized++; if (mode === 'cancel') controller.abort(reason); return mode !== 'authorization'; },
        execute: () => { executed++; if (mode === 'execute') throw reason; return 'saved'; }, project: (value) => value, success: () => ({ location: '/done' }),
        onError: (error) => { observed = error; },
      });
      const parts = mode === 'csrf' ? [{ name: '_bc_csrf', value: 'wrong' }, uploadParts[1]!] : mode === 'invalid' ? [...uploadParts, { name: 'attachment', filename: 'b.txt', value: 'second file' }] : uploadParts;
      const response = await handle(uploadRequest(parts, controller.signal));
      expect(response.status).toBe(mode === 'csrf' ? 403 : mode === 'authorization' ? 404 : mode === 'invalid' ? 422 : 500);
      expect(executed).toBe(mode === 'execute' ? 1 : 0);
      expect(authorized).toBe(mode === 'csrf' || mode === 'invalid' ? 0 : 1);
      if (mode === 'execute' || mode === 'cancel') expect(observed).toBe(reason);
      if (mode === 'invalid') {
        const html = await response.text();
        const control = html.match(/<input[^>]*name="attachment"[^>]*>/)?.[0];
        expect(control).toContain('type="file"'); expect(control).not.toContain('value=');
        expect(html).toContain('multipart/form-data');
      }
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('invalid origin, transport and authentication never acquire temporary storage', async () => {
    await withStore(async (store, directory) => {
      let opened = 0; let authenticated = 0;
      const tracked: TemporaryUploadStore = { open(metadata, signal) { opened++; return store.open(metadata, signal); } };
      const handle = createSchemaFormHandler(uploadForm, { uploadStore: tracked, allowedOrigins: ['https://app.test'], authenticate: () => { authenticated++; return null; }, csrfToken: () => 'token', authorize: () => true,
        execute: () => 'saved', project: (value) => value, success: () => ({ location: '/done' }),
      });
      expect((await handle(uploadRequest(uploadParts, undefined, { origin: 'https://foreign.test' }))).status).toBe(403);
      expect((await handle(uploadRequest(uploadParts, undefined, { 'content-type': 'application/x-www-form-urlencoded' }))).status).toBe(415);
      expect(authenticated).toBe(0);
      expect((await handle(uploadRequest())).status).toBe(401);
      expect(authenticated).toBe(1); expect(opened).toBe(0); expect(await readdir(directory)).toEqual([]);
    });
  });

  test('a storage outage is a 500 with the original cause and never executes business work', async () => {
    const reason = new Error('disk unavailable'); let observed: unknown; let executed = 0;
    const handle = createSchemaFormHandler(uploadForm, { uploadStore: { open: async () => { throw reason; } }, allowedOrigins: ['https://app.test'], authenticate: () => ({}), csrfToken: () => 'token', authorize: () => true,
      execute: () => { executed++; return 'saved'; }, project: (value) => value, success: () => ({ location: '/done' }), onError: (error) => { observed = error; },
    });
    expect((await handle(uploadRequest())).status).toBe(500);
    expect(observed).toBeInstanceOf(UploadStorageError); expect((observed as UploadStorageError).cause).toBe(reason); expect(executed).toBe(0);
  });

  test('an operation failure plus cleanup failure retains both causes after actual file deletion', async () => {
    await withStore(async (store, directory) => {
      const primary = new Error('business failure'); const cleanup = new Error('cleanup reporting failure'); let observed: unknown;
      const failing: TemporaryUploadStore = { async open(metadata, signal) {
        const upload = await store.open(metadata, signal);
        return { ...upload, async dispose() { await upload.dispose(); throw cleanup; } };
      } };
      const handle = createSchemaFormHandler(uploadForm, { uploadStore: failing, allowedOrigins: ['https://app.test'], authenticate: () => ({}), csrfToken: () => 'token', authorize: () => true,
        execute: () => { throw primary; }, project: () => 'saved', success: () => ({ location: '/done' }), onError: (error) => { observed = error; },
      });
      expect((await handle(uploadRequest())).status).toBe(500);
      expect(observed).toBeInstanceOf(AggregateError);
      const error = observed as AggregateError;
      expect(error.cause).toBe(primary); expect(error.errors[0]).toBe(primary);
      expect(error.errors[1]).toBeInstanceOf(AggregateError); expect((error.errors[1] as AggregateError).errors).toContain(cleanup);
      expect(await readdir(directory)).toEqual([]);
    });
  });
});
