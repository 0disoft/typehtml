import type { InputIssue } from '../runtime/input.ts';

/** Structural Standard Schema v1 interface; no validator library is bundled. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown, options?: Options | undefined) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  interface Options { readonly libraryOptions?: Record<string, unknown> | undefined }
  interface Types<Input = unknown, Output = Input> { readonly input: Input; readonly output: Output }
  type Result<Output> = SuccessResult<Output> | FailureResult;
  interface SuccessResult<Output> { readonly value: Output; readonly issues?: undefined }
  interface FailureResult { readonly issues: readonly Issue[] }
  interface Issue { readonly message: string; readonly path?: readonly (PropertyKey | PathSegment)[] | undefined }
  interface PathSegment { readonly key: PropertyKey }
  type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['input'];
  type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['output'];
}

export type InferStandardInput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferInput<Schema>;
export type InferStandardOutput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<Schema>;
export type AnyStandardSchema = StandardSchemaV1<unknown, unknown>;

export interface StandardValidationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly libraryOptions?: Record<string, unknown>;
}

export class StandardValidationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Standard Schema validation exceeded ${timeoutMs}ms`);
    this.name = 'StandardValidationTimeoutError';
  }
}

function propertyKey(value: unknown): value is PropertyKey {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'symbol';
}

function copyIssue(issue: unknown): StandardSchemaV1.Issue {
  if (issue === null || typeof issue !== 'object' || !('message' in issue) || typeof issue.message !== 'string') {
    throw new TypeError('Standard Schema returned an invalid issue');
  }
  if (!('path' in issue) || issue.path === undefined) return Object.freeze({ message: issue.message });
  if (!Array.isArray(issue.path)) throw new TypeError('Standard Schema returned an invalid issue path');
  const path = issue.path.map((segment: unknown) => {
    if (propertyKey(segment)) return segment;
    if (segment !== null && typeof segment === 'object' && 'key' in segment && propertyKey(segment.key)) {
      return Object.freeze({ key: segment.key });
    }
    throw new TypeError('Standard Schema returned an invalid issue path segment');
  });
  return Object.freeze({ message: issue.message, path: Object.freeze(path) });
}

/**
 * Validate an isolated clone of form data. Errors and cancellation reasons pass through unchanged.
 * The deadline bounds awaiting an async validator; the standard cannot stop vendor work or blocking JS.
 * Custom refinements/transforms are runtime-only and imply no Doctor coverage.
 */
export async function validateStandard<Schema extends StandardSchemaV1>(
  schema: Schema, value: unknown, options: StandardValidationOptions = {},
): Promise<StandardSchemaV1.Result<InferStandardOutput<Schema>>> {
  const { signal, libraryOptions } = options;
  signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError('validation timeout must be an integer between 1 and 2147483647ms');
  }
  const props = schema?.['~standard'];
  if (props?.version !== 1 || typeof props.vendor !== 'string' || typeof props.validate !== 'function') {
    throw new TypeError('expected a Standard Schema v1 validator');
  }
  const validate = props.validate;
  const input = structuredClone(value);
  const deadline = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const pending = Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return Reflect.apply(validate, props, [input, libraryOptions === undefined ? undefined : { libraryOptions }]);
    });
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StandardValidationTimeoutError(timeoutMs)), timeoutMs);
      abort = () => reject(signal!.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    const result: unknown = await Promise.race([pending, stopped]);
    signal?.throwIfAborted();
    if (performance.now() >= deadline) throw new StandardValidationTimeoutError(timeoutMs);
    if (result === null || typeof result !== 'object') throw new TypeError('Standard Schema returned an invalid result');
    if ('issues' in result && result.issues !== undefined) {
      if (!Array.isArray(result.issues)) throw new TypeError('Standard Schema returned invalid issues');
      return Object.freeze({ issues: Object.freeze(result.issues.map(copyIssue)) });
    }
    if (!Object.hasOwn(result, 'value')) throw new TypeError('Standard Schema success is missing its value');
    return Object.freeze({ value: (result as { value: InferStandardOutput<Schema> }).value });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal?.removeEventListener('abort', abort);
  }
}

/** Convert standard paths to native field names, retaining form-level issues as null. */
export function standardIssuesToInputIssues(issues: readonly StandardSchemaV1.Issue[]): readonly InputIssue[] {
  return Object.freeze(issues.map((issue) => {
    let field = '';
    for (const segment of issue.path ?? []) {
      const key = typeof segment === 'object' ? segment.key : segment;
      if (typeof key === 'symbol') { field = ''; break; }
      field += typeof key === 'number' ? `[${key}]` : `${field === '' ? '' : '.'}${key}`;
    }
    return Object.freeze({ field: field === '' ? null : field, code: 'SCHEMA', message: issue.message });
  }));
}
