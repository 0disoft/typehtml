# Forms, framework integrations, and Doctor tooling

This guide describes the additive `0.1.0-alpha.5` APIs. The existing `defineForm`, `createFormHandler`, JSON manifests, native 422 HTML responses, and successful 303 redirects remain supported. TypeHTML supplies a request boundary and diagnostics; your application supplies authentication, authorization, persistence, GET pages, and framework startup.

The core, adapters, and Doctor run on Node.js 22+ and Bun 1.4+. The optional SQLite idempotency adapter requires Bun 1.4+. No validator library, application server, browser runtime, or reactive form model is bundled by the new form APIs.

## Install the local archive

Install the supplied archive in a consumer project. These commands install files; they do not publish to npm:

```sh
npm install "./0disoft-typehtml-0.1.0-alpha.5.tgz" "zod@^4"
# Or:
bun add "./0disoft-typehtml-0.1.0-alpha.5.tgz" "zod@^4"
```

Use an absolute archive path when the file is elsewhere. Zod is the example's application dependency. Valibot 1 and ArkType 2 Standard Schema implementations are also tested; install the validator you use rather than all three. TypeHTML does not load your validator library automatically.

| Package entry point | Purpose |
| --- | --- |
| `@0disoft/typehtml` | Both form APIs, field props, form state, Standard Schema validation, security, idempotency interfaces |
| `@0disoft/typehtml/adapters/web` | Hono, Astro, React Router, and SvelteKit Request/Response bridges |
| `@0disoft/typehtml/adapters/node` | Raw Node/Express listener and Fastify route factory |
| `@0disoft/typehtml/doctor` | Analysis, rendered HTML capture, output formats, watch, stdio LSP |
| `@0disoft/typehtml/testing` | Native Request construction and an in-process handler test client |
| `@0disoft/typehtml/catalog` | Explicit form registration to read-only HTML and JSON |
| `@0disoft/typehtml/sqlite/idempotency` | Bun-only durable generic SQLite idempotency store |

Existing `/contract`, `/runtime`, and `/reference/order` entry points remain separate. Import package entry points, not implementation files under `dist`.

The [developer tools guide](DEVELOPER_TOOLS.md) documents typed wire-field helpers, reusable English/Korean messages and explicit locale negotiation, native boundary test helpers, the optional VS Code saved-HTML extension, and static catalogs. The original APIs and default English errors remain unchanged.

## Define a Standard Schema form

`fields` is the explicit URL-encoded transport allowlist and codec profile. `input` validates the decoded object and may transform it; business hooks receive the validator's output type. `output` validates the explicitly projected public result. Unknown request keys are rejected before a validator can silently strip them.

When the output schema transforms data, `project` returns its input type (`InferStandardInput<typeof outputSchema>`), while `success` receives its validated, transformed output type. These types may differ. A cancellation observed before authorization or before business execution prevents a new effect from starting; an effect already running is not retried or rolled back by the generic boundary.

```ts
// profile-form.ts
import { z } from 'zod';
import {
  createSchemaFormHandler, defineSchemaForm,
  type SchemaFormInput, type SchemaFormOutput,
} from '@0disoft/typehtml';
import { sessions, maySaveProfile, saveProfile } from './host.js';

export const profileForm = defineSchemaForm({
  id: 'profile.save',
  path: '/profile',
  fields: {
    'user.name': { type: 'string', minLength: 1, maxLength: 80, required: true },
    tags: { type: 'array', items: { type: 'string', enum: ['news', 'updates'] }, maxItems: 4 },
    notify: { type: 'boolean' },
    'items[0].quantity': { type: 'integer', minimum: 1, maximum: 10, required: true },
    note: { type: 'string', maxLength: 500, control: 'textarea' },
  },
  input: z.object({
    user: z.object({ name: z.string().min(1).transform((name) => name.toUpperCase()) }),
    tags: z.array(z.enum(['news', 'updates'])),
    notify: z.boolean(),
    items: z.array(z.object({ quantity: z.number().int().min(1).max(10) })),
    note: z.string().optional(),
  }),
  output: z.object({ profileId: z.string() }),
  limits: { maxEntries: 64, maxKeyBytes: 128, maxValueBytes: 4096 },
  validationTimeoutMs: 10_000,
});

export type ProfileInput = SchemaFormInput<typeof profileForm>;
export type ProfileOutput = SchemaFormOutput<typeof profileForm>;

export const handleProfile = createSchemaFormHandler(profileForm, {
  allowedOrigins: ['https://app.example'],
  authenticate: (request) => sessions.authenticate(request),
  csrfToken: ({ principal }) => principal.csrfToken,
  authorize: ({ principal, input }) => maySaveProfile(principal.userId, input),
  execute: ({ principal, input, request }) => saveProfile(principal.userId, input, request.signal),
  project: (saved) => ({ profileId: saved.publicId }),
  success: ({ profileId }) => ({ location: `/profiles/${encodeURIComponent(profileId)}` }),
  errors: {
    locale: 'ko', title: '입력을 확인해 주세요', summaryTitle: '수정할 항목', submitLabel: '다시 제출',
    messages: { REQUIRED: '필수 항목입니다.', MAXIMUM: '허용된 최댓값을 초과했습니다.' },
  },
});
```

