# Developer tools

These additive `0.1.0-alpha.5` tools preserve the existing native form handler,
validation order, 422 HTML errors, and 303 success redirects. They run on Node.js
22+ and Bun 1.4+; the optional editor extension has its own installation.

## Check field names in TypeScript

Use `createFormHelpers` with an inline `defineForm` or `defineSchemaForm` result.
It retains literal wire names rather than inferring names from transformed
business data. Annotations that widen a form to `DefinedForm` or
`DefinedSchemaForm` also widen its known field names; keep the inferred type.
For an unnarrowed union of forms, only names common to every member are safe.
Narrow to the selected form before creating helpers to use its branch-only keys.

```ts
import { createFormHelpers, defineForm, renderAttributes } from '@0disoft/typehtml';

const subscribe = defineForm({
  id: 'newsletter.subscribe', path: '/subscribe',
  input: {
    type: 'object', additionalProperties: false, required: ['email'],
    properties: { email: { type: 'string', minLength: 1, maxLength: 200 } },
  },
  output: {
    type: 'object', additionalProperties: false, required: ['id'],
    properties: { id: { type: 'string' } },
  },
});
const fields = createFormHelpers(subscribe);
const name = fields.name('email'); // literal type: 'email'
const html = `<input ${renderAttributes(fields.field('email'))}>`;
// fields.field('emali'); // TypeScript error; JavaScript callers get a TypeError.
```

`fields.form()` delegates to `getFormProps`. `fields.field(name, options?)`
delegates to the existing field-props helper, including state, ID, control, radio
option, and ARIA options. For a rich form declaring `'user.email'`, use that exact
name, even if the input validator transforms it to a domain field named
`emailAddress`. Arrays use the declared repeated name, such as `tags`, or an
explicit fixed path such as `'items[0].quantity'`.

Existing `getFieldProps` and `getSchemaFieldProps` accept dynamic strings as
before. No JSX component or template compiler is required; spread the attributes
in a compatible host renderer or escape them with `renderAttributes` for HTML.

## Test the actual request boundary

The separate `@0disoft/typehtml/testing` entry point builds standard requests and
calls your supplied handler in process. It sends no network traffic, starts no
server, and supplies no authentication or CSRF bypass.

```ts
import { createFormTestClient } from '@0disoft/typehtml/testing';
import { subscribe, handleSubscribe } from './subscribe.js';

const client = createFormTestClient(subscribe, handleSubscribe, {
  origin: 'https://app.example', // must match the handler's allowed origin
});
const response = await client.submit({
  headers: { Cookie: 'session=your-test-fixture-session' },
  csrfToken: 'your-test-fixture-token',
  entries: [['email', 'ada@example.test']],
});
if (response.status !== 303) throw new Error(await response.text());
```

`request(options)` builds a Request without submitting it. The standalone
`createFormRequest(form, options?)` does the same. The default method is POST and
default origin is `https://typehtml.test`; configure your fixture explicitly.
Options include `headers`, `method`, `signal`, `sendOrigin: false`, `csrfToken`,
and `requestKey`. Explicit headers take precedence over default headers. The
entries are ordered `[name, value]` tuples or a `URLSearchParams` and preserve
duplicates and unknown keys for negative tests. They are not a domain object
serializer: submit canonical wire strings yourself.

`rawBody` is mutually exclusive with entries and protocol-token options. For
malformed URL-encoded cases, set the intended Content-Type explicitly:

```ts
const malformed = await client.submit({
  rawBody: '_bc_csrf=fixture&email=%ZZ',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
});
```

When no Content-Type is supplied with `rawBody`, it stays absent on both Node
and Bun. The helper encodes it as UTF-8 bytes to prevent Fetch from silently
adding `text/plain` to a string body.

The result is the original Response. Inspect its status, headers, and HTML body;
errors are not converted into a new JSON wire format. Reading a response body
consumes it as usual. External database or mail hooks remain your test fixture's
responsibility and can execute if you supply real hooks.

## Reuse English and Korean validation messages

`createFormMessages(locale, { fields?, labels? })` provides plain-text messages
for TypeHTML's internal required, length, numeric, literal, enum, pattern,
integer, checkbox, cardinality, and sparse-array codes. Bounds come from explicit
declarations, never from parsing an English error message. It snapshots labels
and constraints at creation. Pass `form.input.schema.properties` for a flat form
or `form.fields` for a rich form.

