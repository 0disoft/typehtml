import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { WebFormHandler } from './web.ts';

export interface NodeAdapterOptions {
  /** The externally visible, canonical origin. Host and proxy headers are never trusted here. */
  readonly origin: string;
  /** Bounds streaming a response to a slow/disconnected client, not business execution. */
  readonly responseTimeoutMs?: number;
  readonly onError?: (error: unknown) => void;
}

function canonicalOrigin(origin: string): string {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
    throw new TypeError('adapter origin must be a serialized HTTP(S) origin');
  }
  return origin;
}

/** A zero-prefetch bridge. Canceling a rejected body must not destroy its response socket. */
function incomingBody(request: IncomingMessage): Readonly<{ body: ReadableStream<Uint8Array>; dispose: () => void }> {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let wake: (() => void) | undefined;
  let stopped = false;
  let ended = false;
  const finishPull = () => { wake?.(); wake = undefined; };
  const data = (chunk: unknown) => {
    request.pause();
    if (stopped) return;
    if (!(chunk instanceof Uint8Array)) {
      stopped = true;
      controller.error(new TypeError('raw request body was decoded before the TypeHTML adapter'));
    } else controller.enqueue(chunk);
    finishPull();
  };
  const end = () => {
    if (!stopped) { ended = true; stopped = true; controller.close(); }
    finishPull();
  };
  const error = (reason: unknown) => {
    if (!stopped) { stopped = true; controller.error(reason); }
    finishPull();
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      request.pause();
      request.on('data', data);
      request.on('end', end);
      request.on('error', error);
      request.pause();
      if (request.readableEnded) end();
    },
    pull() {
      if (stopped) return;
      return new Promise<void>((resolve) => { wake = resolve; request.resume(); });
    },
    cancel() { stopped = true; request.pause(); finishPull(); },
  }, { highWaterMark: 0 });
  return {
    body,
    dispose() {
      if (!stopped) { stopped = true; if (!ended) controller.close(); }
      finishPull();
      request.pause();
      request.off('data', data);
      request.off('end', end);
      request.off('error', error);
    },
  };
}

function requestUrl(request: IncomingMessage, origin: string): string {
  // Express may trim req.url while mounting middleware; originalUrl retains the boundary path.
  const raw = (request as IncomingMessage & { originalUrl?: string }).originalUrl ?? request.url ?? '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\u0000-\u0020\u007f\\]/.test(raw)) {
    throw new TypeError('request target must be an origin-relative path');
  }
  const url = new URL(raw, origin);
  if (url.origin !== origin) throw new TypeError('request target changed the configured origin');
  return url.href;
}

function rawHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
  }
  return headers;
}

function applyResponseHeaders(response: Response, outgoing: ServerResponse): void {
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie' && name !== 'transfer-encoding') outgoing.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) outgoing.setHeader('Set-Cookie', cookies);
}

function awaitWithAbort<T>(pending: Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    pending.then((value) => {
      signal.removeEventListener('abort', abort);
      if (settled) {
        try { discard?.(value); } catch { /* A late value cannot replace the original cancellation. */ }
        return;
      }
      settled = true;
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort);
      if (settled) return;
      settled = true;
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

function discardResponse(response: Response, reason?: unknown): void {
  if (!(response instanceof Response) || response.body === null || response.body.locked) return;
  // An abandoned handler may return long after its request/socket listeners were disposed.
  try { void response.body.cancel(reason).catch(() => undefined); } catch { /* Preserve the transport outcome. */ }
}

function awaitHandlerResponse(pending: Response | Promise<Response>, signal: AbortSignal): Promise<Response> {
  // Keep late-result ownership outside the listener's socket/request closure.
  return awaitWithAbort(Promise.resolve(pending), signal, (response) => discardResponse(response, signal.reason));
}

/** Own stream completion so an aborted source cannot be mistaken for a successful empty response. */
async function writeResponseBody(body: ReadableStream<Uint8Array>, outgoing: ServerResponse, signal: AbortSignal): Promise<void> {
  const reader = body.getReader();
  let complete = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await awaitWithAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (done) { complete = true; break; }
      if (!outgoing.write(value)) await once(outgoing, 'drain', { signal });
    }
  } finally {
    if (!complete) {
      // A vendor stream's cancel callback can itself never settle; cleanup must not hang on it.
      try { void reader.cancel(signal.reason).catch(() => undefined); } catch { /* Keep original failure. */ }
    }
    try { reader.releaseLock(); } catch { /* A failed transport may already have released it. */ }
  }
}

