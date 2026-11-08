import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defineSchemaForm, createSchemaFormHandler, createTemporaryUploadStore,
  createFormState, renderNativeForm, validateSchemaFormInput,
  createCollectionRows, appendCollectionRow, moveCollectionRow,
  schemaFormWireManifest, defineWireForm, projectWireForm,
} from '@0disoft/typehtml';
import * as capture from '@0disoft/typehtml/adapters/capture';
import * as react from '@0disoft/typehtml/adapters/react';
import * as svelte from '@0disoft/typehtml/adapters/svelte';

const identity = { '~standard': { version: 1, vendor: 'installed-probe', validate: (value) => ({ value }) } };
const form = defineSchemaForm({ id: 'rich.save', path: '/save',
  fields: { 'profile.name': { type: 'string', required: true, minLength: 2 }, tags: { type: 'array', maxItems: 3, items: { type: 'string' } }, enabled: { type: 'boolean' } },
  collections: { items: { maxItems: 3, rowKey: 'key', fields: { key: { type: 'string', required: true, minLength: 1, maxLength: 64 }, quantity: { type: 'integer', required: true, minimum: 1, maximum: 3 } } } },
  uploads: { attachment: { required: true } },
  multipart: { maxBytes: 4096, maxFileBytes: 4, maxTotalFileBytes: 4, maxFiles: 1, maxParts: 16 },
  input: identity, output: identity,
});
const directory = await mkdtemp(join(tmpdir(), 'typehtml-installed-rich-'));
try {
  let executed = 0;
  let retained;
  const handler = createSchemaFormHandler(form, {
    uploadStore: createTemporaryUploadStore({ directory }), allowedOrigins: ['https://app.test'],
    authenticate: () => ({}), csrfToken: () => 'token', authorize: () => true,
    execute: async ({ input }) => {
      executed++;
      assert.deepEqual([...input.tags], ['b', 'a', 'b']);
      assert.equal(input.enabled, false);
      assert.equal(input.profile.name, 'Ada');
      assert.equal(input.items[0].quantity, 2);
      retained = input.attachment;
      assert.equal(await new Response(retained.stream()).text(), '1234');
      return { saved: true };
    }, project: (value) => value, success: () => ({ location: '/done' }),
  });
  const request = (quantity = '2', bytes = '1234', duplicateRow = false) => {
    const data = new FormData();
    for (const [key, value] of [['_bc_csrf', 'token'], ['profile.name', 'Ada'], ['tags', 'b'], ['tags', 'a'], ['tags', 'b'], ['items[0].key', 'row-a'], ['items[0].quantity', quantity]]) data.append(key, value);
    if (duplicateRow) { data.append('items[1].key', 'row-a'); data.append('items[1].quantity', '1'); }
    data.append('attachment', new File([bytes], 'upload.txt', { type: 'text/plain' }));
    return new Request('https://app.test/save', { method: 'POST', headers: { origin: 'https://app.test', accept: 'text/html' }, body: data });
  };
  assert.equal((await handler(request())).status, 303);
  assert.equal(executed, 1);
  assert.deepEqual(await readdir(directory), []);
  assert.throws(() => retained.stream(), /lifetime/);
  const invalid = await handler(request('4'));
  assert.equal(invalid.status, 422);
  const html = await invalid.text();
  assert.ok(html.includes('value="4"') && html.includes('multipart/form-data'));
  assert.ok(!/<input[^>]*type="file"[^>]*value=/.test(html));
  assert.equal((await handler(request('2', '12345'))).status, 413);
  assert.equal((await handler(request('2', '1234', true))).status, 422);
  assert.equal(executed, 1);
  assert.deepEqual(await readdir(directory), []);
  const preview = await validateSchemaFormInput(form, [{ key: 'profile.name', value: 'Ada' }]);
  assert.equal(preview.ok, false); // Required files are supplied only by a real request.
  const state = createFormState({ 'profile.name': 'A', tags: ['b', 'a', 'b'] }, [{ field: 'profile.name', code: 'MIN_LENGTH', message: 'Too short' }]);
  const rendered = renderNativeForm(form, 'token', { state });
  assert.ok(rendered.includes('data-typehtml-error-summary') && rendered.includes('aria-invalid="true"'));
  const rows = createCollectionRows([{ key: 'a', value: 1 }], 3);
  const appended = appendCollectionRow(rows, { key: 'b', value: 2 }, 3);
  assert.deepEqual(moveCollectionRow(appended, 'b', 0).map(({ key }) => key), ['b', 'a']);
  assert.deepEqual(rows.map(({ key }) => key), ['a']);
  const wire = schemaFormWireManifest(form);
  const projection = projectWireForm(defineWireForm(wire), { sourcePath: 'form.json', sourceSha256: '0'.repeat(64) });
  assert.equal(projection.action.encoding, 'multipart');
  assert.equal(projection.runtimeValidationCoverage, 'not-statically-analyzed');
  assert.equal(typeof capture.collectHonoHtml, 'function');
  assert.equal(typeof react.createReactSubmissionHook, 'function');
  assert.equal(typeof svelte.connectSvelteSubmission, 'function');
  console.log(JSON.stringify({ passed: true, executed, boundedUploads: true, disposed: true }));
} finally { await rm(directory, { recursive: true, force: true }); }
