# TypeHTML

Typed contracts for native HTML forms and server boundaries.

`@0disoft/typehtml` connects typed input schemas, native URL-encoded forms, and server handlers. Use a flat JSON contract or a Standard Schema validator with explicit transport fields. It provides strict request parsing, typed decoded input, public output validation, and a Doctor CLI that finds form/contract mismatches. It uses ordinary HTML and standard `Request`/`Response` routes.

The current package is **`0.1.0-alpha.4`**. Its public API can change before `1.0`. The npm name `typehtml` belongs to another project; this package uses the `@0disoft/typehtml` scope. Install the locally built tarball; registry publication is a separate decision.

## Start a project

Requirements: Node.js 22+ or Bun 1.4+ for the package and CLI. The starter server uses Bun 1.4+, including when npm installs its dependencies.

```sh
# In this repository
bun install
bun run pack
node dist/cli.js init ../my-typehtml-app

cd ../my-typehtml-app
# Replace this with the absolute path to the generated tarball.
bun add /absolute/path/artifacts/0disoft-typehtml-0.1.0-alpha.4.tgz
bun run generate
bun run doctor
bun run dev
```

The initializer writes a small editable project. It does not install dependencies or start a server. See the [getting started guide](docs/GETTING_STARTED.md) for npm commands, existing-project use, and the generated files.

## Define a form

```ts
import { defineForm } from '@0disoft/typehtml';

export const subscribe = defineForm({
  id: 'newsletter.subscribe',
  path: '/subscribe',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['email'],
    properties: {
      email: { type: 'string', minLength: 3, maxLength: 254 },
    },
  },
  output: {
    type: 'object',
    additionalProperties: false,
    required: ['status'],
    properties: { status: { type: 'string', const: 'subscribed' } },
  },
});
```

Input types are inferred from the literal schema. Length, integer bounds, and other supported constraints are still checked at runtime. Use `createFormHandler` to connect your authentication, CSRF token, authorization, business operation, public projector, and success location. The [API guide](docs/API.md) includes the complete handler and its responsibilities.

## CLI

```sh
typehtml --help
typehtml --version
typehtml init ./my-app
typehtml generate --contract form.json --out-dir generated --root .
typehtml generate --contract form.json --out-dir generated --root . --check
typehtml doctor --config doctor.config.json
typehtml doctor --config doctor.config.json --format sarif
typehtml doctor --config doctor.config.json --format text --watch
typehtml capture --config capture.json --out-dir snapshots
typehtml lsp --config doctor.config.json
typehtml catalog --config catalog.config.json --out-dir form-catalog
```

`boundary` is a compatibility alias for the same CLI. Generation emits data and TypeScript types; it does not generate a server. Doctor defaults to one JSON report and does not execute application modules. Capture fetches only explicitly selected HTML states; watch and LSP start only when requested. See the [integration guide](docs/FORM_INTEGRATIONS.md) for complete options and examples.

The [developer tools guide](docs/DEVELOPER_TOOLS.md) covers opt-in field-name type checking, native Request/Response test helpers, English/Korean validation messages, the separate local VS Code extension for saved HTML, and read-only HTML/JSON form catalogs. The existing form APIs and default responses are preserved.

## Support and responsibilities

- Native URL-encoded POST forms with flat JSON contracts, or Standard Schema validators with explicit string/integer/boolean, repeated-array, and fixed nested-path transport fields.
- Strict duplicate/unknown-key rejection, bounded body reads, origin/CSRF checks, explicit authentication and authorization hooks, and validated public output.
- Selected static form snapshots: explicit form bindings, effective submitter targets, required-field supply, scalar cardinality, and bounded integer constraint witnesses.
- Node.js 22+ and Bun 1.4+ for the core and CLI. The SQLite order reference is a separate Bun-only entry point.
- HTML attribute/state/i18n helpers; Hono, Node/Express, Fastify, Astro, React Router, and SvelteKit endpoint adapters.
- Optional signed CSRF, bounded rate-limit integration, generic fenced idempotency stores, and a separate Bun SQLite idempotency adapter.

The generic handler does not supply an account system or automatically coordinate database transactions. Your application owns side effects. The generic idempotency wrapper makes no exactly-once claim for external effects; the Bun SQLite adapter can commit same-database business writes and outcomes atomically. Memory stores are development-only.

Doctor supports selected scalar input, textarea, select, checkbox and radio semantics. Its verified manifest profile remains flat string/integer data: nested, array and boolean runtime schemas and opaque validator refinements are not static proof. Files, multipart, arbitrary JavaScript serialization and general information-flow analysis remain outside scope. Unsupported and unknown results stay visible; an empty finding list does not prove whole-application safety. TypeHTML adds no UI framework, template language or reactivity model.

## Development and evidence

```sh
bun test
bun run typecheck
bun run pack
bun run package:smoke
bun run generate:check
```

The [source repository](https://github.com/0disoft/typehtml) retains the immutable v0.5 design snapshot under `docs/design/v0.5/` and the implementation audit and P0 decision under `docs/acceptance/`. These research records are not included in the npm tarball. Reference tests are not evidence of product fit or of an unimplemented adapter.

## License

[MIT](LICENSE).
