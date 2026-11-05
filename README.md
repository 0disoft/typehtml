# TypeHTML

Typed contracts for native HTML forms and server boundaries.

`@0disoft/typehtml` connects a flat input schema, a native URL-encoded form, and a server handler. It provides strict request parsing, typed decoded input, explicit public output validation, and a read-only Doctor CLI that finds form/contract mismatches. It uses ordinary HTML and standard `Request`/`Response` routes.

This is the first **`0.1.0-alpha.1`** package. Its public API can change before `1.0`. The npm name `typehtml` belongs to another project; this package uses the `@0disoft/typehtml` scope. Until registry publication, install the tarball built from this checkout.

## Start a project

Requirements: Node.js 22+ or Bun 1.4+ for the package and CLI. The starter server uses Bun 1.4+, including when npm installs its dependencies.

```sh
# In this repository
bun install
bun run pack
node dist/cli.js init ../my-typehtml-app

cd ../my-typehtml-app
# Replace this with the absolute path to the generated tarball.
bun add /absolute/path/artifacts/0disoft-typehtml-0.1.0-alpha.1.tgz
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
```

`boundary` is a compatibility alias for the same CLI. Generation emits data and TypeScript types; it does not generate a server. Doctor prints one JSON report and does not execute project configuration or application modules.

## Support and responsibilities

- Native URL-encoded POST forms with flat string and safe-integer fields.
- Strict duplicate/unknown-key rejection, bounded body reads, origin/CSRF checks, explicit authentication and authorization hooks, and validated public output.
- Selected static form snapshots: explicit form bindings, effective submitter targets, required-field supply, scalar cardinality, and bounded integer constraint witnesses.
- Node.js 22+ and Bun 1.4+ for the core and CLI. The SQLite order reference is a separate Bun-only entry point.

The generic handler does not supply an account system, a database transaction, or exactly-once execution. Your application owns those operations and any side effects inside its hooks. The Bun SQLite order reference demonstrates one explicit transaction/idempotency profile.

Files, multipart, nested objects, checkbox/radio/select/textarea semantics, arbitrary JavaScript serialization, and general information-flow analysis are outside the initial Doctor profile. Unsupported and unknown results stay visible; an empty finding list is not a claim that the whole application is safe. TypeHTML does not add a UI framework, a template language, or a reactivity model.

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
