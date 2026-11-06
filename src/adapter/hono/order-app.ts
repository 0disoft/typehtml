import { Hono } from 'hono';
import type { Context } from 'hono';
import type { LoadedBoundaryContract } from '../../contract/types.ts';
import { assertCsrfToken, CsrfError } from '../../runtime/csrf.ts';
import { OrderFailure, type OrderCoordinator } from '../../runtime/order-coordinator.ts';
import { assertFormTransport, formReadOptions, readUrlEncodedEntries, readUrlEncodedForm, WireError } from '../../runtime/wire.ts';
import { acceptsHtml, assertRequestOrigin, prepareOriginPolicy, NegotiationError } from '../../runtime/negotiation.ts';
import type { Principal } from '../../runtime/order.ts';
import { InMemoryActionRateLimiter, type ActionRateLimiter, type RateLimitDecision } from './rate-limit.ts';
import {
  renderErrorPage,
  renderForm,
  renderLogin,
  renderReceipt,
  renderStart,
  type FormConstraints,
} from '../../render/order-html.ts';
import {
  InMemorySessionStore,
  SESSION_COOKIE,
  type CredentialStore,
  type Session,
  type SessionStore,
} from '../../runtime/session.ts';

export { InMemorySessionStore, SESSION_COOKIE };
export type { Session, SessionStore };

export type OrderAppOptions = Readonly<{
  loaded: LoadedBoundaryContract;
  coordinator: OrderCoordinator;
  sessions: SessionStore;
  allowedOrigins: readonly string[];
  credentials?: CredentialStore;
  demo?: Readonly<{ principal: Principal; productId: string }>;
  rateLimiter?: ActionRateLimiter;
  /** Optional ingress/IP hook; only the host can determine a trusted client address. */
  requestLimit?: (request: Request) => RateLimitDecision | Promise<RateLimitDecision>;
  secureCookies?: boolean;
}>;

type AppEnv = { Variables: { session: Session } };

