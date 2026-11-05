import { SUPPORTED_CSRF_FIELD, SUPPORTED_REQUEST_KEY_FIELD, type ObjectSchema } from '../contract/types.ts';
import { assertCsrfToken, CsrfError } from '../runtime/csrf.ts';
import { validateBusinessInput, type InputIssue } from '../runtime/input.ts';
import { acceptsHtml, assertRequestOrigin, NegotiationError } from '../runtime/negotiation.ts';
import { validateOutputObject } from '../runtime/output.ts';
import { assertFormTransport, readUrlEncodedForm, WireError } from '../runtime/wire.ts';
import type { DefinedForm, InferSchema } from './definition.ts';
import { renderFailure, renderFormErrors } from './html.ts';

type MaybePromise<T> = T | Promise<T>;

/** Native form submission: invalid input stays on the form; success redirects to a GET. */
const NATIVE_FORM_STATUS = { invalid: 422, success: 303 } as const;

export interface FormContext<Input, Principal> {
  readonly request: Request;
  readonly principal: Readonly<Principal>;
  readonly input: Input;
}

export interface InvalidFormContext<Principal> {
  readonly request: Request;
  readonly principal: Readonly<Principal>;
  readonly rawValues: Readonly<Record<string, string>>;
  readonly issues: readonly InputIssue[];
  readonly csrfToken: string;
}

export interface FormHandlerOptions<I extends ObjectSchema, O extends ObjectSchema, Principal extends object, Result> {
  readonly allowedOrigins: readonly string[];
  readonly authenticate: (request: Request) => MaybePromise<Principal | null>;
  readonly csrfToken: (context: Readonly<{ request: Request; principal: Readonly<Principal> }>) => MaybePromise<string>;
  readonly authorize: (context: FormContext<InferSchema<I>, Principal>) => MaybePromise<boolean>;
  /** The host owns transactions, idempotence, and external effects inside this callback. */
  readonly execute: (context: FormContext<InferSchema<I>, Principal>) => MaybePromise<Result>;
  readonly project: (result: Result) => MaybePromise<InferSchema<O>>;
  readonly success: (output: InferSchema<O>) => MaybePromise<Readonly<{ location: string }>>;
  /** Returned HTML is trusted application code and must encode rawValues for its output contexts. */
  readonly invalid?: (context: InvalidFormContext<Principal>) => MaybePromise<string>;
  readonly onError?: (error: unknown, request: Request) => void;
}

export class FormHttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503, readonly code: string) {
    super(code);
    this.name = 'FormHttpError';
  }
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

type HandlerConfig<I extends ObjectSchema, O extends ObjectSchema, Principal extends object, Result> = Readonly<{
  form: DefinedForm<I, O>;
  hooks: FormHandlerOptions<I, O, Principal, Result>;
  receiver: FormHandlerOptions<I, O, Principal, Result>;
}>;

function invokeHook<Args extends unknown[], Value>(hook: (...args: Args) => Value, receiver: unknown, args: Args): Value {
  return Reflect.apply(hook, receiver, args);
}

/**
 * Native POST boundary for a flat form; callback references are captured at creation.
 * Hooks retain the caller's receiver. No implicit authentication, DB, or replay store.
 */
export function createFormHandler<I extends ObjectSchema, O extends ObjectSchema, Principal extends object, Result>(
  form: DefinedForm<I, O>, options: FormHandlerOptions<I, O, Principal, Result>,
): (request: Request) => Promise<Response> {
  const origins = Object.freeze([...options.allowedOrigins]);
  if (origins.length === 0) throw new TypeError('at least one allowed origin is required');
  for (const origin of origins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new TypeError('allowed origins must be serialized HTTP(S) origins');
  }
  // Copy the callback table without freezing or changing the caller-owned receiver.
  const hooks = Object.freeze({
    allowedOrigins: origins,
    authenticate: options.authenticate, csrfToken: options.csrfToken, authorize: options.authorize,
    execute: options.execute, project: options.project, success: options.success,
    invalid: options.invalid, onError: options.onError,
  });
  const config = { form, hooks, receiver: options };
  return (request) => handleRequest(request, config);
}

/** Request checks have no hooks or body reads, so their precedence is explicit. */
function rejectRequest(request: Request, url: URL, path: string): Response | null {
  if (url.pathname !== path) return failure(404, 'NOT_FOUND');
  if (request.method !== 'POST') return failure(405, 'METHOD_NOT_ALLOWED', { Allow: 'POST' });
  if (url.search !== '') return failure(400, 'UNEXPECTED_QUERY');
  if (!acceptsHtml(request.headers.get('accept'))) return failure(406, 'NOT_ACCEPTABLE_HTML');
  return null;
}

