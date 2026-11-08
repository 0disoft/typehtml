import type { InputIssue } from '../runtime/input.ts';
import { assertCsrfToken, CsrfError } from '../runtime/csrf.ts';
import { acceptsHtml, assertRequestOrigin, prepareOriginPolicy, NegotiationError } from '../runtime/negotiation.ts';
import { assertFormTransport, WireError, type FormReadLimits } from '../runtime/wire.ts';
import { renderFailure } from './html.ts';
import { IdempotencyError } from './idempotency.ts';
import { consumeRateLimit, RateLimitError, RateLimitUnavailableError } from './security.ts';

type MaybePromise<T> = T | Promise<T>;
export type RawFormValues = Readonly<Record<string, string | readonly string[]>>;
export interface FormContext<Input, Principal> {
  readonly request: Request;
  readonly principal: Readonly<Principal>;
  readonly input: Input;
  readonly requestKey?: string;
}
export interface BoundaryInvalidContext<Principal, Raw = RawFormValues> {
  readonly request: Request;
  readonly principal: Readonly<Principal>;
  readonly rawValues: Raw;
  readonly issues: readonly InputIssue[];
  readonly csrfToken: string;
  readonly requestKey?: string;
}
export interface BoundaryHooks<Input, Output, Principal extends object, Result, Raw = RawFormValues, Projected = Output> {
  readonly allowedOrigins: readonly string[];
  /** Require one _bc_request field and expose it to execute; no store is selected implicitly. */
  readonly acceptRequestKey?: boolean;
  readonly rateLimitTimeoutMs?: number;
  readonly authenticate: (request: Request) => MaybePromise<Principal | null>;
  readonly csrfToken: (context: Readonly<{ request: Request; principal: Readonly<Principal> }>) => MaybePromise<string>;
  /** Omit to retain synchronizer-token comparison; provide to verify signed tokens. */
  readonly verifyCsrf?: (context: Readonly<{ request: Request; principal: Readonly<Principal>; token: string }>) => MaybePromise<boolean>;
  readonly rateLimit?: (context: Readonly<{ request: Request; principal: Readonly<Principal> }>) => MaybePromise<
    Readonly<{ allow: true }> | Readonly<{ allow: false; retryAfterSeconds: number }>>;
  readonly authorize: (context: FormContext<Input, Principal>) => MaybePromise<boolean>;
  /** The host owns transactions and external effects; this callback is never retried. */
  readonly execute: (context: FormContext<Input, Principal>) => MaybePromise<Result>;
  readonly project: (result: Result) => MaybePromise<Projected>;
  readonly success: (output: Output) => MaybePromise<Readonly<{ location: string }>>;
  readonly invalid?: (context: BoundaryInvalidContext<Principal, Raw>) => MaybePromise<string>;
  readonly onError?: (error: unknown, request: Request) => void;
}
export class FormHttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503, readonly code: string) {
    super(code);
    this.name = 'FormHttpError';
  }
}
export type BoundaryValidation<Input> = Readonly<{ ok: true; value: Input }> |
  Readonly<{ ok: false; issues: readonly InputIssue[]; unknownKeys: readonly string[] }>;
