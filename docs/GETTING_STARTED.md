# Getting started

TypeHTML is a server-side form boundary library and a static form checker. Start with a plain HTML form, then connect your server's authentication and business operation. No browser JavaScript is required.

## Runtime and package manager

| Path | Runtime |
| --- | --- |
| Public core, contract helpers, Doctor, CLI | Node.js 22+ or Bun 1.4+ |
| Starter server | Node.js 22+ (compiled ESM) or Bun 1.4+ |
| SQLite order reference | Bun 1.4+ |

Use npm or Bun to install dependencies. Choose --runtime node or --runtime bun independently from --package-manager npm or --package-manager bun. The installed CLI defaults to Bun for compatibility; the standalone kit defaults to Node/npm. Node starters compile TypeScript into ESM before starting, including on Node 22.0 without native TypeScript support. The public handler still returns a standard Response for existing servers.

## Install from npm

The package is `@0disoft/typehtml`, with prereleases on the `alpha` channel. Do not install the unrelated unscoped `typehtml` package.

```sh
# Existing project:
npm install @0disoft/typehtml@alpha
# Or:
bun add @0disoft/typehtml@alpha
```

To create a Node/npm project without cloning this repository:

```sh
npx --yes --package=@0disoft/typehtml@alpha typehtml init ./my-app --runtime node --package-manager npm
cd my-app
npm install
npm run generate
npm run check
npm run dev
```

For a Bun project:

```sh
bunx --package @0disoft/typehtml@alpha typehtml init ./my-bun-app --runtime bun --package-manager bun
cd my-bun-app
bun install
bun run generate
bun run check
bun run dev
```

Open `http://127.0.0.1:3000/`. Use a new or empty target directory: `init` refuses to overwrite existing files and never installs dependencies or starts a server. Runtime/package-manager flags are explicit because the installed CLI retains its Bun default. Replace `@alpha` with `@0.1.0-alpha.8` to select this exact package release. Alpha releases may change their API; they are not a stable `1.0` contract.

## Install from a local archive

The starter kit archive in `artifacts/typehtml-starter-<version>.tar.gz` contains a standalone initializer, the local npm tarball, a guide, and the optional VSIX. Extract it, then run:

```sh
node create-typehtml.mjs ../my-app --package-manager npm --runtime node
cd ../my-app
npm install
npm run generate
npm run doctor
npm run dev
```

No source checkout or manual dependency edit is needed. The initializer copies the tarball to `vendor/typehtml.tgz` and records `file:./vendor/typehtml.tgz`. Third-party dependencies may still require network access. Maintainers run `bun run pack`, package the VSIX under `integrations/vscode`, then run `bun run starter:pack`.

Maintainers can also build an installable npm tarball from the public source repository:

```sh
# Run from the TypeHTML repository.
bun install
bun run pack
node dist/cli.js init ../my-typehtml-app --package-manager bun --package-source artifacts/0disoft-typehtml-0.1.0-alpha.8.tgz
```

The package artifact is copied into the generated project automatically:

```sh
cd ../my-typehtml-app
bun install
bun run generate
bun run doctor
bun run dev
```

For npm installation:

```sh
# Run the initializer from the built TypeHTML checkout.
node dist/cli.js init ../my-typehtml-app --runtime node --package-manager npm --package-source artifacts/0disoft-typehtml-0.1.0-alpha.8.tgz
cd ../my-typehtml-app
npm install
npm run generate
npm run doctor
npm run dev
```

Use a new or empty target directory. `init` refuses to overwrite an existing project's files and never runs package installation or a server for you. Paths containing spaces should be quoted using your shell's syntax.

Local archives remain supported alongside the npm alpha channel. Archives under `artifacts/` are generated files, not tracked Git files. The optional VSIX is built separately from source; it is not in the core npm package and has no Marketplace listing. See [developer tools](DEVELOPER_TOOLS.md) for its build/install path.

## Starter files

| File | Purpose |
| --- | --- |
| `form.json` | Single authoritative form definition with arbitrary application fields |
| `generated/` | Types, form definition, hashes, and Doctor projection produced by `generate` |
| `index.html` | Native form snapshot used by Doctor and served by the example |
| `app.ts`, `server.ts` | Shared Web handler with a thin Node or Bun server entry point |
| `doctor.config.json` | Explicit HTML/form/action bindings and document URL |
| `package.json` | Install, generate, Doctor, and development commands |
| `README.md` | Instructions for the generated application |

Edit `form.json`, regenerate, and keep the HTML field names and constraints aligned. Run `generate:check` to detect stale generated output. The starter's local in-memory sessions represent anonymous visitors, not a real account system. Its operation is a teaching example without durable storage or exactly-once guarantees.

## Existing projects

Install `@0disoft/typehtml@alpha` (or a local tarball), import `defineForm` and `createFormHandler` from `@0disoft/typehtml`, and connect the returned handler to a matching POST route. Keep your current renderer, router, authentication system, and package manager.

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