/** Capture app policy once; stateful stores and the ingress hook retain their original receivers. */
export function createOrderApp(options: OrderAppOptions) {
  const { loaded, coordinator, sessions, credentials, requestLimit } = options;
  const allowedOrigins = Object.freeze([...options.allowedOrigins]);
  const originPolicy = prepareOriginPolicy({ allowedOrigins });
  const contract = loaded.contract;
  const configuredDemo = options.demo ?? {
    principal: { tenantId: 'tenant_1', subjectId: 'subject_1', sessionId: 'demo' },
    productId: 'p_100',
  };
  const demo = Object.freeze({ ...configuredDemo, principal: Object.freeze({ ...configuredDemo.principal }) });
  const constraints = formConstraints(loaded);
  const rateLimiter = options.rateLimiter ?? new InMemoryActionRateLimiter();
  const secureCookies = options.secureCookies ?? (allowedOrigins.length > 0 && allowedOrigins.every((origin) => new URL(origin).protocol === 'https:'));
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    try {
      if (c.req.method === 'POST' && requestLimit !== undefined) {
        assertRateLimit(await Reflect.apply(requestLimit, options, [c.req.raw]));
      }
      await next();
    } finally {
      c.header('Cache-Control', contract.headers.cacheControl);
      c.header('X-Content-Type-Options', contract.headers.xContentTypeOptions);
      c.header('Referrer-Policy', contract.headers.referrerPolicy);
      c.header('Content-Security-Policy', contract.headers.contentSecurityPolicy);
      c.header('Content-Type', contract.headers.contentType);
    }
  });

  app.onError((error, c) => {
    if (error instanceof OrderFailure) {
      if ((error.status === 503 || error.status === 429) && error.retryAfterSeconds !== null) {
        c.header('Retry-After', String(error.retryAfterSeconds));
      }
      return html(c, error.status, renderErrorPage(error.status, error.code));
    }
    if (error instanceof WireError) return html(c, error.status, renderErrorPage(error.status, error.code));
    if (error instanceof NegotiationError) return html(c, error.status, renderErrorPage(error.status, error.code));
    if (error instanceof CsrfError) return html(c, 403, renderErrorPage(403, error.code));
    return html(c, 500, renderErrorPage(500, 'INTERNAL_ERROR'));
  });

  app.get('/login', (c) => {
    assertAccept(c.req.raw);
    if (credentials !== undefined) return html(c, 200, renderLogin());
    const session = sessions.create(demo.principal);
    const previous = sessionFromRequest(c.req.raw, sessions);
    if (previous !== null) sessions.revoke?.(previous.id);
    c.header('Set-Cookie', serializeSessionCookie(session.id, secureCookies));
    return c.redirect(`${contract.page.path}?productId=${encodeURIComponent(demo.productId)}`, 303);
  });

  app.post('/login', async (c) => {
    assertAccept(c.req.raw);
    assertFormTransport(c.req.raw, contract.http.maxBytes);
    assertRequestOrigin(c.req.raw, originPolicy);
    if (credentials === undefined) return html(c, 404, renderErrorPage(404, 'NOT_FOUND'));
    const entries = await readUrlEncodedEntries(c.req.raw, contract.http);
    if (entries.some((entry) => !['tenantId', 'subjectId', 'password'].includes(entry.key))) {
      throw new OrderFailure(400, 'UNKNOWN_FIELD');
    }
    const body = new Map(entries.map(({ key, value }) => [key, value]));
    const tenantId = body.get('tenantId');
    const subjectId = body.get('subjectId');
    const password = body.get('password');
    if (typeof tenantId !== 'string' || typeof subjectId !== 'string' || typeof password !== 'string') {
      return html(c, 400, renderLogin('아이디와 비밀번호를 입력해 주세요.'));
    }
    const principal = await credentials.verify(tenantId, subjectId, password);
    if (principal === null) return html(c, 401, renderLogin('아이디 또는 비밀번호가 올바르지 않습니다.'));
    const session = sessions.create(principal);
    const previous = sessionFromRequest(c.req.raw, sessions);
    if (previous !== null) sessions.revoke?.(previous.id);
    c.header('Set-Cookie', serializeSessionCookie(session.id, secureCookies));
    return c.redirect(`${contract.page.path}?productId=${encodeURIComponent(demo.productId)}`, 303);
  });

  app.post('/logout', (c) => {
    assertRequestOrigin(c.req.raw, originPolicy);
    const session = requireSession(c, sessions);
    sessions.revoke?.(session.id);
    c.header('Set-Cookie', clearSessionCookie(secureCookies));
    return c.redirect('/login', 303);
  });

  app.get(contract.page.path, (c) => {
    assertAccept(c.req.raw);
    const session = requireSession(c, sessions);
    const query = new URL(c.req.url).searchParams;
    if ([...query.keys()].some((key) => key !== 'intent' && key !== 'productId') ||
        query.getAll('intent').length > 1 || query.getAll('productId').length > 1 ||
        (query.has('intent') && query.has('productId'))) {
      throw new OrderFailure(400, 'INVALID_PAGE_QUERY');
    }
    const intentId = query.get('intent') ?? undefined;
    if (intentId === '') throw new OrderFailure(400, 'INVALID_PAGE_QUERY');
    if (intentId !== undefined) {
      const page = coordinator.resolvePage(session.principal, { kind: 'intent', intentId });
      if (page.kind === 'form') {
        return html(
          c,
          200,
          renderForm(
            page.view,
            {
              rawValues: {},
              fieldErrors: {},
              formErrors: [],
              csrfToken: session.csrfToken,
              intentId,
            },
            contract.http.path,
            constraints,
          ),
        );
      }
      if (page.kind === 'receipt') {
        return c.redirect(receiptLocation(page.output.orderId), 303);
      }
      if (page.kind === 'failure') {
        return html(c, page.status, renderErrorPage(page.status, page.code));
      }
      return html(c, 500, renderErrorPage(500, 'INTERNAL_ERROR'));
    }
    const productId = query.get('productId');
    if (productId === null || productId === '') return html(c, 400, renderErrorPage(400, 'PRODUCT_REQUIRED'));
    const page = coordinator.resolvePage(session.principal, { kind: 'product', productId });
    if (page.kind === 'start') {
      return html(c, 200, renderStart(page.view, session.csrfToken, contract.page.intentInitialization.path));
    }
    if (page.kind === 'failure') {
      return html(c, page.status, renderErrorPage(page.status, page.code));
    }
    return html(c, 500, renderErrorPage(500, 'INTERNAL_ERROR'));
  });

  app.post(contract.page.intentInitialization.path, async (c) => {
    assertAccept(c.req.raw);
    assertFormTransport(c.req.raw, contract.http.maxBytes);
    assertRequestOrigin(c.req.raw, originPolicy);
    const session = requireSession(c, sessions);
    const parsed = await readUrlEncodedForm(
      c.req.raw,
      formReadOptions(contract.http, contract.protocol, false),
    );
    assertCsrfToken(parsed.csrf, session.csrfToken);
    if (Object.keys(parsed.fields).some((key) => key !== 'productId')) throw new OrderFailure(400, 'UNKNOWN_FIELD');
    const productId = parsed.fields.productId;
    if (productId === undefined) throw new OrderFailure(400, 'PRODUCT_REQUIRED');
    assertRateLimit(await rateLimiter.consume({ principal: session.principal, actionId: contract.id, phase: 'begin' }));
    const result = await coordinator.beginDraft(session.principal, productId);
    return c.redirect(result.location, 303);
  });

  app.post(contract.http.path, async (c) => {
    assertAccept(c.req.raw);
    assertFormTransport(c.req.raw, contract.http.maxBytes);
    assertRequestOrigin(c.req.raw, originPolicy);
    const session = requireSession(c, sessions);
    const parsed = await readUrlEncodedForm(
      c.req.raw,
      formReadOptions(contract.http, contract.protocol, true),
    );
    assertCsrfToken(parsed.csrf, session.csrfToken);
    assertRateLimit(await rateLimiter.consume({ principal: session.principal, actionId: contract.id, phase: 'submit' }));
    const intentId = parsed.requestKey;
    if (intentId === null) throw new OrderFailure(400, 'MISSING_REQUEST_KEY');
    try {
      const result = await coordinator.submitIntent(session.principal, intentId, parsed.fields);
      return c.redirect(result.location, 303);
    } catch (error) {
      if (error instanceof OrderFailure && error.status === 422 && error.formState !== null) {
        const page = coordinator.resolvePage(session.principal, { kind: 'intent', intentId });
        if (page.kind === 'failure') throw new OrderFailure(page.status, page.code);
        if (page.kind === 'receipt') {
          return html(c, 409, renderErrorPage(409, 'COMPLETED_INPUT_CONFLICT', {
            href: receiptLocation(page.output.orderId), label: '완료한 주문 확인',
          }));
        }
        if (page.kind !== 'form') throw error;
        const state = { ...error.formState, csrfToken: session.csrfToken };
        return html(c, 422, renderForm(page.view, state, contract.http.path, constraints));
      }
      throw error;
    }
  });

  app.get(contract.response.receipt.path, (c) => {
    assertAccept(c.req.raw);
    const session = requireSession(c, sessions);
    const orderId = c.req.param('orderId');
    if (orderId === undefined) return html(c, 404, renderErrorPage(404, 'NOT_FOUND'));
    try {
      return html(c, 200, renderReceipt(coordinator.resolveReceipt(session.principal, orderId)));
    } catch (error) {
      if (error instanceof OrderFailure) return html(c, error.status, renderErrorPage(error.status, error.code));
      throw error;
    }
  });

  for (const [path, allow] of [
    [contract.page.path, 'GET, HEAD'],
    [contract.response.receipt.path, 'GET, HEAD'],
    [contract.page.intentInitialization.path, 'POST'],
    [contract.http.path, 'POST'],
  ] as const) {
    app.all(path, (c) => {
      c.header('Allow', allow);
      return html(c, 405, renderErrorPage(405, 'METHOD_NOT_ALLOWED'));
    });
  }
  return app;

  function receiptLocation(orderId: string): string {
    return contract.response.receipt.path.replace(':orderId', encodeURIComponent(orderId));
  }
}

