/** A native Request/Response boundary, including TypeHTML form handlers. */
export type WebFormHandler = (request: Request) => Response | Promise<Response>;

/** Hono route handler; returns the original Response, including redirects and cookies. */
export function toHono(handler: WebFormHandler): (context: Readonly<{ req: Readonly<{ raw: Request }> }>) => Promise<Response> {
  return async (context) => handler(context.req.raw);
}

/** Astro API endpoint: export const POST = toAstro(handler). */
export function toAstro(handler: WebFormHandler): (context: Readonly<{ request: Request }>) => Promise<Response> {
  return async (context) => handler(context.request);
}

/** React Router route action; the form must post to its configured TypeHTML path. */
export function toReactRouter(handler: WebFormHandler): (arguments_: Readonly<{ request: Request }>) => Promise<Response> {
  return async (arguments_) => handler(arguments_.request);
}

/** SvelteKit +server.ts endpoint. This is deliberately not a +page.server.ts form action. */
export function toSvelteKit(handler: WebFormHandler): (event: Readonly<{ request: Request }>) => Promise<Response> {
  return async (event) => handler(event.request);
}
