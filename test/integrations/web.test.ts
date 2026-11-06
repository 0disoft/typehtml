import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { toAstro, toHono, toReactRouter, toSvelteKit } from '../../src/integrations/web.ts';

describe('native web framework adapters', () => {
  it('works as a real Hono route without changing native response status/headers', async () => {
    const app = new Hono();
    app.post('/form', toHono(async (request) => new Response(await request.text(), {
      status: 422, headers: { 'Cache-Control': 'private, no-store', 'X-Test': 'original' },
    })));
    const response = await app.request('/form', { method: 'POST', body: 'name=hello' });
    expect(response.status).toBe(422);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-test')).toBe('original');
    expect(await response.text()).toBe('name=hello');
  });

  it('forwards the exact Request and Response for Astro, React Router and SvelteKit endpoints', async () => {
    for (const adapt of [toAstro, toReactRouter, toSvelteKit]) {
      const controller = new AbortController();
      const request = new Request('https://forms.test/form', { signal: controller.signal });
      const response = new Response(null, { status: 303, headers: { Location: '/receipt', 'Set-Cookie': 'x=1; HttpOnly' } });
      const handle = adapt((actual) => {
        expect(actual).toBe(request);
        expect(actual.signal.aborted).toBe(true);
        return response;
      });
      controller.abort('cancel');
      expect(await handle({ request })).toBe(response);
    }
  });

  it('propagates handler errors without hiding original causes', async () => {
    const cause = new Error('host failure');
    const request = new Request('https://forms.test/form');
    await expect(toHono(() => { throw cause; })({ req: { raw: request } })).rejects.toBe(cause);
    await expect(toAstro(async () => { throw cause; })({ request })).rejects.toBe(cause);
  });
});
