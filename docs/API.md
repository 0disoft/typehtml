# Public API

The initial `0.1.0-alpha.1` API is ESM with TypeScript declarations. Import documented package entry points instead of files under `src/` or `dist/`.

| Entry point | Purpose | Runtime |
| --- | --- | --- |
| `@0disoft/typehtml` | Form definition, handler, manifest/projection, HTML escape, input/output and CSRF helpers | Node.js 22+ / Bun 1.4+ |
| `@0disoft/typehtml/contract` | Advanced schema validation, strict JSON, digests, and original boundary-contract helpers | Node.js 22+ / Bun 1.4+ |
| `@0disoft/typehtml/doctor` | Programmatic form snapshot analysis and report types | Node.js 22+ / Bun 1.4+ |
| `@0disoft/typehtml/runtime` | Lower-level transport and validation primitives | Node.js 22+ / Bun 1.4+ |
| `@0disoft/typehtml/reference/order` | Explicit Bun SQLite/Hono order reference | Bun 1.4+ |

The public core is server-side code, not a browser bundle. The separate order reference is application-specific and does not turn the generic handler into a transaction coordinator.

## `defineForm(definition)`

```ts
import { defineForm, type InferInput, type InferOutput } from '@0disoft/typehtml';

const form = defineForm({
  id: 'requests.create',
  path: '/requests',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'quantity'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 },
      quantity: { type: 'integer', minimum: 1, maximum: 20 },
      category: { type: 'string', enum: ['personal', 'business'] },
    },
  },
  output: {
    type: 'object',
    additionalProperties: false,
    required: ['requestId', 'state'],
    properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 64 },
      state: { type: 'string', const: 'received' },
    },
  },
});

type Input = InferInput<typeof form>;
// readonly { name: string; quantity: number; category?: 'personal' | 'business' }
type Output = InferOutput<typeof form>;
// readonly { requestId: string; state: 'received' }
```

Inline literal schemas retain required/optional keys and `const`/`enum` literal types. Bounds and lengths remain runtime constraints; a TypeScript `number` does not prove a quantity lies between 1 and 20. Avoid widening a schema to `ObjectSchema` before passing it to `defineForm` when you want literal inference.

The definition is validated, copied, and frozen. Its `id` must be a stable identifier, and `path` must be a fixed canonical absolute path with no query or route parameters. `format: 'typehtml-form/1'` is optional in TypeScript and required for a JSON manifest. Do not execute user modules to turn a TypeScript definition into a Doctor input; use the static JSON path below when generation is required.

Supported schema fields are flat strings and integers. Both object schemas require `type: 'object'` and `additionalProperties: false`. Supported constraints are `required`, string `minLength`/`maxLength`, integer `minimum`/`maximum`, and scalar `const`/`enum`. Pattern support is restricted by the contract validator; arbitrary JSON Schema keywords and regexes are rejected rather than silently ignored.

String length counts Unicode code points. Input strings are not trimmed or normalized, and an empty string remains an empty string. A `required` key must exist; use `minLength: 1` when it must also be nonempty. A string field named `email` has no automatic email-format validation.

String fields use the `text` codec. Integer fields use canonical decimal syntax: no exponent, decimal point, leading zero, or negative zero. Negative integers are accepted only when the schema permits them. Integer values must fit JavaScript's safe-integer range. Files, arrays, nested objects, and multipart bodies are outside this profile.

Optional `limits` override these positive-integer defaults:

| Limit | Default |
| --- | --- |
| `maxBytes` | 16,384 request-body bytes |
| `maxEntries` | 16, including protocol fields |
| `maxKeyBytes` | 64 UTF-8 bytes per decoded key |
| `maxValueBytes` | 1,024 UTF-8 bytes per decoded value |
| `readTimeoutMs` | 30,000 ms |

Body reads are bounded even without `Content-Length`. The wrapper accepts only UTF-8 URL encoding and absent/identity content encoding. Duplicate names are checked before converting the entry list into a business object. `_bc_csrf` is the protocol token; the generic handler does not accept an order `_bc_request` intent key.

## `createFormHandler(form, options)`

The returned function has the shape `(request: Request) => Promise<Response>`. Connect it to the form's POST route in your existing server. This complete wiring example makes the application's account and persistence dependencies explicit:

