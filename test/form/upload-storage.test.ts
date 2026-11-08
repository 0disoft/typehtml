import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureUploadedFile, cloneUploadInput, createTemporaryUploadStore, type TemporaryUploadStore } from '../../src/form/upload-storage.ts';
import { decodeUploadFields, prepareUploadFields } from '../../src/form/uploads.ts';

const metadata = { field: 'attachment', name: '../../untrusted/name.txt', type: 'text/plain' } as const;
const active = new AbortController().signal;
const bytes = new TextEncoder().encode('private upload bytes');
async function withStore(run: (store: TemporaryUploadStore, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'typehtml-storage-test-'));
  try { await run(createTemporaryUploadStore({ directory }), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe('request-owned temporary upload storage', () => {
  test('stores under an opaque private path, streams exact bytes, and expires capabilities on dispose', async () => {
    await withStore(async (store, directory) => {
      const upload = await store.open(metadata, active);
      try {
        await upload.write(bytes.subarray(0, 3), active); await upload.write(bytes.subarray(3), active);
        const file = await upload.finish();
        expect(file).toMatchObject({ ...metadata, kind: 'typehtml-upload/1', size: bytes.length });
        const directories = await readdir(directory);
        expect(directories).toHaveLength(1);
        expect(directories[0]).toStartWith('typehtml-upload-');
        expect(await readdir(join(directory, directories[0]!))).toEqual(['body']);
        expect(new Uint8Array(await readFile(join(directory, directories[0]!, 'body')))).toEqual(bytes);
        expect(await new Response(file.stream()).text()).toBe('private upload bytes');
        expect(Object.isFrozen(file)).toBe(true);
        await upload.dispose();
        expect(() => file.stream()).toThrow('lifetime');
        await expect(upload.write(bytes, active)).rejects.toThrow('closed');
        await expect(upload.finish()).rejects.toThrow('disposed');
      } finally { await upload.dispose(); }
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('aborted open/write do not consume data or leave a temporary directory', async () => {
    await withStore(async (store, directory) => {
      const controller = new AbortController(); const reason = new Error('cancelled'); controller.abort(reason);
      await expect(store.open(metadata, controller.signal)).rejects.toBe(reason);
      expect(await readdir(directory)).toEqual([]);
      const upload = await store.open(metadata, active);
      try { await expect(upload.write(bytes, controller.signal)).rejects.toBe(reason); }
      finally { await upload.dispose(); }
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('disposal closes an outstanding reader before deleting its underlying file', async () => {
    await withStore(async (store, directory) => {
      const upload = await store.open(metadata, active);
      await upload.write(new Uint8Array(256 * 1024).fill(65), active);
      const file = await upload.finish();
      const reader = file.stream().getReader();
      await reader.read();
      await upload.dispose();
      await reader.cancel().catch(() => undefined);
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('cloning retains only captured upload capabilities while isolating ordinary input', async () => {
    await withStore(async (store) => {
      const upload = await store.open(metadata, active);
      try {
        await upload.write(bytes, active);
        const file = captureUploadedFile(await upload.finish(), metadata, bytes.length);
        const source = { nested: { tags: ['a'], file } };
        const clone = cloneUploadInput(source) as typeof source;
        expect(clone.nested.file).toBe(file);
        expect(clone.nested).not.toBe(source.nested);
        clone.nested.tags.push('b'); expect(source.nested.tags).toEqual(['a']);
        expect(await new Response(clone.nested.file.stream()).text()).toBe('private upload bytes');
        expect(() => cloneUploadInput({ ...file })).toThrow();
      } finally { await upload.dispose(); }
    });
  });

  test('upload declarations are immutable data and retain required/count boundaries', async () => {
    const source = { attachment: { required: true, multiple: true, minFiles: 1, maxFiles: 2, accept: ['.txt', 'text/*'] } };
    const fields = prepareUploadFields(source);
    source.attachment.accept.push('.png');
    expect(fields.attachment!.accept).toEqual(['.txt', 'text/*']);
    expect(Object.isFrozen(fields.attachment!.accept)).toBe(true);
    let getters = 0;
    expect(() => prepareUploadFields({ attachment: { get required() { getters++; return true; } } })).toThrow('data properties');
    expect(getters).toBe(0);
    for (const field of [{ required: true, maxFiles: 0 }, { minFiles: 2, maxFiles: 1 }, { multiple: false, maxFiles: 2 }, { accept: ['text/plain, image/*'] }, { maxFiles: 65 }]) expect(() => prepareUploadFields({ attachment: field })).toThrow();
    expect(decodeUploadFields(fields, new Map()).issues.map(({ code }) => code)).toEqual(['REQUIRED', 'MIN_FILES']);
    await withStore(async (store) => {
      const upload = await store.open(metadata, active);
      try {
        const file = captureUploadedFile(await upload.finish(), metadata, 0);
        expect(decodeUploadFields(fields, new Map([['attachment', [file, file]]])).issues).toEqual([]);
        expect(decodeUploadFields(fields, new Map([['attachment', [file, file, file]]])).issues[0]?.code).toBe('MAX_FILES');
      } finally { await upload.dispose(); }
    });
    expect(decodeUploadFields(prepareUploadFields({ attachment: {} }), new Map()).value).toEqual({});
    expect(decodeUploadFields(prepareUploadFields({ attachment: { multiple: true } }), new Map()).value).toEqual({ attachment: [] });
  });
});