```ts
import { createFormMessages, createFormState, resolveFormLocale } from '@0disoft/typehtml';

const locale = resolveFormLocale({
  supportedLocales: ['en', 'ko'], fallbackLocale: 'en',
  preferredLocales: ['ko-KR'], // optional, trusted user/session preference
  acceptLanguage: request.headers.get('Accept-Language'),
});
const messages = createFormMessages(locale, {
  fields: form.input.schema.properties, labels: { email: '이메일' },
});
const state = createFormState(rawValues, issues, { locale, messages });
```

Built-in messages accept English/Korean regional locale tags. `resolveFormLocale`
canonicalizes the application's 1–32 supported locales and requires its fallback
to belong to that list. Explicit preferred locales take precedence. Header
quality weights, specificity, wildcard ranges, and `q=0` exclusions are honored;
invalid header items are ignored, duplicate ranges use their first occurrence,
and the header is limited to 8,192 characters. When no preference matches, even
if the header excludes every supported locale, the explicit application fallback
is returned. This helper chooses UI language; it does not generate HTTP 406.

Neither helper changes handler defaults or guesses a locale automatically. A
`locale: 'ko'` alone still controls only language metadata. Supply `messages` to
the handler's `errors` options or to `createFormState` to translate messages.
Translate page titles, summary headings, and submit labels in your host renderer.
For per-request language, select the appropriate configured handler or use an
`invalid` renderer that calls these helpers with that request's preferences.
Vendor `SCHEMA` messages and unknown codes retain the vendor's original text;
use the validator's own locale support or explicit `messages.SCHEMA` / `message`
callbacks. User callbacks and per-code overrides continue to work.

## Connect saved HTML snapshots to VS Code

The optional `typehtml-vscode-0.1.1.vsix` is separate from the npm archive. Install
the TypeHTML tarball in the application, use VS Code's **Extensions: Install from
VSIX...**, then configure a trusted local workspace:

```json
{ "typehtml.doctorConfig": "snapshots/doctor.config.json" }
```

The extension uses the existing stdio LSP and the local CLI at
`node_modules/@0disoft/typehtml/dist/cli.js`. Node.js 22+ must be available; a
user-only `typehtml.nodePath` setting can select its executable. Config and CLI
paths must stay within the workspace. Restricted Mode and virtual workspaces do
not run workspace executables. Open/save HTML files to refresh diagnostics; use
**TypeHTML: Restart Saved-Snapshot Doctor** after changing contracts/config or
recapturing HTML externally. Clients shut down before replacement and are
disposed on deactivation.

Diagnostics describe saved HTML explicitly selected by the Doctor config. They
do not analyze unsaved edits or JSX/TSX/Astro/Svelte sources. Capturing selected
rendered states remains a separate explicit operation. A successful snapshot
check does not prove complete application correctness. The extension source and
build instructions are under `integrations/vscode` in the source repository;
neither the VSIX nor its dependencies are included in the core npm package.

## Generate a static form catalog

Explicitly list static `typehtml-form/1` manifests in `catalog.config.json`:

```json
{
  "format": "typehtml-catalog/1",
  "title": "Account forms",
  "forms": ["forms/subscribe.json", "forms/profile.json"]
}
```

```sh
typehtml catalog --config catalog.config.json --out-dir form-catalog
```

This writes `catalog.json` and `index.html` into a **new** directory whose parent
already exists. Existing outputs are not overwritten. Manifest paths resolve
relative to, and must remain within, the config directory, including symlinks.
Design snapshot directories and source-containing output paths are rejected.
No application modules, route discovery, authenticated submissions, remote
assets, or scripts are executed. The HTML displays every registered form's wire
fields, presence policy, constraints, protocol names, transport limits, and
coverage status directly. It contains no token values or active forms.

Programmatic use also accepts rich definitions without executing their validators:

```ts
import { createFormCatalog, renderFormCatalog, serializeFormCatalog } from '@0disoft/typehtml/catalog';

const catalog = createFormCatalog([subscribe, profileForm], { title: 'Account forms' });
const html = renderFormCatalog(catalog);
const json = serializeFormCatalog(catalog);
```

