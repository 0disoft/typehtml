import type { ObjectSchema } from '../contract/types.ts';
import { assertCsrfToken, CsrfError } from '../runtime/csrf.ts';
import { validateBusinessInput, type InputIssue } from '../runtime/input.ts';
import { acceptsHtml, assertRequestOrigin, NegotiationError } from '../runtime/negotiation.ts';
import { validateOutputObject } from '../runtime/output.ts';
import { assertFormTransport, readUrlEncodedForm, WireError } from '../runtime/wire.ts';
import type { DefinedForm, InferSchema } from './definition.ts';
import { renderFailure, renderFormErrors } from './html.ts';

type MaybePromise<T> = T | Promise<T>;

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

/** Native POST boundary for any supported flat form; no implicit authentication, DB, or replay store. */
export function createFormHandler<I extends ObjectSchema, O extends ObjectSchema, Principal extends object, Result>(
  form: DefinedForm<I, O>, options: FormHandlerOptions<I, O, Principal, Result>,
): (request: Request) => Promise<Response> {
  const origins = Object.freeze([...options.allowedOrigins]);
  if (origins.length === 0) throw new TypeError('at least one allowed origin is required');
  for (const origin of origins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new TypeError('allowed origins must be serialized HTTP(S) origins');
  }
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (url.pathname !== form.path) return html(404, renderFailure(404, 'NOT_FOUND'));
      if (request.method !== 'POST') return html(405, renderFailure(405, 'METHOD_NOT_ALLOWED'), { Allow: 'POST' });
      if (url.search !== '') return html(400, renderFailure(400, 'UNEXPECTED_QUERY'));
      if (!acceptsHtml(request.headers.get('accept'))) return html(406, renderFailure(406, 'NOT_ACCEPTABLE_HTML'));
      assertFormTransport(request, form.limits.maxBytes);
      assertRequestOrigin(request, { allowedOrigins: origins });
      const authenticated = await options.authenticate(request);
      if (authenticated === null) return html(401, renderFailure(401, 'UNAUTHENTICATED'));
      if (typeof authenticated !== 'object' || Array.isArray(authenticated)) throw new TypeError('authenticate must return a principal object or null');
      const principal = Object.freeze({ ...authenticated });
      const parsed = await readUrlEncodedForm(request, {
        ...form.limits, csrfField: '_bc_csrf', requestKeyField: '_bc_request', expectRequestKey: false,
      });
      const expected = await options.csrfToken({ request, principal });
      if (typeof expected !== 'string' || expected.length === 0) throw new CsrfError();
      assertCsrfToken(parsed.csrf, expected);
      const validation = validateBusinessInput(form.input, parsed.fields);
      if (!validation.ok) {
        if (validation.unknownKeys.length > 0) return html(400, renderFailure(400, 'UNKNOWN_FIELD'));
        const context = Object.freeze({ request, principal, rawValues: parsed.fields, issues: validation.issues, csrfToken: expected });
        const body = options.invalid === undefined
          ? renderFormErrors(form.path, form.input.schema, parsed.fields, validation.issues, expected)
          : await options.invalid(context);
        if (typeof body !== 'string') throw new TypeError('invalid renderer must return HTML');
        return html(422, body);
      }
      const context = Object.freeze({ request, principal, input: validation.value as InferSchema<I> });
      if (await options.authorize(context) !== true) return html(404, renderFailure(404, 'NOT_FOUND'));
      const result = await options.execute(context);
      const projected = await options.project(result);
      const output = validateOutputObject(form.output, projected) as InferSchema<O>;
      const success = await options.success(output);
      if (success === null || typeof success !== 'object' || typeof success.location !== 'string') throw new TypeError('success must return a location');
      const target = new URL(success.location, url.origin);
      if (target.origin !== url.origin || !success.location.startsWith('/') || success.location.startsWith('//') || /[\r\n\\]/.test(success.location)) throw new TypeError('success location must be a same-origin absolute path');
      return html(303, '', { Location: target.pathname + target.search + target.hash });
    } catch (error) {
      if (error instanceof WireError || error instanceof NegotiationError || error instanceof CsrfError || error instanceof FormHttpError) {
        return html(error.status, renderFailure(error.status, error.code));
      }
      try { options.onError?.(error, request); } catch { /* Logging must not replace the generic response. */ }
      return html(500, renderFailure(500, 'INTERNAL_ERROR'));
    }
  };
}
