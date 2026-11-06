import { describe, expect, it } from 'bun:test';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createFastifyRoute, toExpress, toNodeListener } from '../../src/integrations/node.ts';
import type { WebFormHandler } from '../../src/integrations/web.ts';
import { defineForm } from '../../src/form/definition.ts';
import { createFormHandler } from '../../src/form/handler.ts';

const canonical = 'https://forms.test';
async function withServer(listener: (request: IncomingMessage, response: ServerResponse) => void, run: (base: string) => Promise<void>) {
  const server = createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP listener');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

function nativeFormHandler(): WebFormHandler {
  const form = defineForm({
    id: 'test', path: '/form', limits: { maxBytes: 128, maxEntries: 5, maxValueBytes: 64 },
    input: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 10 } } },
    output: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
  });
  return createFormHandler(form, {
    allowedOrigins: [canonical], authenticate: () => ({ id: 'test' }), csrfToken: () => 'csrf', authorize: () => true,
    execute: ({ input }) => input, project: (result) => result, success: () => ({ location: '/receipt' }),
  });
}

describe('raw Node framework adapters', () => {
  it('runs the native form flow over a socket, preserving redirects, invalid values and byte limits', async () => {
    await withServer(toNodeListener(nativeFormHandler(), { origin: canonical }), async (base) => {
      const send = (body: string) => fetch(base + '/form', {
        method: 'POST', body, redirect: 'manual', headers: { Origin: canonical, 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const valid = await send('_bc_csrf=csrf&name=Ada');
      expect(valid.status).toBe(303);
      expect(valid.headers.get('location')).toBe('/receipt');
      const invalid = await send('_bc_csrf=csrf&name=');
      expect(invalid.status).toBe(422);
      expect(await invalid.text()).toContain('aria-invalid="true"');
      expect((await send('_bc_csrf=csrf&name=Ada&name=Grace')).status).toBe(400);
      const oversized = await send('x'.repeat(129));
      expect(oversized.status).toBe(413);
      expect(await oversized.text()).toContain('BODY_TOO_LARGE');
    });
  });

  it('uses the configured origin despite hostile Host/proxy headers and preserves multiple cookies', async () => {
    await withServer(toExpress(async (request) => {
      expect(request.url).toBe(canonical + '/form?x=1');
      const headers = new Headers({ 'Content-Type': 'text/plain', 'X-Original': 'preserved' });
      headers.append('Set-Cookie', 'a=1; HttpOnly');
      headers.append('Set-Cookie', 'b=2; SameSite=Strict');
      return new Response(await request.text(), { status: 409, headers });
    }, { origin: canonical }), async (base) => {
      const response = await fetch(base + '/form?x=1', { method: 'POST', body: 'raw=bytes', headers: {
        Host: 'evil.test', 'X-Forwarded-Host': 'evil.test', 'X-Forwarded-Proto': 'http',
      } });
      expect(response.status).toBe(409);
      expect(response.headers.get('x-original')).toBe('preserved');
      expect(response.headers.getSetCookie()).toEqual(['a=1; HttpOnly', 'b=2; SameSite=Strict']);
      expect(await response.text()).toBe('raw=bytes');
    });
  });

  it('preserves streaming response data and cancels an unresponsive response at its deadline', async () => {
    let canceled = false;
    let calls = 0;
    const errors: unknown[] = [];
    await withServer(toNodeListener(() => {
      if (calls++ === 0) return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('first')); controller.enqueue(new TextEncoder().encode('second')); controller.close(); },
      }));
      return new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }));
    }, { origin: canonical, responseTimeoutMs: 20, onError: (error) => errors.push(error) }), async (base) => {
      expect(await (await fetch(base + '/stream')).text()).toBe('firstsecond');
      const outcome = await fetch(base + '/stuck').then(async (response) => ({ status: response.status, text: await response.text() }))
        .then((response) => ({ response, error: undefined }), (error: unknown) => ({ response: undefined, error }));
      // If a runtime has already flushed headers it must close the socket; otherwise return a generic error.
      if (outcome.response !== undefined) expect(outcome.response).toEqual({ status: 500, text: 'INTERNAL_ERROR' });
      else expect(outcome.error).toBeDefined();
      expect(canceled).toBe(true);
      expect(errors.length).toBe(1);
    });
  });

  it('aborts the native Request when the client disconnects and removes adapter listeners', async () => {
    let seen: Request | undefined;
    let done: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => { done = resolve; });
    let aborted: (() => void) | undefined;
    const observedAbort = new Promise<void>((resolve) => { aborted = resolve; });
    let incoming: IncomingMessage | undefined;
    let outgoing: ServerResponse | undefined;
    const listener = toNodeListener(async (request) => {
      seen = request;
      await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => { aborted?.(); resolve(); }, { once: true }));
      return new Response(null, { status: 204 });
    }, { origin: canonical });
    await withServer((request, response) => {
      incoming = request; outgoing = response;
      void listener(request, response).finally(() => done?.());
    }, async (base) => {
      const url = new URL(base);
      const client = httpRequest({ hostname: url.hostname, port: url.port, path: '/disconnect', method: 'POST', headers: { 'Content-Length': '999' } });
      client.on('error', () => {});
      client.write('partial');
      // Ensure the server handler received the request before closing the client.
      for (let attempt = 0; seen === undefined && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(seen).toBeDefined();
      client.destroy();
      await observedAbort;
      await completed;
      expect(seen!.signal.aborted).toBe(true);
      expect(incoming!.listenerCount('data')).toBe(0);
      expect(incoming!.listenerCount('aborted')).toBe(0);
      expect(outgoing!.listeners('close').some((listener) => listener.name === 'disconnected')).toBe(false);
    });
  });

  it('disposes request and socket listeners on disconnect even when the host handler never settles', async () => {
    let seen!: Request;
    let incoming!: IncomingMessage; let outgoing!: ServerResponse;
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void; const completed = new Promise<void>((resolve) => { finish = resolve; });
    const listener = toNodeListener((request) => {
      seen = request; started();
      return new Promise<Response>(() => {});
    }, { origin: canonical });
    await withServer((request, response) => {
      incoming = request; outgoing = response;
      void listener(request, response).finally(finish);
    }, async (base) => {
      const url = new URL(base);
      const client = httpRequest({ hostname: url.hostname, port: url.port, path: '/never', method: 'POST', headers: { 'Content-Length': '999' } });
      client.on('error', () => {}); client.write('partial');
      await ready; client.destroy(); await completed;
      expect(seen.signal.aborted).toBe(true);
      expect(incoming.listenerCount('data')).toBe(0);
      expect(incoming.listenerCount('end')).toBe(0);
      expect(incoming.listenerCount('aborted')).toBe(0);
      expect(incoming.listeners('error').some((handler) => handler.name === 'failed' || handler.name === 'error')).toBe(false);
      expect(outgoing.listeners('close').some((handler) => handler.name === 'disconnected')).toBe(false);
      expect(outgoing.listeners('error').some((handler) => handler.name === 'failed')).toBe(false);
    });
  });

  it('cancels a late response body after the disconnected request has already finished cleanup', async () => {
    let seen!: Request;
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void; const completed = new Promise<void>((resolve) => { finish = resolve; });
    let resolveResponse!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const listener = toNodeListener((request) => { seen = request; started(); return pending; }, { origin: canonical });
    await withServer((request, response) => { void listener(request, response).finally(finish); }, async (base) => {
      const url = new URL(base);
      const client = httpRequest({ hostname: url.hostname, port: url.port, path: '/late', method: 'POST', headers: { 'Content-Length': '999' } });
      client.on('error', () => {}); client.write('partial');
      await ready; client.destroy(); await completed;
      let canceled!: (reason: unknown) => void; const cancellation = new Promise<unknown>((resolve) => { canceled = resolve; });
      resolveResponse(new Response(new ReadableStream<Uint8Array>({
        cancel(reason) { canceled(reason); return new Promise<void>(() => {}); },
      })));
      expect(await cancellation).toBe(seen.signal.reason);
      expect(seen.signal.reason.name).toBe('AbortError');
    });
  });

  it('preserves host handler rejection and reports the original error once', async () => {
    const error = new Error('host handler failed'); const errors: unknown[] = [];
    await withServer(toNodeListener(async () => { throw error; }, { origin: canonical, onError: (reason) => errors.push(reason) }), async (base) => {
      const response = await fetch(base + '/error');
      expect(response.status).toBe(500); expect(await response.text()).toBe('INTERNAL_ERROR');
      expect(errors).toEqual([error]);
    });
  });

  it('waits for real socket backpressure without dropping or reordering response chunks', async () => {
    let waits = 0;
    const chunk = new Uint8Array(131_072).fill(65);
    const listener = toNodeListener(() => {
      let remaining = 4;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { if (remaining-- > 0) controller.enqueue(chunk); else controller.close(); },
      }, { highWaterMark: 0 }));
    }, { origin: canonical });
    await withServer((request, response) => {
      const write = response.write.bind(response);
      response.write = ((...args: Parameters<typeof write>) => {
        const accepted = Reflect.apply(write, response, args);
        if (!accepted) waits++;
        return accepted;
      }) as typeof response.write;
      void listener(request, response);
    }, async (base) => {
      const bytes = new Uint8Array(await (await fetch(base + '/large')).arrayBuffer());
      expect(bytes.length).toBe(chunk.length * 4);
      expect(bytes.every((byte) => byte === 65)).toBe(true);
      expect(waits).toBeGreaterThan(0);
    });
  });

  it('rejects body-parser consumption and malformed configuration without invoking business code', async () => {
    let calls = 0;
    const listener = toNodeListener(() => { calls++; return new Response('unexpected'); }, { origin: canonical });
    await withServer((request, response) => {
      request.resume();
      request.once('end', () => { void listener(request, response); });
    }, async (base) => {
      const response = await fetch(base + '/form', { method: 'POST', body: 'already=consumed' });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('RAW_BODY_REQUIRED');
      expect(calls).toBe(0);
    });
    for (const origin of ['https://forms.test/', 'https://forms.test/path', 'ftp://forms.test']) {
      expect(() => toNodeListener(() => new Response(), { origin })).toThrow();
    }
    expect(() => toNodeListener(() => new Response(), { origin: canonical, responseTimeoutMs: 0 })).toThrow();
  });

  it('Fastify route hijacks before raw processing so body parsers cannot consume the request first', async () => {
    const order: string[] = [];
    const route = createFastifyRoute('/form', async (request) => {
      order.push('handler');
      return new Response(await request.text(), { status: 422 });
    }, { origin: canonical });
    expect(route.method).toBe('POST');
    expect(route.url).toBe('/form');
    await withServer((request, response) => {
      void route.onRequest({ raw: request }, { raw: response, hijack() { order.push('hijack'); } });
    }, async (base) => {
      const response = await fetch(base + '/form', { method: 'POST', body: 'original' });
      expect(response.status).toBe(422);
      expect(await response.text()).toBe('original');
      expect(order).toEqual(['hijack', 'handler']);
    });
    expect(() => createFastifyRoute('/form/:id', () => new Response(), { origin: canonical })).toThrow();
  });
});
