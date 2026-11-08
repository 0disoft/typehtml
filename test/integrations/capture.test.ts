import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectAstroHtml, collectHonoHtml, collectSvelteKitHtml, redactCapturedHtml } from '../../src/integrations/capture.ts';
import { writeRenderedCollection } from '../../src/doctor/capture.ts';
import { sourceSha256 } from '../../src/contract/behavior.ts';

const selection = (id = 'initial', expectedStatus = 200) => ({ id, url: `https://app.test/edit?state=${id}`, expectedStatus, bindings: [{ formId: 'edit', actionId: 'edit.save', required: true, submitterPolicy: 'enumerate-native' as const, constraintMismatchSeverity: 'warning' as const }] });
const common = { selections: [selection()], allowedOrigins: ['https://app.test'] };
const html = '<!doctype html><form id="edit" action="/edit" method="post"><input type="hidden" name="_bc_csrf" value="csrf-secret"><input type="hidden" name="_bc_request" value="request-secret"><input name="email" value="person@example.test"><button>Save</button></form>';

describe('selected framework HTML capture bridges', () => {
  test('captures a real Hono app.request without starting a server and redacts before return', async () => {
    const app = new Hono();
    app.get('/edit', (context) => context.html(html));
    const result = await collectHonoHtml({ ...common, redactFields: ['email'], request: (request) => app.request(request) });
    const snapshot = result.snapshots[0]!;
    expect(result.framework).toBe('hono'); expect(result.applicationCompleteness).toBe('not-evaluated');
    expect(snapshot.html).toContain('[REDACTED]');
    for (const secret of ['csrf-secret', 'request-secret', 'person@example.test']) expect(snapshot.html).not.toContain(secret);
    expect(snapshot.sha256).toBe(sourceSha256(Buffer.from(snapshot.html)));
    expect(snapshot.document.sourceKind).toBe('redacted-snapshot');
    expect(snapshot.document.executionAssumption).toContain('original-http-status:200');
    expect(snapshot.document.executionAssumption).toContain('value-dependent-constraints-not-evaluated');
    expect(result.redaction.controls).toBe(3); expect(Object.isFrozen(result.snapshots)).toBe(true);
  });

  test('explicit invalid 422 state is captured while unexpected 500 and undeclared errors fail', async () => {
    const result = await collectSvelteKitHtml({ ...common, selections: [selection('invalid', 422)], respond: () => new Response(html, { status: 422, headers: { 'content-type': 'text/html' } }) });
    expect(result.snapshots[0]!.document.executionAssumption).toContain('original-http-status:422');
    let cancelled = 0;
    const response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 500, headers: { 'content-type': 'text/html' } });
    await expect(collectSvelteKitHtml({ ...common, respond: () => response })).rejects.toThrow('declared HTTP 200');
    expect(cancelled).toBe(1);
    await expect(collectHonoHtml({ ...common, request: () => new Response(html, { status: 422 }) })).rejects.toThrow('declared HTTP 200');
    await expect(collectAstroHtml({ ...common, selections: [selection('invalid', 422)], render: () => html })).rejects.toThrow('require a Response');
    let rendered = false;
    await expect(collectAstroHtml({ ...common, selections: [selection('broken', 500)], render: () => { rendered = true; return html; } })).rejects.toThrow('expectedStatus');
    expect(rendered).toBe(false);
  });

  test('Astro callback receives only selected state with a GET Request and cancellation signal', async () => {
    const seen: string[] = [];
    const result = await collectAstroHtml({ ...common, selections: [selection('initial'), selection('dynamic')], concurrency: 1,
      render: (state, { request, signal }) => { seen.push(state.id); expect(request.method).toBe('GET'); expect(request.url).toBe(state.url); expect(request.headers.get('accept')).toBe('text/html'); expect(signal.aborted).toBe(false); return html; },
    });
    expect(seen).toEqual(['initial', 'dynamic']); expect(result.snapshots.map(({ id }) => id)).toEqual(seen);
  });

  test('request signal follows external cancellation and bounded callbacks retain exact abort reasons', async () => {
    const controller = new AbortController(); const reason = new Error('stop capture'); let requestSignal: AbortSignal | undefined;
    const promise = collectSvelteKitHtml({ ...common, signal: controller.signal, respond: (request) => { requestSignal = request.signal; controller.abort(reason); return new Promise(() => {}); } });
    await expect(promise).rejects.toBe(reason); expect(requestSignal?.aborted).toBe(true); expect(requestSignal?.reason).toBe(reason);
    await expect(collectAstroHtml({ ...common, timeoutMs: 5, render: () => new Promise(() => {}) })).rejects.toHaveProperty('name', 'TimeoutError');
  });

  test('explicit origin restrictions apply before framework callbacks or redirected bodies are consumed', async () => {
    let called = false;
    await expect(collectAstroHtml({ ...common, selections: [{ ...selection(), url: 'https://foreign.test/edit' }], render: () => { called = true; return html; } })).rejects.toThrow('outside');
    expect(called).toBe(false);
    const redirected = new Response(html, { status: 422, headers: { 'content-type': 'text/html' } });
    Object.defineProperty(redirected, 'url', { value: 'https://foreign.test/edit' });
    await expect(collectSvelteKitHtml({ ...common, selections: [selection('invalid', 422)], respond: () => redirected })).rejects.toThrow('origin changed');
  });

  test('writes only redacted HTML and metadata through the existing atomic artifact writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typehtml-framework-capture-'));
    try {
      const result = await collectAstroHtml({ ...common, selections: [{ ...selection(), url: 'https://app.test/edit?_bc_csrf=url-secret' }], render: () => html });
      const written = await writeRenderedCollection(result, { root, directory: join(root, 'snapshots'), inputs: [{ kind: 'form-projection', path: 'form-check.json' }] });
      const artifact = await readFile(join(root, 'snapshots', 'initial.html'), 'utf8');
      const metadata = await readFile(written.configPath, 'utf8');
      for (const secret of ['csrf-secret', 'request-secret', 'url-secret']) expect(artifact + metadata).not.toContain(secret);
      expect(JSON.parse(metadata).documents[0].sourceKind).toBe('redacted-snapshot');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('control value redaction', () => {
  test('preserves source and structural flags while removing duplicate values, textarea, selected options, and datalists', () => {
    const source = '<!-- untouched --><form><input name="private" value="first-secret" value="duplicate-secret" checked disabled required><textarea name="note">textarea-secret</textarea><select name="choice" multiple required><option value="option-secret" selected>label-secret</option><option disabled>implicit-secret</option></select><input name="private" list="choices"><datalist id="choices"><option value="suggestion-secret">suggestion-label</option></datalist><input type="password" value="password-secret"><input name="public" value="keep"></form>';
    const result = redactCapturedHtml(source, ['private', 'note', 'choice']);
    for (const secret of ['first-secret', 'duplicate-secret', 'textarea-secret', 'option-secret', 'label-secret', 'implicit-secret', 'suggestion-secret', 'suggestion-label', 'password-secret']) expect(result.html).not.toContain(secret);
    expect(result.html).toContain('<!-- untouched -->'); expect(result.html).toContain('<input name="public" value="keep">');
    expect(result.html).toContain('checked="" disabled="" required=""'); expect(result.html).toContain(' selected=""'); expect(result.html).toContain('<select name="choice" multiple required>');
  });

  test('redacts template controls and quoted entity values without mutating field declarations', () => {
    const names = ['private'];
    const result = redactCapturedHtml('<template><input name=private value="quoted&amp;secret"></template><textarea name=private>&lt;private&gt;</textarea>', names);
    expect(result.html).not.toContain('secret'); expect(result.html).not.toContain('private&gt;'); expect(names).toEqual(['private']); expect(Object.isFrozen(result.fields)).toBe(true);
    for (const fields of [[''], ['x'.repeat(1025)], new Array(1025).fill('x')]) expect(() => redactCapturedHtml('', fields)).toThrow('redaction fields');
    expect(() => redactCapturedHtml('<input name="_bc_csrf" value="unclosed-secret"')).toThrow('incomplete tag');
  });

  test('retains byte limits after marker expansion and rejects non-HTML callback responses', async () => {
    const small = '<input name=_bc_csrf value=x>';
    await expect(collectAstroHtml({ ...common, maxBytes: Buffer.byteLength(small), render: () => small })).rejects.toThrow('redacted capture exceeds byte limits');
    await expect(collectHonoHtml({ ...common, request: () => new Response('text/plain', { headers: { 'content-type': 'text/plain' } }) })).rejects.toThrow('text/html');
  });
});