`host.js` is application code: `sessions.authenticate` returns a principal object with `userId` and `csrfToken`, or `null`; `maySaveProfile` returns a boolean; `saveProfile` returns a record containing `publicId`. No sample authentication bypass is installed by TypeHTML. Serve the initial form and redirected GET page in your application. Use your actual public origin in both the handler and Node adapter configuration.

The shared handler keeps the existing order: route/method/query/Accept and transport header checks, origin checks, authentication, optional rate limiting, bounded body parsing, CSRF verification, input validation, authorization, execution, public projection/output validation, redirect. Authentication failure is 401; authorization denial remains 404; malformed transport or unknown fields are 400; ordinary invalid input is 422. Business execution is never retried implicitly.

### Transport values and names

| Declaration | Decoded value and submission rules |
| --- | --- |
| `type: 'string'` | One unchanged string; empty strings remain empty. Optional absent strings remain absent. `required` requires presence; `minLength: 1` also rejects an empty value. |
| `type: 'integer'` | One safe integer in canonical decimal syntax. Decimal points, exponents, leading zeroes, and negative zero are rejected. Optional absent integers remain absent. |
| `type: 'boolean'` | `trueValue` defaults to `on`; missing input becomes `false`. An explicit `falseValue` may map another token to `false`. Other tokens are invalid. `required: true` separately requires a submitted entry. |
| `type: 'array'` | Repeated occurrences of that exact declared name become an ordered array. Duplicates remain duplicates. No occurrences become `[]`; `minItems` still applies. `required: true` separately requires at least one submitted entry. |
| `'user.name'` | A fixed, explicitly declared nested object path. |
| `'items[0].quantity'` | A fixed, explicitly declared indexed path. Indexes must be contiguous from zero in the resulting value. |

Only declared array names permit repeated entries. Scalar, CSRF, and request-key duplicates are rejected. For example, `tags=b&tags=a&tags=b` remains `['b', 'a', 'b']`; TypeHTML does not sort or deduplicate it. A browser multiple-select submits options in document order, not click order. Use repeated controls when order or repeated equal values matter.

Paths are limited to 16 segments, indexes `0` through `1023`, and 1024 declared fields. Overlapping declarations such as `a` and `a.b`, mixed containers such as `a[0]` and `a.b`, noncanonical indexes such as `[01]`, and prototype-related segments are rejected. Request keys never invent new paths or indexes. Sparse indexed results produce a `SPARSE_ARRAY` issue. Transport byte, key-length, entry-count, and timeout limits continue to apply; increase an explicit limit when a legitimate form needs more entries or longer nested names.

Boolean profile controls are checkbox-based. To model a radio/select with textual choices, use a string or integer `enum`. String/integer `control` hints support text, textarea, select, radio, and checkbox; scalar radio/checkbox props require an explicit submitted option value. Files and multipart bodies are outside these APIs.

### Validation boundaries and cancellation

