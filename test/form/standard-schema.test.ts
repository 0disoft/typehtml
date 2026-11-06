import { describe, expect, it } from 'bun:test';
import {
  StandardValidationTimeoutError, standardIssuesToInputIssues, validateStandard,
  type StandardSchemaV1, type InferStandardOutput,
} from '../../src/form/standard-schema.ts';

function schema<T>(validate: StandardSchemaV1.Props<unknown, T>['validate']): StandardSchemaV1<unknown, T> {
  return { '~standard': { version: 1, vendor: 'test', validate } };
}

describe('Standard Schema form validation', () => {
  it('accepts sync transforms and async validators, infers output and preserves receiver', async () => {
    const convert = schema((value) => ({ value: Number(value) }));
    const typed: InferStandardOutput<typeof convert> = 42;
    // @ts-expect-error output is inferred as number
    const wrong: InferStandardOutput<typeof convert> = '42';
    expect(await validateStandard(convert, '42')).toEqual({ value: typed });
    void wrong;
    const object = { '~standard': {
      version: 1 as const, vendor: 'receiver',
      async validate(this: { vendor: string }, value: unknown, options?: StandardSchemaV1.Options) {
        return { value: `${this.vendor}:${value}:${options?.libraryOptions?.locale}` };
      },
    } };
    expect(await validateStandard(object, 'value', { libraryOptions: { locale: 'ko' } })).toEqual({ value: 'receiver:value:ko' });
  });

  it('isolates caller input and failure paths without freezing vendor-owned objects', async () => {
    const input = { items: ['original'] };
    const issue = { message: 'invalid', path: ['items', { key: 0 }] };
    const result = await validateStandard(schema((value) => {
      (value as typeof input).items.push('changed');
      return { issues: [issue] };
    }), input);
    expect(input).toEqual({ items: ['original'] });
    issue.message = 'changed';
    issue.path.push('extra');
    expect(result).toEqual({ issues: [{ message: 'invalid', path: ['items', { key: 0 }] }] });
    expect(Object.isFrozen(issue)).toBe(false);
    if (result.issues !== undefined) expect(Object.isFrozen(result.issues[0]?.path)).toBe(true);
  });

  it('preserves thrown errors and exact pre-aborted and in-flight cancellation reasons', async () => {
    const cause = new Error('database failed');
    await expect(validateStandard(schema(() => { throw cause; }), {})).rejects.toBe(cause);
    const pre = new AbortController();
    pre.abort(cause);
    let calls = 0;
    await expect(validateStandard(schema(() => { calls++; return { value: true }; }), {}, { signal: pre.signal })).rejects.toBe(cause);
    expect(calls).toBe(0);
    const during = new AbortController();
    const pending = validateStandard(schema(() => new Promise<never>(() => {})), {}, { signal: during.signal });
    during.abort(cause);
    await expect(pending).rejects.toBe(cause);
  });

  it('bounds unresponsive validators and rejects invalid timeout boundaries', async () => {
    for (const timeoutMs of [0, -1, 0.5, Infinity, NaN, 2_147_483_648]) {
      await expect(validateStandard(schema(() => ({ value: true })), {}, { timeoutMs })).rejects.toBeInstanceOf(TypeError);
    }
    await expect(validateStandard(schema(() => new Promise<never>(() => {})), {}, { timeoutMs: 5 })).rejects.toBeInstanceOf(StandardValidationTimeoutError);
    expect(await validateStandard(schema(() => ({ value: 'ok' })), {}, { timeoutMs: 2_147_483_647 })).toEqual({ value: 'ok' });
  });

  it('removes listeners after success, failure, cancellation and timeout', async () => {
    for (const mode of ['success', 'failure', 'cancel', 'timeout']) {
      const controller = new AbortController();
      let added = 0;
      let removed = 0;
      const add = controller.signal.addEventListener.bind(controller.signal);
      const remove = controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.addEventListener = ((...args: Parameters<typeof add>) => { added++; add(...args); }) as typeof add;
      controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => { removed++; remove(...args); }) as typeof remove;
      const pending = validateStandard(schema(() => {
        if (mode === 'failure') throw new Error('fail');
        return mode === 'success' ? { value: true } : new Promise<never>(() => {});
      }), {}, { signal: controller.signal, timeoutMs: 5 });
      if (mode === 'cancel') controller.abort('stop');
      try { await pending; } catch { /* all cleanup paths are under test */ }
      expect(added).toBe(1);
      expect(removed).toBe(1);
    }
  });

  it('rejects malformed schema/results and maps nested paths without losing form errors', async () => {
    for (const invalid of [{}, { '~standard': { version: 2, vendor: 'bad', validate() {} } }]) {
      await expect(validateStandard(invalid as unknown as StandardSchemaV1, {})).rejects.toBeInstanceOf(TypeError);
    }
    for (const result of [null, {}, { issues: null }, { issues: [{ message: 1 }] }, { issues: [{ message: 'bad', path: [{}] }] }]) {
      await expect(validateStandard(schema(() => result as never), {})).rejects.toBeInstanceOf(TypeError);
    }
    expect(standardIssuesToInputIssues([
      { message: 'nested', path: ['items', { key: 0 }, { key: 'name' }] },
      { message: 'form' }, { message: 'symbol', path: [Symbol('private')] },
    ])).toEqual([
      { field: 'items[0].name', code: 'SCHEMA', message: 'nested' },
      { field: null, code: 'SCHEMA', message: 'form' },
      { field: null, code: 'SCHEMA', message: 'symbol' },
    ]);
  });
});