The returned snapshot is deeply frozen and preserves each definition's field
order. Duplicate IDs/routes are rejected. `CATALOG_LIMITS` bounds a catalog to
256 forms, 8,192 fields, a 200-code-unit title, and 8 MiB each of serialized JSON
and rendered HTML. The CLI also bounds aggregate source bytes, including the
config, to 8 MiB (`maxSourceBytes`) and each file to 2 MiB, enforcing the remaining
budget before parsing another manifest. Rich forms expose explicit transport constraints only; opaque Standard
Schema refinements/transforms and output types are not inferred. This catalog is
not an OpenAPI exporter, a server generator, or proof of application completeness.

HTML size is checked during escaping, so output that grows past the limit stops
before later fields are rendered. Presence labels distinguish declared required
keys, arrays that need values because of `minItems`, and absent optional arrays
or checkboxes that decode to `[]` or `false`. The JSON `required` flag records the
declaration; it is not a complete summary of every value constraint.

## Check rich native transport contracts

`schemaFormWireManifest(form)` exports the explicit wire data from a
`defineSchemaForm` result. It preserves nested names, booleans, repeated arrays,
bounded collections, upload slots and multipart limits. It does not inspect or
execute Standard Schema validators, infer their output, or require a fabricated
public output schema. Existing `schemaFormManifest(form, { output })` and
`getSchemaFormProfile` retain their original scalar-only contract.

```ts
import { writeFile } from 'node:fs/promises';
import { schemaFormWireManifest } from '@0disoft/typehtml';
import { profileForm } from './profile-form.js';

await writeFile('profile.wire.json', JSON.stringify(
  schemaFormWireManifest(profileForm), null, 2,
));
```

```sh
typehtml generate --form profile.wire.json --out-dir generated --root .
typehtml doctor --config doctor.config.json --format text
```

The source format is `typehtml-wire-form/1`; the generated projection is
`typehtml-form-check/1`. A Doctor input still uses
`{ "kind": "form-projection", "path": "generated/form-check.generated.json" }`.
Rich and legacy projections can coexist in one config. The generator reads only
JSON data and emits a static `wireForm`, a projection, and source/behavior
digests. Bind actual runtime input/output validators in application code with
`defineSchemaForm`; generated transport data is not a request handler. Source
bytes, behavior digest, and all regenerated normalized fields must match before
Doctor connects a rich projection to HTML. `--check` detects stale generation.

Rich analysis checks exact canonical names, scalar duplicates versus allowed
repeats, array presence/count bounds, active collection members, contiguous row
indexes, and conflicting row keys where native values are known. Collection
members are required only in rows that can actually submit; declared future rows
are not invented. It also checks upload control kind, single/multiple structure,
declared native encoding, finite native option/checkbox tokens, and supported
integer boundary witnesses. Diagnostic JSON, SARIF and LSP include `schemaPath`,
`reason` and `remediation` for rich findings. Text/editor messages show the fix.

Counts are represented by minimum/maximum intervals per wire name, not by
enumerating every combination of checkbox states. One thousand independent
checkboxes produce one native activation and one count interval for their name.
Each successful file input contributes at least one multipart part, including an
empty file placeholder. Guaranteed entry/part counts exceeding `maxEntries` or
`maxParts` are defects; possible choice-dependent overflow remains unknown.
The existing path, control-visit and evidence-byte budgets still stop incomplete
analysis with exit 3. A confirmed defect retains exit 1 even if later work is
incomplete; configuration/execution errors retain exit 2.

Runtime refinements, transforms, output validation, authorization, effects,
actual selected file content/MIME/bytes and future JavaScript mutations are not
static proof. Rich `constraints` coverage therefore remains `unknown`, including
when a bounded witness is found. Native `accept` is a hint, never a security
guarantee. Selected file counts and optional choices can also leave cardinality
unknown; applications still enforce their runtime limits. Requiring unknown
rule groups in a release audit yields exit 3 instead of a success claim.

A `redacted-snapshot` is analyzed structurally: literal tokens, integer/value
constraints and row-key equality are skipped, and value-dependent select supply
remains unknown. Redacted placeholder values are never reported as real invalid
tokens or duplicate identities. Use explicit rendered-state capture for important
framework states; Doctor does not parse JSX/Astro/Svelte source as a new template
language or analyze arbitrary application data flow.
