import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineSchemaForm } from '../../src/form/schema-form.ts';
import { validateSchemaFormInput } from '../../src/form/validation.ts';
import type { FormReadLimits } from '../../src/runtime/wire.ts';
import type { StandardSchemaV1 } from '../../src/form/standard-schema.ts';

function fixture(limits: Partial<FormReadLimits> = {}, validation?: StandardSchemaV1<unknown, unknown>['~standard']['validate']) {
  let inputCalls = 0;
  let outputCalls = 0;
  const input: StandardSchemaV1<unknown, unknown> = { '~standard': { version: 1, vendor: 'test', validate(value, options) { inputCalls++; return validation?.(value, options) ?? { value }; } } };
  const output: StandardSchemaV1<unknown, unknown> = { '~standard': { version: 1, vendor: 'test', validate(value) { outputCalls++; return { value }; } } };
  const form = defineSchemaForm({ id: 'preview.edit', path: '/preview', fields: {
    name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, count: { type: 'integer', minimum: 1, maximum: 2 },
  }, input, output, limits });
  return { form, inputCalls: () => inputCalls, outputCalls: () => outputCalls };
}

describe('validation-only schema input preview', () => {
  it('runs only the input validator, preserves ordered values, and requires no CSRF/request-key fields', async () => {
    const subject = fixture();
    let executions = 0;
    const entries = Object.freeze([{ key: 'name', value: 'Ada' }, { key: 'tags', value: 'b' }, { key: 'tags', value: 'a' }, { key: 'tags', value: 'b' }].map((entry) => Object.freeze(entry)));
    const result = await validateSchemaFormInput(subject.form, entries, {
      // @ts-expect-error A preview has no operation/handler configuration.
      execute: () => { executions++; },
    });
    expect(result).toEqual({ ok: true, value: { name: 'Ada', tags: ['b', 'a', 'b'] } });
    expect(subject.inputCalls()).toBe(1);
    expect(subject.outputCalls()).toBe(0);
    expect(executions).toBe(0);
    expect(entries.map(({ value }) => value)).toEqual(['Ada', 'b', 'a', 'b']);
  });

  it('returns codec/unknown-field issues before vendor validation and preserves transformed output typing', async () => {
    const subject = fixture();
    for (const count of ['0', '3']) expect((await validateSchemaFormInput(subject.form, [{ key: 'count', value: count }])).ok).toBe(false);
    const unknown = await validateSchemaFormInput(subject.form, [{ key: 'other', value: 'x' }]);
    expect(unknown).toMatchObject({ ok: false, unknownKeys: ['other'] });
    expect(subject.inputCalls()).toBe(0);
    const typed = defineSchemaForm({ id: 'typed.preview', path: '/typed', fields: { name: { type: 'string' } }, input: z.object({ name: z.string().transform((value) => value.length) }), output: z.unknown() });
    const result = await validateSchemaFormInput(typed, [{ key: 'name', value: 'Ada' }]);
    if (!result.ok) throw new Error('expected transformed preview');
    const length: number = result.value.name;
    expect(length).toBe(3);
  });

  it('enforces entry/key/value limits at their exact boundary including UTF-8 bytes', async () => {
    const subject = fixture({ maxEntries: 2, maxKeyBytes: 4, maxValueBytes: 4 });
    await expect(validateSchemaFormInput(subject.form, [{ key: 'name', value: '😀' }])).resolves.toMatchObject({ ok: true });
    await expect(validateSchemaFormInput(subject.form, [{ key: 'name', value: '😀a' }])).rejects.toMatchObject({ status: 413, code: 'VALUE_TOO_LARGE' });
    await expect(validateSchemaFormInput(subject.form, [{ key: 'names', value: 'x' }])).rejects.toMatchObject({ status: 413, code: 'KEY_TOO_LARGE' });
    await expect(validateSchemaFormInput(subject.form, [{ key: 'tags', value: 'a' }, { key: 'tags', value: 'b' }])).resolves.toMatchObject({ ok: true });
    await expect(validateSchemaFormInput(subject.form, [{ key: 'tags', value: 'a' }, { key: 'tags', value: 'b' }, { key: 'tags', value: 'c' }])).rejects.toMatchObject({ status: 413, code: 'TOO_MANY_ENTRIES' });
  });

  it('bounds the canonical wire body immediately below, at, and above its threshold', async () => {
    const ascii = fixture({ maxBytes: 6 });
    for (const value of ['', 'a']) await expect(validateSchemaFormInput(ascii.form, [{ key: 'name', value }])).resolves.toMatchObject({ ok: true });
    await expect(validateSchemaFormInput(ascii.form, [{ key: 'name', value: 'ab' }])).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    const utf8 = fixture({ maxBytes: 11 });
    expect(new URLSearchParams([['name', 'é']]).toString().length).toBe(11);
    await expect(validateSchemaFormInput(utf8.form, [{ key: 'name', value: 'é' }])).resolves.toMatchObject({ ok: true });
    await expect(validateSchemaFormInput(utf8.form, [{ key: 'name', value: 'ée' }])).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    const separator = fixture({ maxBytes: 11 });
    await expect(validateSchemaFormInput(separator.form, [{ key: 'tags', value: '' }, { key: 'tags', value: '' }])).resolves.toMatchObject({ ok: true });
    await expect(validateSchemaFormInput(separator.form, [{ key: 'tags', value: '' }, { key: 'tags', value: 'a' }])).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
  });

  it('rejects reserved/malformed input, NUL and unrepresentable Unicode without invoking the validator', async () => {
    const subject = fixture();
    for (const key of ['_bc_csrf', '__proto__', 'user.__proto__.x', 'items[01]']) await expect(validateSchemaFormInput(subject.form, [{ key, value: 'x' }])).rejects.toMatchObject({ status: 400, code: 'INVALID_KEY' });
    for (const value of ['\u0000', '\ud800']) await expect(validateSchemaFormInput(subject.form, [{ key: 'name', value }])).rejects.toMatchObject({ status: 400 });
    await expect(validateSchemaFormInput(subject.form, [{ key: 'name', value: 1 }] as never)).rejects.toBeInstanceOf(TypeError);
    expect(subject.inputCalls()).toBe(0);
  });

  it('propagates cancellation and original validator exceptions without execution or output validation', async () => {
    const controller = new AbortController();
    const reason = new Error('preview cancelled');
    const subject = fixture({}, () => new Promise<never>(() => {}));
    const running = validateSchemaFormInput(subject.form, [], { signal: controller.signal });
    await Promise.resolve(); controller.abort(reason);
    await expect(running).rejects.toBe(reason);
    expect(subject.outputCalls()).toBe(0);
    const before = fixture();
    await expect(validateSchemaFormInput(before.form, [], { signal: controller.signal })).rejects.toBe(reason);
    expect(before.inputCalls()).toBe(0);
    const original = new Error('validator failure');
    const broken = fixture({}, () => { throw original; });
    await expect(validateSchemaFormInput(broken.form, [])).rejects.toBe(original);
    expect(broken.outputCalls()).toBe(0);
  });

  it('reports required uploads without accepting arbitrary file references or touching temporary storage', async () => {
    let calls = 0;
    const form = defineSchemaForm({ id: 'file.preview', path: '/file', fields: { name: { type: 'string' } }, uploads: { document: { required: true } }, multipart: {}, input: {
      '~standard': { version: 1, vendor: 'test', validate: (value) => { calls++; return { value }; } },
    }, output: z.unknown() });
    const result = await validateSchemaFormInput(form, [{ key: 'name', value: 'Ada' }]);
    expect(result).toMatchObject({ ok: false, issues: [{ field: 'document', code: 'REQUIRED' }] });
    expect(calls).toBe(0);
  });
});