function assertRateLimit(decision: RateLimitDecision): void {
  if (!decision.allow) {
    const seconds = decision.retryAfterSeconds;
    if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('INVALID_RATE_LIMIT_RESULT');
    throw new OrderFailure(429, 'RATE_LIMITED', { retryAfterSeconds: seconds });
  }
}

function formConstraints(loaded: LoadedBoundaryContract): FormConstraints {
  const quantity = loaded.contract.input.schema.properties.quantity;
  const productId = loaded.contract.input.schema.properties.productId;
  return {
    minQuantity: quantity !== undefined && quantity.type === 'integer' ? quantity.minimum ?? 1 : 1,
    maxQuantity: quantity !== undefined && quantity.type === 'integer' ? quantity.maximum ?? 20 : 20,
    productIdMaxLength: productId !== undefined && productId.type === 'string' ? productId.maxLength ?? 64 : 64,
  };
}

function requireSession(c: Context<AppEnv>, sessions: SessionStore): Session {
  const session = sessionFromRequest(c.req.raw, sessions);
  if (session === null) throw new OrderFailure(401, 'UNAUTHENTICATED');
  return session;
}

function sessionFromRequest(request: Request, sessions: SessionStore): Session | null {
  const header = request.headers.get('cookie');
  if (header === null) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return sessions.get(value);
  }
  return null;
}

function serializeSessionCookie(sessionId: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function assertAccept(request: Request): void {
  if (!acceptsHtml(request.headers.get('accept'))) {
    throw new NegotiationError(406, 'NOT_ACCEPTABLE_HTML');
  }
}

function html(c: Context<AppEnv>, status: number, body: string) {
  return c.html(body, status as never);
}
