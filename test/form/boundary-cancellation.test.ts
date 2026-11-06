import { expect, test } from 'bun:test';
import { defineForm, createFormHandler } from '../../src/index.ts';

const form = defineForm({ id: 'cancel.save', path: '/form',
  input: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
  output: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
});

for (const stage of ['verifyCsrf', 'authorize'] as const) {
  test(`does not start a business effect after cancellation during async ${stage}`, async () => {
    const controller = new AbortController(); const reason = new Error('client disconnected');
    let enter!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: (value: boolean) => void; const paused = new Promise<boolean>((resolve) => { release = resolve; });
    let executions = 0; let failure: unknown;
    const handle = createFormHandler(form, {
      allowedOrigins: ['https://app.test'], authenticate: () => ({ id: 'p' }), csrfToken: () => 'token',
      verifyCsrf: stage === 'verifyCsrf' ? () => { enter(); return paused; } : () => true,
      authorize: stage === 'authorize' ? () => { enter(); return paused; } : () => true,
      execute: () => { executions++; return { name: 'saved' }; }, project: (value) => value,
      success: () => ({ location: '/done' }), onError: (error) => { failure = error; },
    });
    const request = new Request('https://app.test/form', { method: 'POST', signal: controller.signal,
      headers: { origin: 'https://app.test', 'content-type': 'application/x-www-form-urlencoded' },
      body: '_bc_csrf=token&name=Ada',
    });
    const pending = handle(request); await entered; controller.abort(reason); release(true);
    const response = await pending;
    expect(executions).toBe(0); expect(response.status).toBe(500); expect(failure).toBe(reason);
  });
}

test('finishes a business effect already started before cancellation without retrying it', async () => {
  const controller = new AbortController(); let executions = 0;
  const handle = createFormHandler(form, { allowedOrigins: ['https://app.test'], authenticate: () => ({}), csrfToken: () => 'token', authorize: () => true,
    execute: () => { executions++; controller.abort(); return { name: 'committed' }; }, project: (value) => value, success: () => ({ location: '/done' }) });
  const response = await handle(new Request('https://app.test/form', { method: 'POST', signal: controller.signal,
    headers: { origin: 'https://app.test', 'content-type': 'application/x-www-form-urlencoded' }, body: '_bc_csrf=token&name=Ada' }));
  expect(response.status).toBe(303); expect(executions).toBe(1);
});