`validateStandard(schema, value, { signal, timeoutMs, libraryOptions })` can also be called directly. It validates an isolated structured clone, supports synchronous and asynchronous Standard Schema v1 implementations, and returns a standard success or issue result. `InferStandardInput`, `InferStandardOutput`, and `StandardSchemaV1` are exported types. `standardIssuesToInputIssues` maps vendor issue paths to native issue names; schema form handlers additionally map array-element issues to the declared repeated field.

The default validation timeout is 30 seconds. Original thrown errors and exact abort reasons propagate from the direct helper; `StandardValidationTimeoutError` identifies an expired deadline. The HTTP handler turns unexpected errors into its generic 500 response and supplies the original error to `onError`. A timeout stops awaiting a vendor result; it cannot interrupt blocking JavaScript or force an uncooperative validator to stop its own I/O. Host validators should bound external calls themselves.

`prepareFields`, `fieldPath`, `decodeFormFields`, and `FIELD_LIMITS` are lower-level profile/codec helpers. Prepare trusted configuration before decoding directly. Direct codec validation does not perform authentication, CSRF, origin checks, or business authorization.

## HTML attributes and error state

Use `getFormProps(form)` with either form definition. Use `getFieldProps(flatFormOrObjectSchema, name, options)` for the original scalar profile, or `getSchemaFieldProps(schemaForm, name, options)` for the richer profile. These return plain attribute values. `renderAttributes` escapes values for quoted HTML attributes and rejects event-handler attribute names; framework renderers should receive plain props through their own attribute conventions.

```ts
import {
  createFormState, csrfField, escapeHtml, getFormProps, getSchemaFieldProps,
  getOptionProps, renderAttributes, renderErrorSummary, renderFieldErrors,
} from '@0disoft/typehtml';
import { profileForm } from './profile-form.js';

const state = createFormState(
  { 'user.name': 'Ada', tags: ['news'] },
  [{ field: 'user.name', code: 'CUSTOM', message: 'Choose a different name' }],
  { locale: 'en' },
);
const name = getSchemaFieldProps(profileForm, 'user.name', { state });
const tags = getSchemaFieldProps(profileForm, 'tags', { state, control: 'select' });
const nameHtml = `<input${renderAttributes(name)}>${renderFieldErrors(state, 'user.name')}`;
const tagsHtml = `<select${renderAttributes(tags)}>${['news', 'updates'].map((value) =>
  `<option${renderAttributes(getOptionProps(value, state.rawValues.tags))}>${escapeHtml(value)}</option>`
).join('')}</select>`;
// Include the other required controls from profileForm in the complete application form.
```

`createFormState` snapshots raw strings/arrays and localized messages. `FormMessages` supports strings or functions keyed by issue code; `message(issue)` can provide a custom resolver. Setting `locale` supplies language metadata; it does not translate vendor messages automatically. Vendor issues use code `SCHEMA`, so translate them with a vendor-aware resolver when appropriate. `formFieldId(name)` returns the stable default ID used by props and error links. If you provide custom IDs, pass the matching error ID to `renderFieldErrors` and a `fieldId` resolver to `renderErrorSummary`.

`getOptionProps` provides option selection; checkbox/radio props use `optionValue` and expose `checked`. Errors supply `aria-invalid` and `aria-describedby`. Textarea contents must be escaped as text between the tags, rather than serialized as a `value` attribute. React users should translate HTML attribute spellings such as `class`, `inputmode`, and `minlength` to the framework's expected prop conventions.

HTML hints remain subordinate to server validation. Contract string lengths count Unicode code points while browser lengths count UTF-16 units: generated `maxlength` is a conservative upper bound, and supported text inputs also receive a code-point length pattern. Textareas have no native pattern. Canonical integer text controls use `inputmode` and `pattern`; `control: 'number'` additionally exposes numeric `min`, `max`, and `step` for the original scalar helper, but the server still rejects noncanonical decimal syntax. Arbitrary vendor refinements and arbitrary field regexes are not converted into equivalent HTML constraints.

The default invalid renderer already preserves escaped raw values and field errors. Rich-form fallback rendering uses repeated text controls for arrays so a 422 round trip preserves their order and duplicates. It avoids inserting empty optional scalar fields that were absent. Explicit boolean false tokens remain representable after failure. Use a custom `invalid` hook to render your application's original layout and controls. `renderSchemaFormErrors(form, raw, issues, csrfToken, options, requestKey?)` is the public complete-page fallback; `createFormState`, `renderErrorSummary`, and `renderFieldErrors` support host-owned UI fragments.