async function handleRequest<I extends ObjectSchema, O extends ObjectSchema, Principal extends object, Result>(
  request: Request, config: HandlerConfig<I, O, Principal, Result>,
): Promise<Response> {
  const { form, hooks, receiver } = config;
  try {
    const url = new URL(request.url);
    const rejected = rejectRequest(request, url, form.path);
    if (rejected !== null) return rejected;
    assertFormTransport(request, form.limits.maxBytes);
    assertRequestOrigin(request, { allowedOrigins: hooks.allowedOrigins });
    const authenticated = await invokeHook(hooks.authenticate, receiver, [request]);
    if (authenticated === null) return failure(401, 'UNAUTHENTICATED');
    if (typeof authenticated !== 'object' || Array.isArray(authenticated)) throw new TypeError('authenticate must return a principal object or null');
    const principal = Object.freeze({ ...authenticated });
    const parsed = await readUrlEncodedForm(request, {
      ...form.limits, csrfField: SUPPORTED_CSRF_FIELD, requestKeyField: SUPPORTED_REQUEST_KEY_FIELD, expectRequestKey: false,
    });
    const expected = await invokeHook(hooks.csrfToken, receiver, [{ request, principal }]);
    if (typeof expected !== 'string' || expected.length === 0) throw new CsrfError();
    assertCsrfToken(parsed.csrf, expected);
    const validation = validateBusinessInput(form.input, parsed.fields);
    if (!validation.ok && validation.unknownKeys.length > 0) return failure(400, 'UNKNOWN_FIELD');
    if (!validation.ok) return await invalidResponse(Object.freeze({
      request, principal, rawValues: parsed.fields, issues: validation.issues, csrfToken: expected,
    }), config);
    const context = Object.freeze({ request, principal, input: validation.value as InferSchema<I> });
    if (await invokeHook(hooks.authorize, receiver, [context]) !== true) return failure(404, 'NOT_FOUND');
    return await completeForm(context, url, config);
  } catch (error) {
    return errorResponse(error, request, hooks.onError, receiver);
  }
}

async function invalidResponse<I extends ObjectSchema, O extends ObjectSchema, Principal extends object, Result>(
  context: InvalidFormContext<Principal>, config: HandlerConfig<I, O, Principal, Result>,
): Promise<Response> {
  const { form, hooks, receiver } = config;
  const body = hooks.invalid === undefined
    ? renderFormErrors(form.path, form.input.schema, context.rawValues, context.issues, context.csrfToken)
    : await invokeHook(hooks.invalid, receiver, [context]);
  if (typeof body !== 'string') throw new TypeError('invalid renderer must return HTML');
  return html(NATIVE_FORM_STATUS.invalid, body);
}

async function completeForm<I extends ObjectSchema, O extends ObjectSchema, Principal extends object, Result>(
  context: FormContext<InferSchema<I>, Principal>, url: URL, config: HandlerConfig<I, O, Principal, Result>,
): Promise<Response> {
  const { form, hooks, receiver } = config;
  const result = await invokeHook(hooks.execute, receiver, [context]);
  const projected = await invokeHook(hooks.project, receiver, [result]);
  const output = validateOutputObject(form.output, projected) as InferSchema<O>;
  const success = await invokeHook(hooks.success, receiver, [output]);
  return html(NATIVE_FORM_STATUS.success, '', { Location: successLocation(success, url.origin) });
}

/** Pure redirect calculation; it neither modifies nor returns the caller's object. */
function successLocation(success: Readonly<{ location: string }>, origin: string): string {
  if (success === null || typeof success !== 'object' || typeof success.location !== 'string') throw new TypeError('success must return a location');
  const location = success.location;
  const target = new URL(location, origin);
  const normalized = target.pathname + target.search + target.hash;
  // Dot-segment normalization can turn an absolute path into a network-path reference.
  if (target.origin !== origin || !location.startsWith('/') || location.startsWith('//') ||
      normalized.startsWith('//') || /[\r\n\\]/.test(location)) {
    throw new TypeError('success location must be a same-origin absolute path');
  }
  return normalized;
}

function errorResponse(error: unknown, request: Request, onError: ((error: unknown, request: Request) => void) | undefined, receiver: unknown): Response {
  if (error instanceof WireError || error instanceof NegotiationError || error instanceof CsrfError || error instanceof FormHttpError) {
    return failure(error.status, error.code);
  }
  try { if (onError !== undefined) invokeHook(onError, receiver, [error, request]); } catch { /* Logging must not replace the generic response. */ }
  return failure(500, 'INTERNAL_ERROR');
}
