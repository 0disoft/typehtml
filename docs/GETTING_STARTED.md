# Getting started

TypeHTML is a server-side form boundary library and a static form checker. Start with a plain HTML form, then connect your server's authentication and business operation. No browser JavaScript is required.

## Runtime and package manager

| Path | Runtime |
| --- | --- |
| Public core, contract helpers, Doctor, CLI | Node.js 22+ or Bun 1.4+ |
| Generated starter server | Bun 1.4+ |
| SQLite order reference | Bun 1.4+ |

Use npm or Bun to install dependencies. Choosing npm in `init` changes the package-manager instructions; it does not turn the Bun starter into a Node server. The public handler returns a standard `Response`, so an existing Node server can provide its own HTTP bridge.

## Install the current alpha before registry publication

The repository builds an installable npm tarball. Registry publication is a separate step; do not install the unrelated unscoped `typehtml` package.

```sh
# Run from the TypeHTML repository.
bun install
bun run pack
node dist/cli.js init ../my-typehtml-app --package-manager bun
```

The package artifact is `artifacts/0disoft-typehtml-0.1.0-alpha.2.tgz`. In the generated project, replace the registry dependency with that local file:

```sh
cd ../my-typehtml-app
bun add /absolute/path/artifacts/0disoft-typehtml-0.1.0-alpha.2.tgz
bun run generate
bun run doctor
bun run dev
```

For npm installation:

```sh
# Run the initializer from the built TypeHTML checkout.
node dist/cli.js init ../my-typehtml-app --package-manager npm
cd ../my-typehtml-app
npm install /absolute/path/artifacts/0disoft-typehtml-0.1.0-alpha.2.tgz
npm run generate
npm run doctor
npm run dev
```

Use a new or empty target directory. `init` refuses to overwrite an existing project's files and never runs package installation or a server for you. Paths containing spaces should be quoted using your shell's syntax.

After this version is published, its registry install command will be `npm install @0disoft/typehtml@0.1.0-alpha.2` or `bun add @0disoft/typehtml@0.1.0-alpha.2`. The packed tarball is the prepublication installation path.

## Starter files

| File | Purpose |
| --- | --- |
| `form.json` | Single authoritative form definition with arbitrary application fields |
| `generated/` | Types, form definition, hashes, and Doctor projection produced by `generate` |
| `index.html` | Native form snapshot used by Doctor and served by the example |
| `server.ts` | Bun server wiring explicit session/CSRF hooks to the public handler |
| `doctor.config.json` | Explicit HTML/form/action bindings and document URL |
| `package.json` | Install, generate, Doctor, and development commands |
| `README.md` | Instructions for the generated application |

Edit `form.json`, regenerate, and keep the HTML field names and constraints aligned. Run `generate:check` to detect stale generated output. The starter's local in-memory sessions represent anonymous visitors, not a real account system. Its operation is a teaching example without durable storage or exactly-once guarantees.

## Existing projects

Install the tarball, import `defineForm` and `createFormHandler` from `@0disoft/typehtml`, and connect the returned handler to a matching POST route. Keep your current renderer, router, authentication system, and package manager.

The [API guide](API.md) covers the handler hooks. Hooks must call your real policies and persistence code. A project that has no authenticated accounts must explicitly choose how it represents a public requester; TypeHTML does not infer access policy from field names.

## Generate and check form contracts

Use a JSON form manifest as the single source when you want both generated TypeScript types and Doctor projections:

```sh
typehtml generate --contract form.json --out-dir generated --root .
typehtml generate --contract form.json --out-dir generated --root . --check
typehtml doctor --config doctor.config.json
```

`--form` is an alias for `--contract`. `--root` defaults to the current working directory. Use the same root in the Doctor configuration so source paths and hashes resolve consistently. The output directory is dedicated to generated files: generation refuses to replace a directory containing unrelated files, an authoritative source, or an immutable design snapshot. `--check` changes no files and returns exit 1 when generated content is stale.

Doctor takes explicit HTML documents, document URLs, form IDs, and intended action IDs. It reads the static snapshot and its verified source projection. It does not execute a framework, render templates, run application imports, or discover every route.

| Doctor exit | Meaning |
| --- | --- |
| `0` | No blocking result for the configured gate |
| `1` | Confirmed blocking diagnostic |
| `2` | Configuration or execution error |
| `3` | Required declared analysis is incomplete |

An unsupported field or activation is not a successful check. Audit mode may allow partial results while retaining their analysis status in JSON. Use required rule groups when incomplete selected boundaries must block a release.

## Before deployment

The starter is a local learning application. Replace its local session and storage choices with your service's implementations. Configure the trusted origin explicitly, use HTTPS cookies, and add the rate limits your service requires. The generic form handler does not infer trusted proxy headers or a client IP.

Put database policy checks and mutations in the transaction that owns their consistency. Add your application's durable idempotency protocol where repeated POSTs could repeat an operation. The generic handler does not make external mail, payments, or arbitrary callbacks exactly once.
