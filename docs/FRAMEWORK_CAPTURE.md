# Capture explicitly selected framework HTML

The optional `@0disoft/typehtml/adapters/capture` entry point connects the existing bounded HTML collector to host-owned Hono, Astro, and SvelteKit render callbacks. It imports no application modules, discovers no URLs, starts no server, and executes no browser script. The application chooses every route, state, origin, renderer, and form binding.

```ts
import { collectHonoHtml } from '@0disoft/typehtml/adapters/capture';
import { writeRenderedCollection } from '@0disoft/typehtml/doctor';
import { app } from './app.js'; // Application-owned initialization.

const controller = new AbortController();
const collection = await collectHonoHtml({
  allowedOrigins: ['https://app.example'],
  selections: [
    { id: 'initial', url: 'https://app.example/edit', expectedStatus: 200,
      bindings: [{ formId: 'edit', actionId: 'profile.save', required: true,
        submitterPolicy: 'enumerate-native', constraintMismatchSeverity: 'warning' }] },
    { id: 'invalid', url: 'https://app.example/edit?state=invalid', expectedStatus: 422,
      bindings: [{ formId: 'edit', actionId: 'profile.save', required: true,
        submitterPolicy: 'enumerate-native', constraintMismatchSeverity: 'warning' }] },
  ],
  request: (request) => app.request(request),
  redactFields: ['email', 'draftId'],
  signal: controller.signal,
  concurrency: 2, timeoutMs: 10_000, maxBytes: 1024 * 1024,
});
await writeRenderedCollection(collection, {
  root: process.cwd(), directory: './snapshots',
  inputs: [{ kind: 'form-projection', path: './generated/form-check.json' }],
});
```

The declared invalid URL must actually produce the selected state; this bridge does not construct invalid input, log in, or invoke a form action. A successful GET snapshot does not prove a successful POST boundary. Use controlled test fixtures instead of production sessions or real personal data.

## Thin callback contracts

All bridges use the same selections, origins, limits, redaction, and signal options. Each selection needs a safe unique ID, an explicit URL, and explicit form bindings. Callbacks receive a fresh GET `Request` with `Accept: text/html`; its signal follows capture cancellation and the per-state deadline.

| Bridge | Callback supplied by the application |
| --- | --- |
| `collectHonoHtml` | `request(request, selection, context)` returns the real `app.request(request)` response. |
| `collectAstroHtml` | `render(selection, { request, signal })` returns a rendered string or response from a host-owned container or server. |
| `collectSvelteKitHtml` | `respond(request, selection, context)` returns a response from the host's server/platform integration. |

For example, an already-running, explicitly selected Astro or SvelteKit development fixture can supply `fetch(request, { signal, redirect: 'manual' })`. TypeHTML does not start that server or create its framework context. A host-owned Astro container can instead render a component with selected props; a plain string represents HTTP 200 only. The [Astro container API](https://docs.astro.build/en/reference/container-reference/) and [programmatic server API](https://docs.astro.build/en/reference/programmatic-reference/) are experimental, so keep their imports in application/test code. Hono directly supports [passing a Request to `app.request`](https://hono.dev/docs/api/hono#request).

`expectedStatus` defaults to 200 and must be between 200 and 499. The returned response must match exactly. An explicitly expected 422 page can be collected; an unexpected 422, redirect, or 500 fails. A declared 500 is rejected before rendering. The selected original status is recorded in `document.executionAssumption`; the internal 200 wrapper only lets the existing bounded collector read a declared non-200 HTML body. Content type, UTF-8, byte limits, response origin, and cancellation checks still apply. Capture does not follow redirects.

## Value redaction and diagnostic limits

The collection is redacted before it is returned or passed to the atomic writer. `_bc_csrf`, `_bc_request`, password inputs, and exact names in `redactFields` are covered. Input/button values, textarea/output text, and selected field options/datalist values and labels become `[REDACTED]`. Duplicate raw value attributes are removed when a sensitive start tag is regenerated. Structural flags such as `name`, `checked`, `selected`, `disabled`, `required`, and `multiple` remain intact. Corresponding query parameters in the saved document URL are also redacted. Incomplete tags that cannot be safely processed are rejected. Byte limits are checked again after redaction.

Each saved document has `sourceKind: 'redacted-snapshot'` and redacted field names in its execution assumptions. Doctor treats value-dependent constraints as unknown: a marker is never evidence for an enum, checkbox token, numeric bound, row-key equality, or application validator. Structural findings still describe the selected HTML state, and application completeness remains `not-evaluated`. The hash covers the redacted artifact rather than the original response.

This is control-value redaction, not a general secret scanner. Unnamed text, scripts, arbitrary data attributes, URLs inside markup, server logs, and application-specific metadata may contain other data. Use synthetic values and explicitly list every private named field. Do not save real credentials or rely on this helper to sanitize an arbitrary production page.

`redactCapturedHtml(html, fields?)` is also available for a host-owned pipeline. It returns immutable field metadata and the number of affected controls. It performs no file writes. Use the standard `writeRenderedCollection` to create a new artifact directory without overwriting existing application files.

## Run actual framework SSR verification

```sh
# Isolated source check while developing:
bun scripts/framework-smoke.ts

# Final archive check; imports the installed public capture subpath:
bun scripts/framework-smoke.ts --package ./artifacts/0disoft-typehtml-0.1.0-alpha.8.tgz
```

The managed smoke script creates a temporary npm project with Hono 4, Astro 7, SvelteKit 3, Svelte 5, Vite 8, and compatible peer dependencies. Dependencies follow stable releases within these explicit major ranges; they are not added to TypeHTML's runtime dependencies. It renders initial, invalid (422), and two-row states through a real Hono `app.request`, Astro's programmatic development server, and SvelteKit's Vite SSR server. The SvelteKit fixture uses its [official Vite plugin](https://svelte.dev/docs/kit/%40sveltejs-kit-vite), with configuration in `vite.config.js` for SvelteKit 3.

The script checks status, framework/state markers, dynamic row counts, redaction metadata, and absence of synthetic secrets. Servers listen only on loopback, are closed in `finally`, and are probed after shutdown; the owned temporary project is removed. Installation and child execution have deadlines, including an owned process-tree fallback on Windows. Node.js must meet the installed frameworks' own engine requirements; TypeHTML's core Node 22+ contract does not lower those framework requirements. This SSR check does not execute client hydration, accessibility tooling, application authentication, or every framework version.