/**
 * A raw Node/Express endpoint. Mount before body parsers; consumed or decoded bodies are rejected.
 * Request bytes flow only when the boundary reads them. The boundary retains its own byte/time limits.
 */
export function toNodeListener(
  handler: WebFormHandler, options: NodeAdapterOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const origin = canonicalOrigin(options.origin);
  const timeoutMs = options.responseTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError('response timeout must be an integer between 1 and 2147483647ms');
  }
  const onError = options.onError;
  return async (incoming, outgoing) => {
    const abort = new AbortController();
    const disconnected = () => {
      if (!outgoing.writableFinished) abort.abort(new DOMException('client disconnected', 'AbortError'));
    };
    const failed = (reason: unknown) => abort.abort(reason);
    incoming.on('aborted', disconnected);
    incoming.on('error', failed);
    outgoing.on('close', disconnected);
    outgoing.on('error', failed);
    if (incoming.aborted || outgoing.destroyed) disconnected();
    let input: ReturnType<typeof incomingBody> | undefined;
    let response: Response | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const method = incoming.method ?? 'GET';
      const hasBody = method !== 'GET' && method !== 'HEAD';
      if (hasBody && (incoming.readableEnded || incoming.readableDidRead || incoming.readableEncoding !== null)) {
        outgoing.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        outgoing.end('RAW_BODY_REQUIRED');
        return;
      }
      let url: string;
      try { url = requestUrl(incoming, origin); }
      catch {
        outgoing.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        outgoing.end('INVALID_REQUEST_TARGET');
        return;
      }
      if (hasBody) input = incomingBody(incoming);
      const init = { method, headers: rawHeaders(incoming), signal: abort.signal, body: input?.body, duplex: 'half' };
      abort.signal.throwIfAborted();
      response = await awaitHandlerResponse(handler(new Request(url, init)), abort.signal);
      if (!(response instanceof Response)) throw new TypeError('form handler must return a Response');
      if (abort.signal.aborted || outgoing.destroyed) return;
      applyResponseHeaders(response, outgoing);
      // Unread/rejected input closes only after the error response is delivered.
      if (hasBody && !incoming.readableEnded) {
        outgoing.shouldKeepAlive = false;
        outgoing.setHeader('Connection', 'close');
      }
      timer = setTimeout(() => abort.abort(new DOMException('response streaming timed out', 'TimeoutError')), timeoutMs);
      if (method !== 'HEAD' && response.body !== null) await writeResponseBody(response.body, outgoing, abort.signal);
      const finished = once(outgoing, 'finish', { signal: abort.signal });
      outgoing.end();
      await finished;
    } catch (error) {
      try { onError?.(error); } catch { /* Logging must not interrupt socket cleanup. */ }
      if (!outgoing.destroyed) {
        if (outgoing.headersSent) outgoing.destroy();
        else {
          for (const name of outgoing.getHeaderNames()) outgoing.removeHeader(name);
          outgoing.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store', Connection: 'close' });
          outgoing.end('INTERNAL_ERROR');
        }
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      input?.dispose();
      if (response !== undefined) discardResponse(response, abort.signal.reason);
      incoming.off('aborted', disconnected);
      incoming.off('error', failed);
      outgoing.off('close', disconnected);
      outgoing.off('error', failed);
    }
  };
}

/** Express raw route/middleware. Mount before express.urlencoded/json and other body consumers. */
export const toExpress = toNodeListener;

export interface FastifyRawRequest { readonly raw: IncomingMessage }
export interface FastifyRawReply { readonly raw: ServerResponse; hijack(): unknown }

/** Fastify POST route: hijack in onRequest, before content-type parsing consumes the raw stream. */
export function createFastifyRoute(path: string, handler: WebFormHandler, options: NodeAdapterOptions) {
  const origin = canonicalOrigin(options.origin);
  if (!path.startsWith('/') || path.startsWith('//') || /[\s\\?#:*{}]/.test(path) || new URL(path, origin).pathname !== path) {
    throw new TypeError('Fastify form path must be a fixed canonical absolute path');
  }
  const listener = toNodeListener(handler, options);
  return {
    method: 'POST' as const,
    url: path,
    async onRequest(request: FastifyRawRequest, reply: FastifyRawReply): Promise<void> {
      reply.hijack();
      await listener(request.raw, reply.raw);
    },
    handler(_request: FastifyRawRequest, reply: FastifyRawReply): FastifyRawReply { return reply; },
  };
}
