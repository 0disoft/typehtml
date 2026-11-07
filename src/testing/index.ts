export type FormTestHandler = (request: Request) => Response | Promise<Response>;
export type FormTestTarget = Readonly<{ path: string }>;
export type FormTestEntries = URLSearchParams | readonly (readonly [string, string])[];

interface CommonRequestOptions {
  /** An exact http(s) origin. No network request is sent by these helpers. */
  readonly origin?: string;
  readonly headers?: HeadersInit;
  readonly method?: string;
  readonly signal?: AbortSignal;
  /** Set false to exercise missing-Origin rejection. Explicit headers are still retained. */
  readonly sendOrigin?: boolean;
}
export type FormRequestOptions = CommonRequestOptions & (
  | { readonly entries?: FormTestEntries; readonly csrfToken?: string; readonly requestKey?: string; readonly rawBody?: never }
  | { readonly rawBody: string; readonly entries?: never; readonly csrfToken?: never; readonly requestKey?: never }
);

const DEFAULT_TEST_ORIGIN = 'https://typehtml.test';

function exactOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw new TypeError('test origin must be an exact http(s) origin');
  return value;
}

/** Build the real wire request, preserving duplicate/unknown entries for negative tests. */
export function createFormRequest(form: FormTestTarget, options: FormRequestOptions = {}): Request {
  const origin = exactOrigin(options.origin ?? DEFAULT_TEST_ORIGIN);
  const url = new URL(form.path, `${origin}/`);
  if (!form.path.startsWith('/') || form.path.startsWith('//') || url.origin !== origin) throw new TypeError('test form path must be an absolute local path');
  const headers = new Headers(options.headers);
  if (options.sendOrigin !== false && !headers.has('origin')) headers.set('origin', origin);
  const method = options.method ?? 'POST';
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    if (options.entries !== undefined || options.csrfToken !== undefined || options.requestKey !== undefined) throw new TypeError('rawBody cannot be combined with encoded form options');
    // Raw negative cases must choose their own Content-Type, including intentionally absent/wrong ones.
    body = options.rawBody;
  } else if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
    const entries = new URLSearchParams();
    if (options.csrfToken !== undefined) entries.append('_bc_csrf', options.csrfToken);
    if (options.requestKey !== undefined) entries.append('_bc_request', options.requestKey);
    for (const [name, value] of options.entries ?? []) entries.append(name, value);
    body = entries.toString();
    if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
  } else if (options.entries !== undefined || options.csrfToken !== undefined || options.requestKey !== undefined) {
    throw new TypeError('GET/HEAD test requests cannot include form entries');
  }
  return new Request(url, { method, headers, ...(body === undefined ? {} : { body }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
}

export interface FormTestClient {
  readonly request: (options?: FormRequestOptions) => Request;
  /** Return the actual handler Response; HTML errors are not converted into fictional JSON. */
  readonly submit: (options?: FormRequestOptions) => Promise<Response>;
}

/** Exercise authentication, CSRF, validation and effects through the actual supplied handler. */
export function createFormTestClient(form: FormTestTarget, handler: FormTestHandler, options: Readonly<{ origin?: string }> = {}): FormTestClient {
  const origin = exactOrigin(options.origin ?? DEFAULT_TEST_ORIGIN);
  const target = Object.freeze({ path: form.path });
  const request = (requestOptions: FormRequestOptions = {}) => createFormRequest(target, { ...requestOptions, origin: requestOptions.origin ?? origin });
  return Object.freeze({ request, submit: async (requestOptions: FormRequestOptions = {}) => handler(request(requestOptions)) });
}