```ts
import { createFormHandler } from '@0disoft/typehtml';

type Session = { subjectId: string; csrfToken: string };
type CreatedRequest = { id: string; privateAuditNote: string };

export function makeRequestHandler(deps: {
  allowedOrigins: readonly string[];
  session(request: Request): Promise<Session | null>;
  mayCreate(session: Readonly<Session>): Promise<boolean>;
  create(input: Input, session: Readonly<Session>): Promise<CreatedRequest>;
}) {
  return createFormHandler(form, {
    allowedOrigins: deps.allowedOrigins,
    authenticate: (request) => deps.session(request),
    csrfToken: ({ principal }) => principal.csrfToken,
    authorize: ({ principal }) => deps.mayCreate(principal),
    execute: ({ input, principal }) => deps.create(input, principal),
    project: (result) => ({ requestId: result.id, state: 'received' }),
    success: (output) => ({
      location: '/requests/' + encodeURIComponent(output.requestId),
    }),
  });
}
```

This example uses `form` and `Input` from the preceding definition. `deps.session`, `deps.mayCreate`, and `deps.create` are your application's implementations. The GET receipt route must independently authenticate and authorize the current requester.

All hooks except `onError` may return their result directly or through a Promise:

| Option | Contract |
| --- | --- |
| `allowedOrigins` | Nonempty array of exact serialized HTTP(S) origins, such as `https://example.com`; no path or trailing slash |
| `authenticate(request)` | Verified principal object, or `null` for 401 |
| `csrfToken({ request, principal })` | Expected nonempty synchronizer token from the authenticated session |
| `authorize({ request, principal, input })` | Exactly `true` permits execution; other results return 404 |
| `execute(context)` | Application result; host owns persistence, transactions, idempotency, and external effects |
| `project(result)` | Explicit public object matching the output schema |
| `success(output)` | `{ location }` with a same-origin absolute path; returns 303 |
| `invalid(context)` | Optional trusted HTML renderer for 422 |
| `onError(error, request)` | Optional synchronous observer for unexpected failures; response remains generic 500 |

The boundary checks the target, method, query, HTML Accept negotiation, transport headers, origin, and authenticated session. It then reads the bounded entry list, checks CSRF, decodes and validates input, calls authorization, executes the operation, validates the public projection, and redirects. The principal copy and decoded input are frozen; nested objects inside an application principal remain the host's responsibility.

`authorize` runs before `execute`. If policy facts can change, `execute` must recheck them within the transaction that performs the mutation. These separate async hooks do not hold one database snapshot or mint a durable execution grant. Repeated POSTs may call `execute` repeatedly. Use a host-owned durable idempotency protocol for operations that require it, or study the separate order reference profile.

An execution can commit before a projector or success-location error occurs. A 500 after execution is not proof that the operation was rolled back. This is another reason durable writes must use a recoverable application protocol rather than retrying blindly.

### Invalid input and rendering

Unknown fields and malformed structure return 400. Value validation returns 422 with either the escaped default error form or your `invalid` renderer. Its context contains `request`, frozen `principal`, bounded `rawValues`, `issues`, and the expected session `csrfToken`.

Custom HTML is trusted application code. Encode raw values for their actual output contexts; do not echo the request body wholesale. The exported `escapeHtml(value)` covers HTML text and quoted attribute values, not JavaScript, CSS, or URL validation. Add labels, error summaries, and `aria-describedby` links in your renderer. The handler supplies HTML content type, private/no-store, nosniff, and same-origin Referrer-Policy; the host chooses its own CSP.

`project` does not automatically remove internal fields because TypeScript accepted the return type. At runtime, extra keys, wrong values, symbol keys, and accessor properties fail output validation. Return a new object containing only public fields.

### Responses and expected failures

| Situation | Status |
| --- | --- |
| Different path / unsupported method / unexpected query | 404 / 405 with `Allow: POST` / 400 |
| HTML refused / unsupported transport / oversized body / read deadline | 406 / 415 / 413 / 408 |
| Missing authenticated principal / bad origin or CSRF | 401 / 403 |
| Unknown or duplicate field / invalid field value | 400 / 422 |
| Authorization not granted | 404 |
| Valid execution and public projection | 303 |
| Unexpected callback, output, or location failure | Generic 500 |

Malformed UTF-8, percent escapes, or unsupported charset return 400. `FormHttpError(status, code)` lets application hooks return an expected `400`, `401`, `403`, `404`, `409`, `410`, `429`, or `503` error. Keep codes free of secrets; the code is escaped into the generic HTML response. It does not roll back an earlier application side effect.

## Static manifests, generation, and Doctor

A manifest uses the same data shape plus `format`:

```json
{
  "format": "typehtml-form/1",
  "id": "greeting.create",
  "path": "/greet",
  "input": {
    "type": "object",
    "additionalProperties": false,
    "required": ["name"],
    "properties": { "name": { "type": "string", "minLength": 1, "maxLength": 80 } }
  },
  "output": {
    "type": "object",
    "additionalProperties": false,
    "required": ["message"],
    "properties": { "message": { "type": "string", "maxLength": 200 } }
  }
}
```

```sh
typehtml generate --form form.json --out-dir generated --root .
typehtml generate --form form.json --out-dir generated --root . --check
typehtml doctor --config doctor.config.json
```

Generation preserves an authoritative source hash and produces a typed `form-definition.ts`, input/output types, a Doctor form-check projection, and digest metadata. Import the generated definition when JSON is your single source. Hand-writing a second runtime schema would defeat that connection. `loadForm(path)` reads and validates static JSON at runtime but cannot infer literal TypeScript types from a file's future contents.

For programmatic use, `projectForm(form, { sourcePath, sourceSha256, generator? })` produces a form-only projection, and `verifyFormSource(check, loaded)` checks its source bytes, behavior digest, and selected structure. Source paths are project-root-relative. Doctor verifies the source before reporting connection findings and stops affected checks when it is stale.

Doctor analyzes selected native paths, not an entire application's protection. It handles supported fixed controls and submitters, records source/activation/target evidence, and keeps unknown/unsupported coverage separate. Native checkbox/radio/select/textarea/file semantics and arbitrary JavaScript mutation are not implemented by this initial static profile. Static success does not validate CSRF, authentication, current object policy, or database behavior.

Doctor bounds each run to 1,000 native paths, 100,000 control visits across those paths, and 4 MiB of compact UTF-8 JSON in the `submissions` array. This byte limit covers submission evidence, not the entire report or pretty-printing. Evidence is measured incrementally before it is retained. When a limit stops analysis, the report includes `analysisTruncated: true` and an `analysis-budget-exceeded` finding; remaining boundaries are not evaluated. This produces exit code 3 even when incomplete coverage was allowed by the audit policy. Existing confirmed defects and execution errors retain exit codes 1 and 2 respectively.

The `doctor` entry point exports `DEFAULT_ANALYSIS_LIMITS` and `AnalysisLimits`. Programmatic callers can override individual limits with `runDoctor(configPath, { maxPaths, maxControlVisits, maxSubmissionBytes })`; omitted values keep their defaults. Per-run overrides are copied before asynchronous configuration loading. Resolved target diagnostics remain in the report when the submission byte limit is reached; further supply and constraint checks stop. Increase these limits only for workloads whose processing and report sizes your host can accommodate.

## Lower-level helpers

The root entry point also exports `validateBusinessInput`, `validateOutputObject`, `OutputValidationError`, `csrfTokenMatches`, `assertCsrfToken`, and `CsrfError`, plus input/schema/projection types. Prefer the higher-level form handler unless your existing server already supplies the equivalent ordered boundary checks.

The `contract`, `doctor`, and `runtime` entry points expose their named functions and types for advanced use. They do not implicitly import the SQLite reference. The original `boundary-contract/0.5-draft` format remains available for that reference profile; a normal generic form does not need to write its order-specific configuration.

`loadBoundaryContract(path)` and `loadFormCheck(path)` return deeply frozen snapshots, including their raw JSON values, validated fields, arrays, and metadata. Use `structuredClone(loaded.value)` to prepare editable data, and reload the revised contract to obtain matching validation and hash metadata.

In the Bun order reference, `createOrderApp` captures its origin list, authentication mode and credential-store reference, demo values, and ingress hook at creation. `OrderCoordinator` captures its binding methods. Create a new app or coordinator to replace those settings or hooks. Captured hooks keep their original receivers; store state and authorization facts remain live and are rechecked in the existing transaction phases.

Form handlers and reference apps prepare their captured origin allowlists once. Advanced callers can use `prepareOriginPolicy({ allowedOrigins })` from the `runtime` entry point and pass its immutable snapshot to `assertRequestOrigin`. Ordinary, unprepared policy objects still reflect caller changes on every call.

In `SqliteSessionStore`, `pruneExpired(limit = 100)` now deletes one bounded batch and returns that batch's deleted count. The optional limit is an integer from 1 to 1,000. Callers that previously relied on one call deleting every expired session should use `await pruneExpiredAsync({ batchSize: 100, signal })` instead. The asynchronous drain fixes its expiry cutoff at the start and releases the SQLite writer and event loop between batches; completed batches remain committed if cancellation or a later failure stops the drain. Intent retention cleanup likewise preserves expiry, consistency and oldest-issued ordering while using indexed candidate selection.