export interface FormBoundary<Input, Output, Raw, Projected = Output> {
  readonly path: string;
  readonly limits: FormReadLimits;
  readonly assertTransport?: (request: Request) => void;
  readonly read: (request: Request) => Promise<Readonly<{ csrf: string; raw: Raw; requestKey?: string; dispose?: () => Promise<void>; validate: () => MaybePromise<BoundaryValidation<Input>> }>>;
  readonly validateOutput: (value: Projected, request: Request) => MaybePromise<Output>;
  readonly renderInvalid: (context: BoundaryInvalidContext<object, Raw>) => string;
}
function html(status: number, body: string, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  return new Response(body, { status, headers });
}
function failure(status: number, code: string, extra?: HeadersInit): Response {
  return html(status, renderFailure(status, code), extra);
}
function invoke<Args extends unknown[], Value>(hook: (...args: Args) => Value, receiver: unknown, args: Args): Value {
  return Reflect.apply(hook, receiver, args);
}
async function withRequestCleanup<Value>(run: (register: (dispose?: () => Promise<void>) => void) => Promise<Value>): Promise<Value> {
  let cleanup: (() => Promise<void>) | undefined;
  let failed = false;
  let primary: unknown;
  try { return await run((dispose) => { cleanup = dispose; }); }
  catch (error) { failed = true; primary = error; throw error; }
  finally {
    try { await cleanup?.(); }
    catch (error) {
      if (failed) throw new AggregateError([primary, error], 'form operation and cleanup failed', { cause: primary });
      throw error;
    }
  }
}
/** Both public form APIs share these checks and preserve the legacy hook order. */
export function createBoundaryHandler<Input, Output, Principal extends object, Result, Raw, Projected = Output>(
  boundary: FormBoundary<Input, Output, Raw, Projected>, options: BoundaryHooks<Input, Output, Principal, Result, Raw, Projected>,
): (request: Request) => Promise<Response> {
  const origins = Object.freeze([...options.allowedOrigins]);
  if (origins.length === 0) throw new TypeError('at least one allowed origin is required');
  for (const origin of origins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new TypeError('allowed origins must be serialized HTTP(S) origins');
  }
  const hooks = Object.freeze({
    authenticate: options.authenticate, csrfToken: options.csrfToken, verifyCsrf: options.verifyCsrf,
    rateLimit: options.rateLimit, authorize: options.authorize, execute: options.execute,
    project: options.project, success: options.success, invalid: options.invalid, onError: options.onError,
  });
  const originPolicy = prepareOriginPolicy({ allowedOrigins: origins });
  const rateLimitTimeoutMs = options.rateLimitTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(rateLimitTimeoutMs) || rateLimitTimeoutMs < 1 || rateLimitTimeoutMs > 2_147_483_647) throw new TypeError('invalid rate limit timeout');
  return async (request) => {
    try {
      return await withRequestCleanup(async (registerCleanup) => {
        const url = new URL(request.url);
        if (url.pathname !== boundary.path) return failure(404, 'NOT_FOUND');
        if (request.method !== 'POST') return failure(405, 'METHOD_NOT_ALLOWED', { Allow: 'POST' });
        if (url.search !== '') return failure(400, 'UNEXPECTED_QUERY');
        if (!acceptsHtml(request.headers.get('accept'))) return failure(406, 'NOT_ACCEPTABLE_HTML');
        if (boundary.assertTransport === undefined) assertFormTransport(request, boundary.limits.maxBytes);
        else boundary.assertTransport(request);
        assertRequestOrigin(request, originPolicy);
        const authenticated = await invoke(hooks.authenticate, options, [request]);
        if (authenticated === null) return failure(401, 'UNAUTHENTICATED');
        if (typeof authenticated !== 'object' || Array.isArray(authenticated)) throw new TypeError('authenticate must return a principal object or null');
        const principal = Object.freeze({ ...authenticated });
        if (hooks.rateLimit !== undefined) {
          const rateLimit = hooks.rateLimit;
          const decision = await consumeRateLimit({ consume: () => invoke(rateLimit, options, [{ request, principal }]) }, boundary.path, { signal: request.signal, timeoutMs: rateLimitTimeoutMs });
          if (decision.allow !== true) {
            if (!Number.isSafeInteger(decision.retryAfterSeconds) || decision.retryAfterSeconds < 1) throw new TypeError('invalid retry delay');
            return failure(429, 'RATE_LIMITED', { 'Retry-After': String(decision.retryAfterSeconds) });
          }
        }
        const parsed = await boundary.read(request);
        registerCleanup(parsed.dispose);
        const expected = await invoke(hooks.csrfToken, options, [{ request, principal }]);
        if (typeof expected !== 'string' || expected.length === 0) throw new CsrfError();
        if (hooks.verifyCsrf === undefined) assertCsrfToken(parsed.csrf, expected);
        else if (await invoke(hooks.verifyCsrf, options, [{ request, principal, token: parsed.csrf }]) !== true) throw new CsrfError();
        const validation = await parsed.validate();
        if (!validation.ok && validation.unknownKeys.length > 0) return failure(400, 'UNKNOWN_FIELD');
        if (!validation.ok) {
          const context = Object.freeze({ request, principal, rawValues: parsed.raw, issues: validation.issues, csrfToken: expected, ...(parsed.requestKey === undefined ? {} : { requestKey: parsed.requestKey }) });
          const body = hooks.invalid === undefined ? boundary.renderInvalid(context) : await invoke(hooks.invalid, options, [context]);
          if (typeof body !== 'string') throw new TypeError('invalid renderer must return HTML');
          return html(422, body);
        }
        const context = Object.freeze({ request, principal, input: validation.value, ...(parsed.requestKey === undefined ? {} : { requestKey: parsed.requestKey }) });
        request.signal.throwIfAborted();
        if (await invoke(hooks.authorize, options, [context]) !== true) return failure(404, 'NOT_FOUND');
        // Never start a new effect after an async guard outlives its request.
        request.signal.throwIfAborted();
        const result = await invoke(hooks.execute, options, [context]);
        const projected = await invoke(hooks.project, options, [result]);
        const output = await boundary.validateOutput(projected, request);
        const success = await invoke(hooks.success, options, [output]);
        return html(303, '', { Location: successLocation(success, url.origin) });
      });
    } catch (error) {
      if (error instanceof RateLimitUnavailableError || error instanceof IdempotencyError && error.status === 503) {
        try { if (hooks.onError !== undefined) invoke(hooks.onError, options, [error, request]); } catch { /* Preserve the bounded failure. */ }
        return failure(error.status, error.code);
      }
      if (error instanceof RateLimitError) return failure(429, error.code, { 'Retry-After': String(error.retryAfterSeconds) });
      if (error instanceof WireError || error instanceof NegotiationError || error instanceof CsrfError || error instanceof FormHttpError || error instanceof IdempotencyError || error instanceof RateLimitUnavailableError) {
        return failure(error.status, error.code);
      }
      try { if (hooks.onError !== undefined) invoke(hooks.onError, options, [error, request]); } catch { /* Preserve generic response. */ }
      return failure(500, 'INTERNAL_ERROR');
    }
  };
}
/** Dot-segment normalization must not turn a redirect into a network-path reference. */
export function successLocation(success: Readonly<{ location: string }>, origin: string): string {
  if (success === null || typeof success !== 'object' || typeof success.location !== 'string') throw new TypeError('success must return a location');
  const location = success.location;
  const target = new URL(location, origin);
  const normalized = target.pathname + target.search + target.hash;
  if (target.origin !== origin || !location.startsWith('/') || location.startsWith('//') || normalized.startsWith('//') || /[\r\n\\]/.test(location)) {
    throw new TypeError('success location must be a same-origin absolute path');
  }
  return normalized;
}
