import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectRenderedHtml, writeRenderedCollection, type RenderedSnapshotSelection } from '../../src/doctor/capture.ts';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const selection = (id = 'page'): RenderedSnapshotSelection => ({ id, url: `https://example.test/${id}`, bindings: [
  { formId: 'form', actionId: 'test.submit', required: true, submitterPolicy: 'enumerate-native', constraintMismatchSeverity: 'warning' },
] });
const options = { selections: [selection()], allowedOrigins: ['https://example.test'] };

describe('explicit rendered HTML capture', () => {
  test('bounds concurrency, preserves selected-state order and does not mutate selections', async () => {
    let active = 0;
    let peak = 0;
    const selections = Object.freeze([selection('one'), selection('two'), selection('three')]);
    const result = await collectRenderedHtml({ ...options, selections, concurrency: 2, render: async (state, { signal }) => {
      peak = Math.max(peak, ++active);
      expect(signal.aborted).toBe(false);
      await Bun.sleep(state.id === 'one' ? 10 : 1);
      active--;
      return `<p>${state.id}</p>`;
    } });
    expect(peak).toBe(2);
    expect(result.snapshots.map((snapshot) => snapshot.id)).toEqual(['one', 'two', 'three']);
    expect(result.applicationCompleteness).toBe('not-evaluated');
    expect(result.snapshots[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshots[0]?.document.executionAssumption).toContain('other-routes-and-states-not-evaluated');
  });

  test('fetches GET HTML only and refuses redirects, failures and other media types', async () => {
    let requestOptions: RequestInit | undefined;
    const result = await collectRenderedHtml({ ...options, fetch: (async (_url, init) => {
      requestOptions = init;
      return new Response('<form></form>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }) as typeof fetch });
    expect(result.snapshots[0]?.html).toBe('<form></form>');
    expect(requestOptions?.redirect).toBe('manual');
    expect(requestOptions?.method).toBeUndefined();
    for (const response of [new Response('', { status: 302, headers: { Location: 'https://other.test' } }), new Response('', { status: 500 }), new Response('{}', { headers: { 'Content-Type': 'application/json' } })]) {
      await expect(collectRenderedHtml({ ...options, render: () => response })).rejects.toThrow();
    }
  });

  test('checks byte limits at the exact UTF-8 threshold and total budget', async () => {
    await expect(collectRenderedHtml({ ...options, maxBytes: 4, render: () => '😀' })).resolves.toBeDefined();
    await expect(collectRenderedHtml({ ...options, maxBytes: 3, render: () => '😀' })).rejects.toThrow('maxBytes');
    await expect(collectRenderedHtml({ ...options, maxBytes: 4, render: () => new Response('12345', { headers: { 'Content-Type': 'text/html' } }) })).rejects.toThrow('maxBytes');
    await expect(collectRenderedHtml({ ...options, selections: [selection('a'), selection('b')], maxTotalBytes: 7, render: () => '1234' })).rejects.toThrow('maxTotalBytes');
  });

  test('rejects invalid UTF-8, malformed declared length and ill-formed rendered Unicode', async () => {
    for (const rendered of [new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'text/html' } }), new Response('a', { headers: { 'Content-Type': 'text/html', 'Content-Length': 'x' } }), new Response('a', { headers: { 'Content-Type': 'text/html; charset=shift_jis' } }), '\ud800']) {
      await expect(collectRenderedHtml({ ...options, render: () => rendered })).rejects.toThrow();
    }
  });

  test('propagates exact cancellation and times out uncooperative render callbacks', async () => {
    const controller = new AbortController();
    const reason = { cancelled: true };
    controller.abort(reason);
    await expect(collectRenderedHtml({ ...options, signal: controller.signal, render: () => 'unused' })).rejects.toBe(reason);
    await expect(collectRenderedHtml({ ...options, timeoutMs: 10, render: () => new Promise(() => {}) })).rejects.toHaveProperty('name', 'TimeoutError');
  });

  test.each([4, 5, 6])('checks the exclusive deadline after a ready renderer at %ims', async (elapsed) => {
    let measured = 0;
    const now = spyOn(performance, 'now').mockImplementation(() => measured);
    try {
      const capture = collectRenderedHtml({ ...options, timeoutMs: 5, render: () => { measured = elapsed; return '<form></form>'; } });
      if (elapsed < 5) await expect(capture).resolves.toBeDefined();
      else await expect(capture).rejects.toHaveProperty('name', 'TimeoutError');
    } finally { now.mockRestore(); }
  });

  test('captures callback references before asynchronous selected states can change host options', async () => {
    const calls: string[] = [];
    const mutable = {
      ...options, selections: [selection('one'), selection('two')], concurrency: 1,
      render: (state: RenderedSnapshotSelection) => {
        calls.push(state.id);
        mutable.render = () => '<p>replacement</p>';
        return `<p>${state.id}</p>`;
      },
    };
    const collection = await collectRenderedHtml(mutable);
    expect(calls).toEqual(['one', 'two']);
    expect(collection.snapshots.map((snapshot) => snapshot.html)).toEqual(['<p>one</p>', '<p>two</p>']);
  });

  test('cancels streamed resources after byte overflow or header rejection', async () => {
    let cancelled = 0;
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled++; } }), { headers: { 'Content-Type': 'text/html' } });
    await expect(collectRenderedHtml({ ...options, maxBytes: 4, render: () => response })).rejects.toThrow('maxBytes');
    expect(cancelled).toBe(1);
    expect(response.body?.locked).toBe(false);
    const invalid = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'Content-Type': 'text/plain' } });
    await expect(collectRenderedHtml({ ...options, render: () => invalid })).rejects.toThrow('text/html');
    expect(cancelled).toBe(2);
  });

  test('refuses undeclared origins, ambiguous filenames, credentials and empty bindings', async () => {
    for (const selections of [[{ ...selection(), url: 'https://evil.test/' }], [selection('Page'), selection('page')], [selection('../bad')], [{ ...selection(), url: 'https://user:pass@example.test' }], [{ ...selection(), bindings: [] }]]) {
      await expect(collectRenderedHtml({ ...options, selections, render: () => '' })).rejects.toThrow();
    }
    for (const concurrency of [0, -1, 1.5, Infinity]) await expect(collectRenderedHtml({ ...options, concurrency, render: () => '' })).rejects.toThrow();
  });

  test('writes a new artifact directory and runnable Doctor document declarations without overwriting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typehtml-capture-')); dirs.push(root);
    const directory = join(root, 'snapshots');
    const collection = await collectRenderedHtml({ ...options, render: () => '<form id="form"></form>' });
    const written = await writeRenderedCollection(collection, { directory, root, inputs: [{ kind: 'form-projection', path: 'generated/form-check.json' }] });
    expect(await readFile(join(directory, 'page.html'), 'utf8')).toBe('<form id="form"></form>');
    const config = JSON.parse(await readFile(written.configPath, 'utf8'));
    expect(config.documents[0].documentUrl).toBe('https://example.test/page');
    expect(config.audit.releaseRequiresCompleteDeclaredBoundary).toBe(true);
    await writeFile(join(directory, 'keep.txt'), 'application data');
    await expect(writeRenderedCollection(collection, { directory, root, inputs: [{ kind: 'form-projection', path: 'projection.json' }] })).rejects.toThrow('already exists');
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('application data');
    expect((await readdir(root)).filter((entry) => entry.startsWith('.typehtml-capture-'))).toEqual([]);
    await expect(writeRenderedCollection(collection, { directory: join(root, '..', 'escape'), root, inputs: [{ kind: 'form-projection', path: 'projection.json' }] })).rejects.toThrow('inside');
  });
});