## Framework bridges

Each bridge forwards the native Request/Response boundary. The TypeHTML form path must equal the exposed POST path. These helpers do not generate routes, read an already-parsed body object, translate native responses into framework-specific action data, or start a server. The snippets below use `handleProfile` from the first example.

### Hono

```ts
import { Hono } from 'hono';
import { toHono } from '@0disoft/typehtml/adapters/web';
import { handleProfile } from './profile-form.js';
const app = new Hono();
app.post('/profile', toHono(handleProfile));
export default app;
```

### Astro endpoint

```ts
// src/pages/profile.ts — requires an Astro server deployment.
import { toAstro } from '@0disoft/typehtml/adapters/web';
import { handleProfile } from '../../profile-form.js';
export const prerender = false;
export const POST = toAstro(handleProfile);
```

This is a native API endpoint, not an Astro Actions registration. The host still configures its Astro server adapter and GET page.

### React Router action

```ts
// Resource route for /profile: export no default UI component.
import { toReactRouter } from '@0disoft/typehtml/adapters/web';
import { handleProfile } from './profile-form.js';
export const action = toReactRouter(handleProfile);
```

Use a [resource route](https://reactrouter.com/how-to/resource-routes) without a default UI component and a native form targeting `/profile` for the complete HTML/303 flow. A UI route's action may be processed as action data rather than directly serving the HTML body. Client-enhanced submission helpers that expect framework action data require application-specific handling of the returned HTML Response.

### SvelteKit endpoint

```ts
// src/routes/profile/+server.ts
import { toSvelteKit } from '@0disoft/typehtml/adapters/web';
import { handleProfile } from '../../../profile-form.js';
export const POST = toSvelteKit(handleProfile);
```

Use a dedicated POST endpoint and a native form action. This adapter is **not** a `+page.server.ts` form action and does not return SvelteKit `ActionResult`/`fail` data. Do not apply `use:enhance` expecting its action protocol. A separate GET page, for example `/profile/edit`, avoids ambiguity with page actions at the POST endpoint path.

### Node and Express

```ts
import { createServer } from 'node:http';
import { toNodeListener } from '@0disoft/typehtml/adapters/node';
import { handleProfile } from './profile-form.js';
const listener = toNodeListener(handleProfile, { origin: 'https://app.example' });
// Attach listener to your application's server/routing setup; it does not start a server.
const server = createServer(listener);
```

```ts
import express from 'express';
import { toExpress } from '@0disoft/typehtml/adapters/node';
import { handleProfile } from './profile-form.js';
const app = express();
app.post('/profile', toExpress(handleProfile, { origin: 'https://app.example' }));
// Register body-consuming middleware after the TypeHTML route.
app.use(express.urlencoded({ extended: false }));
```

The Node bridge requires the untouched raw request stream and rejects consumed or text-decoded bodies with `RAW_BODY_REQUIRED`. Never parse the body first and reconstruct a Request: that loses duplicate-key and wire-encoding evidence. `origin` is the canonical public origin; Host and forwarded proxy headers do not select it. The adapter propagates client disconnects to the Request signal, handles response backpressure and cookies, and has a configurable `responseTimeoutMs` (30 seconds by default). That timeout bounds response streaming, not application business execution.

### Fastify

```ts
import Fastify from 'fastify';
import { createFastifyRoute } from '@0disoft/typehtml/adapters/node';
import { handleProfile } from './profile-form.js';
const app = Fastify();
app.route(createFastifyRoute('/profile', handleProfile, { origin: 'https://app.example' }));
```

The factory returns a POST route whose `onRequest` hook hijacks the reply before content-type parsing consumes the stream. Do not replace it with an ordinary handler using `request.body`, and do not install an earlier hook that consumes this route's raw body. The host owns server start/stop, TLS, proxy configuration, and request execution deadlines.

## Optional signed CSRF and rate limiting

Existing synchronizer-token behavior remains the default. Origin/Referer and Fetch Metadata checks remain active; an explicitly same-site but cross-origin request is not equivalent to same-origin.

```ts
import { createSignedCsrf, InMemoryRateLimiter, createSchemaFormHandler } from '@0disoft/typehtml';
import { profileForm } from './profile-form.js';
import { loadCsrfSigningKey, sessions, maySaveProfile, saveProfile } from './host.js';

const csrf = createSignedCsrf({ secret: loadCsrfSigningKey(), ttlMs: 3_600_000 });
const limiter = new InMemoryRateLimiter({ limit: 30, windowMs: 60_000, maxKeys: 10_000 });

const handler = createSchemaFormHandler(profileForm, {
  allowedOrigins: ['https://app.example'],
  authenticate: (request) => sessions.authenticate(request),
  csrfToken: ({ principal }) => csrf.issue(principal.sessionId),
  verifyCsrf: ({ token, principal }) => csrf.verify(token, principal.sessionId),
  rateLimit: ({ principal, request }) => limiter.consume(`profile.save:${principal.userId}`, request.signal),
  rateLimitTimeoutMs: 2000,
  authorize: ({ principal, input }) => maySaveProfile(principal.userId, input),
  execute: ({ principal, input, request }) => saveProfile(principal.userId, input, request.signal),
  project: (saved) => ({ profileId: saved.publicId }),
  success: ({ profileId }) => ({ location: `/profiles/${encodeURIComponent(profileId)}` }),
});
```

The host loads a persistent secret containing at least 32 bytes and owns session cookies, key rotation, and authentication. Issue a token for the authenticated session when rendering the initial form and emit it with `csrfField(token)`. `verifyCsrf` validates the submitted token; `csrfToken` issues a token available to invalid renderers. Token expiry uses `now >= expiresAt`; tokens are session-bound but not single-use. `createSignedCsrf` also exposes `assert` and injectable clock/random sources for testing.

`RequestRateLimiter.consume(key, signal?)` is the shared-store interface. Its implementation must consume atomically across replicas. `InMemoryRateLimiter` is bounded and process-local; it does not implement a distributed limit. The handler bounds the optional rate-limit hook, returns 429 with `Retry-After` on denial, and fails closed with 503 when the limiter fails or times out. No rate-limit store is selected unless you opt in.

Outside a form handler, use `consumeRateLimit(limiter, key, { signal, timeoutMs })` for a validated decision or `assertRateLimit(limiter, key, signal?, { timeoutMs })` to throw on denial. `RateLimitError` carries 429 and retry delay; `RateLimitUnavailableError` carries 503 and preserves the failure cause. Neither helper retries writes to a limiter.

## Optional idempotency

Add `protocol: { requestKey: 'required' }` to either form definition when the action requires `_bc_request`. This declares the transport requirement, preserves it in generated scalar profiles, and exposes the key as `context.requestKey`. A handler cannot disable a declared key. The older-style `acceptRequestKey: true` handler option also opts in at runtime, but a definition-level declaration keeps Doctor's protocol projection aligned.

```ts
import { createIdempotencyKey, idempotencyField } from '@0disoft/typehtml';
const requestKey = createIdempotencyKey();
const hiddenHtml = idempotencyField(requestKey);
// Render hiddenHtml once on the initial form; reuse this same key after validation failure.
```

`idempotencyField` escapes one hidden `_bc_request` input. With no argument it generates a new key; do not call that no-argument form when redrawing an existing submission. Keys contain 16–128 base64url characters. Both default invalid renderers preserve the submitted key in 422 HTML. Custom invalid renderers must preserve `context.requestKey` themselves. Adding a key alone does not enable storage or replay.

```ts
import {
  executeIdempotent, idempotencyDigest, InMemoryIdempotencyStore, FormHttpError,
  type FormContext,
} from '@0disoft/typehtml';
import type { ProfileInput } from './profile-form.js';
import { maySaveProfile, savePublicReceipt } from './host.js';

// Development only. Inject a durable shared IdempotencyStore for production effects.
const replayStore = new InMemoryIdempotencyStore({ maxRecords: 10_000 });

// Use as the execute hook for a form declaring protocol.requestKey = 'required'.
async function saveOnce({ input, principal, request, requestKey }: FormContext<ProfileInput, { userId: string }>) {
  if (requestKey === undefined) throw new FormHttpError(400, 'MISSING_REQUEST_KEY');
  const outcome = await executeIdempotent({
    store: replayStore,
    scope: `profile.save:v1:${principal.userId}`,
    key: requestKey,
    inputDigest: idempotencyDigest(input),
    authorize: () => maySaveProfile(principal.userId, input),
    execute: (signal) => savePublicReceipt(principal.userId, input, signal),
    signal: request.signal,
    ttlMs: 86_400_000,
    timeoutMs: 10_000,
  });
  return outcome.value;
}
```

Adapt the principal type to the host session. The saved outcome must be bounded plain JSON, such as a public receipt reference, not a database connection, Date, undefined-valued object, or private user record. `encodeIdempotencyValue` supplies canonical JSON; `idempotencyDigest` hashes it; result encoding rejects cycles, holes, accessors, nonfinite numbers, negative zero, depth above 32, more than 10,000 nodes, and data above 64 KiB. `executeIdempotent` returns `{ value, replayed }` and rechecks authorization on every call, including replay. It makes at most one automatic business attempt.

`IdempotencyStore` exposes atomic `claim`, token-fenced `complete`, and `markUnknown` methods. Redis, PostgreSQL, D1, or other providers must implement the same atomic/durable contract; no ready-made adapters for those providers are bundled. A KV interface without adequate atomic coordination is insufficient. `assertIdempotencyIdentity` and `assertIdempotencyClaim` validate adapter inputs. `IdempotencyError` exposes structured 403/409/410/503 statuses and codes.

A pending, unknown, or expired key is never automatically reclaimed. TTL limits replay and is compared using `now >= expiresAt`; it does not erase the uniqueness tombstone. Conflicting input, concurrent work, uncertain completion, and expired replay are distinguishable failures. The bounded in-memory store rejects new claims at capacity and is unsuitable across restarts or replicas. A production provider must define an explicit archival/reconciliation policy rather than silently deleting blocked records.

### Durable Bun SQLite storage and atomic database writes

```ts
import { SqliteIdempotencyStore } from '@0disoft/typehtml/sqlite/idempotency';
import { idempotencyDigest } from '@0disoft/typehtml';

const store = new SqliteIdempotencyStore('./app.sqlite');
// The application creates/migrates profile_updates before handling requests.
function insertProfileOnce(
  principal: { userId: string; canCreateProfile: boolean },
  input: { user: { name: string } }, key: string, signal?: AbortSignal,
) {
  return store.executeAtomic({
    scope: `profile.insert:v1:${principal.userId}`,
    key, inputDigest: idempotencyDigest(input), signal,
    authorize: (db) => {
      const permission = db.query('SELECT can_create FROM profile_permissions WHERE user_id = ?')
        .get(principal.userId) as { can_create: number } | null;
      return permission?.can_create === 1;
    },
    execute: (db) => {
      const row = db.query('INSERT INTO profile_updates (owner_id, name) VALUES (?, ?) RETURNING id')
        .get(principal.userId, input.user.name) as { id: number };
      return { profileId: String(row.id) };
    },
  });
}
// Call store.close() when the host shuts down.
```

The application creates/migrates both tables in this example. The generic `claim`/`complete` interface can use this store too. `executeAtomic` is the stronger same-database path: synchronous authorization and business SQL, the uniqueness claim, and the saved result commit in one immediate SQLite transaction. `authorize(db)` runs inside that transaction before claiming or replaying a key; keep it read-only and query current permissions through the supplied connection. Existing zero-argument authorization callbacks remain compatible. Execute business SQL through the same supplied transaction connection; callbacks must be synchronous. SQLite cannot roll back an external HTTP request, email, or payment. Use a transactional outbox and downstream idempotency for such effects. The generic asynchronous wrapper also cannot promise exactly-once behavior across a side effect and a crash before completion; it blocks uncertain keys instead of automatically retrying them.

## Static Doctor profiles for schema forms

[Standard Schema](https://standardschema.dev/schema) standardizes validation and type inference, not constraint introspection. Its [JSON Schema interface](https://standardschema.dev/json-schema) is separate. TypeHTML therefore derives HTML hints and Doctor profiles from the declared transport fields, never from hidden vendor internals.

`getSchemaFormProfile(schemaForm, { output })` returns `{ form, runtimeValidationCoverage: 'not-statically-analyzed' }` for representable flat string/integer forms. `output` is an explicitly declared public `ObjectSchema`; it is not inferred from the vendor validator. `schemaFormManifest` returns the JSON-serializable scalar manifest and retains any declared request-key protocol.

```ts
import { writeFile } from 'node:fs/promises';
import { defineSchemaForm, schemaFormManifest, getSchemaFormProfile } from '@0disoft/typehtml';
import { z } from 'zod';

const feedback = defineSchemaForm({
  id: 'feedback.send', path: '/feedback',
  fields: { message: { type: 'string', minLength: 1, maxLength: 500, required: true } },
  input: z.object({ message: z.string().refine((value) => !value.includes('blocked')) }),
  output: z.object({ receiptId: z.string() }),
});
const outputProfile = {
  type: 'object', additionalProperties: false, required: ['receiptId'],
  properties: { receiptId: { type: 'string' } },
} as const;
const profile = getSchemaFormProfile(feedback, { output: outputProfile });
await writeFile('feedback.profile.json', JSON.stringify(schemaFormManifest(feedback, { output: outputProfile }), null, 2));
// profile.runtimeValidationCoverage is 'not-statically-analyzed'.
```

**Runtime submissions must still use `createSchemaFormHandler(feedback, ...)`.** Do not build a production handler from `profile.form`: that would omit the vendor's refinements and transforms. A Doctor result does not prove the example's blocked-word refinement or any output/business behavior.

Arrays, booleans, nested paths, and patterns outside the scalar profile are explicitly rejected by `SchemaProfileUnsupportedError`; its codes identify nested names, unsupported types, or unsupported patterns. They are not silently dropped from an allowlist, and their Doctor analysis is not claimed complete. Rich runtime support is broader than the statically analyzable profile. `doctor` can analyze supplied rendered HTML from any framework, but does not parse JSX/TSX/Astro source code or execute its templates.

## Capture selected rendered HTML

First generate the scalar projection:

```sh
npx --no-install typehtml generate --form feedback.profile.json --out-dir generated
npx --no-install typehtml generate --form feedback.profile.json --out-dir generated --check
```

The `--check` variant writes nothing and exits 1 when artifacts are stale. Generation reads static JSON and never imports application modules.

Save this capture configuration as `capture.json`, adapting the URL, form ID, and action ID to the HTML your host actually serves:

```json
{
  "format": "typehtml-capture/1",
  "root": ".",
  "inputs": [{ "kind": "form-projection", "path": "generated/form-check.generated.json" }],
  "allowedOrigins": ["http://127.0.0.1:3000"],
  "selections": [{
    "id": "feedback-initial",
    "url": "http://127.0.0.1:3000/feedback/edit",
    "bindings": [{
      "formId": "feedback.send", "actionId": "feedback.send", "required": true,
      "submitterPolicy": "enumerate-native", "constraintMismatchSeverity": "warning"
    }]
  }],
  "timeoutMs": 10000,
  "concurrency": 4,
  "maxSnapshots": 100,
  "maxBytes": 2097152,
  "maxTotalBytes": 104857600
}
```

```sh
# Start/manage your own application separately; capture never starts it.
npx --no-install typehtml capture --config capture.json --out-dir .typehtml-snapshots
npx --no-install typehtml doctor --config .typehtml-snapshots/doctor.config.json
```

Run these commands from the project root when `root` is `.`. The output must be a new directory inside the Doctor root; its parent must exist. Capture stages artifacts and never overwrites an existing output directory. Keep captured HTML in private, ignored directories: it may contain hidden CSRF tokens, submitted values, or other application data. Select development fixtures or sanitized states for shared reports; do not commit authenticated production HTML accidentally.

CLI capture uses GET with explicit allowed origins, no redirect following, and no implicit authentication. Responses must be successful UTF-8 HTML. Defaults are 100 selected states, 4 concurrent captures, 2 MiB per document, 100 MiB total, and a 30-second per-state timeout. Byte checks also apply to streamed responses; readers/timers are cleaned up on error or cancellation. IDs are unique safe filenames; credentials in URLs are rejected.

For authenticated server-rendered states, use a host-owned renderer or injected fetch implementation programmatically:

```ts
import { collectRenderedHtml, writeRenderedCollection } from '@0disoft/typehtml/doctor';
import { renderFeedbackState } from './host-renderer.js';

const controller = new AbortController();
const collection = await collectRenderedHtml({
  allowedOrigins: ['https://app.example'],
  selections: [{
    id: 'feedback-invalid', url: 'https://app.example/feedback/edit',
    bindings: [{ formId: 'feedback.send', actionId: 'feedback.send', required: true,
      submitterPolicy: 'enumerate-native', constraintMismatchSeverity: 'warning' }],
  }],
  signal: controller.signal,
  render: (selection, { signal }) => renderFeedbackState(selection.id, { signal }),
});
const written = await writeRenderedCollection(collection, {
  directory: '.typehtml-invalid-snapshot', root: '.',
  inputs: [{ kind: 'form-projection', path: 'generated/form-check.generated.json' }],
});
console.log(written.configPath); // Never log the captured HTML or session material.
```

The renderer can close over application-owned fixture/session data and return a string or HTML Response. A custom `fetch` can attach host-authorized credentials; TypeHTML does not discover or read them. Renderers should honor the supplied AbortSignal: a timeout bounds awaiting a callback but cannot stop uncooperative host work.

Declare every selected route/state separately. Capturing an initial and invalid form does not prove any other branch, route, dynamic script behavior, authentication state, or application's completeness. Each artifact records its SHA-256 and selected-state execution assumption. Reports retain `applicationCompleteness: 'not-evaluated'`.

## Reports, watch, and editor diagnostics

```sh
npx --no-install typehtml doctor --config doctor.config.json --format json
npx --no-install typehtml doctor --config doctor.config.json --format text
npx --no-install typehtml doctor --config doctor.config.json --format sarif > doctor.sarif
npx --no-install typehtml doctor --config doctor.config.json --format text --watch
npx --no-install typehtml lsp --config doctor.config.json
```

JSON remains the default. Text includes locations and explicit analysis status. SARIF 2.1.0 includes rule IDs, locations, stable fingerprints, coverage metadata, and execution status. Unknown findings are review results rather than confirmed defects. Upload SARIF through your chosen CI/editor integration; this package does not create GitHub workflows or publish reports automatically.

Exit codes remain 0 for the selected checks passing, 1 for confirmed blocking defects, 2 for execution/configuration failures, and 3 for incomplete required analysis or resource limits. An empty findings list is not application-wide correctness proof. Default analysis budgets remain 1000 native paths, 100,000 control visits, and 4 MiB of compact submission evidence; exceeding a budget is explicit rather than a success.

Watch mode analyzes serially, polls only selected dependencies, detects projection repairs, and stops on SIGINT/SIGTERM. It does not recursively watch a workspace or run capture again. Each rerun emits another complete report; concatenated JSON/SARIF watch output is a stream of reports, not one uploadable JSON document. Use a single non-watch run for a CI artifact. Programmatic `watchDoctor(configPath, { signal, onReport, intervalMs?, maxRuns? })` requires a host-owned cancellation signal; `runDoctor`, `formatDoctorReport`, and `doctorToSarif` also work directly.

The stdio language server publishes diagnostics for persisted selected HTML/configuration files on initialization and document open/save events. Configure an LSP client's command as `typehtml`, arguments `lsp --config <absolute-doctor-config>`. It supports initialize, shutdown/exit, and saved-file diagnostics; it does not analyze unsaved buffer overlays, JSX/Astro source, templates, or inferred routes. `runDoctorLanguageServer(configPath, input, output)` is available for a host integration. No VS Code extension is bundled.

Doctor recognizes textarea, single/multiple select, radio groups, and checkboxes structurally. Required fields supplied only by optional native choices remain conditional/unknown; it does not fabricate missing-field certainty. Multiple possible submissions of a scalar remain defects, including multiple-select controls against a scalar contract. File/image controls, directionality fields, custom elements, runtime security, and unsupported constraint comparisons remain explicitly unknown/unsupported or not evaluated where appropriate.
