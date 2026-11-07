# Developer tools alpha.4 acceptance

Date: 2026-11-08. Package: `@0disoft/typehtml@0.1.0-alpha.4`.

## Authorized scope

The owner approved the five recommended additions: typed declared field names,
a small native request test helper, saved-HTML editor connection, reusable i18n,
and an explicit static form catalog. Multipart uploads, a browser enhancement
runtime, a wizard engine, arbitrary-schema OpenAPI conversion, and a JetBrains
plugin are not implemented by this change. The v0.5 design snapshot and the
owner's P0 exclusion remain unchanged.

## Implemented behavior

| Addition | Implementation and compatibility evidence |
| --- | --- |
| Field names | `createFormHelpers` infers literal wire keys from flat definitions or rich `fields`, including fixed nested names. Runtime unknown-name checks remain. Existing dynamic props APIs retain their signatures. Tests and installed declaration probes reject typos without mistaking transformed domain keys for wire names. |
| Testing | Separate `/testing` export builds standard Request objects and calls the actual supplied handler. Ordered duplicates, unknown keys, explicit protocol values, headers, malformed bodies and cancellation remain available for negative cases. It supplies no authentication/CSRF bypass and returns the original Response. |
| Editor | Separate local VS Code VSIX connects the existing saved-snapshot LSP. Trusted local folders and explicit config are required; executable/config paths resolve within the workspace. Direct argv, no shell, serialized client replacement, startup deadline and owned child cleanup are covered. |
| i18n | Opt-in English/Korean messages read declared bounds and snapshot labels. Explicit locale resolution handles preferences, quality weights, specificity, wildcard and zero weights. Default state messages and opaque vendor `SCHEMA` text remain unchanged; no validator or `InputIssue` changes were needed. |
| Catalog | `/catalog` exports frozen explicit registrations and escaped static HTML/JSON. CLI loads bounded static manifests, not application modules. No active form or token values are generated. Rich transport fields are listed without claiming vendor-schema introspection or whole-application proof. |

The existing request boundary, authentication/authorization ordering, strict
unknown/scalar duplicate rejection, 422 HTML redisplay and successful 303
redirects were not refactored. Existing tests run alongside new cases.

## Defects found and corrected before delivery

- Catalog limits originally ran after all files were retained. Source loading
  now enforces an aggregate 8 MiB budget (config included), in addition to the
  existing 2 MiB per-file limit, before decoding later files. Duplicate
  registrations fail while loading. Programmatic catalogs count exact pretty
  JSON UTF-8 contributions before cloning another entry; exact 8 MiB, +1 byte,
  field-count and no-later-access cases are tested. Maximum 256 forms and 8,192
  fields remain explicit; JSON and HTML each have an 8 MiB output limit.
- Editor disposal during an asynchronous client factory could start a client
  after shutdown was requested. The manager now checks disposal after creation.
  The extension owns the transport process, so a late startup callback cannot
  spawn after cleanup; shutdown awaits actual child exit and closes streams.
- Editor CLI/config symlinks are resolved before launch to enforce the same
  workspace containment advertised by the configuration.

## Verification

Native Windows environment: Bun 1.4.4, Node.js 24.14.0, TypeScript 7.0.2.

| Check | Result |
| --- | --- |
| `bun test` | **570 pass, 0 fail; 3,940 assertions across 62 files** |
| `bun run typecheck` | Passed after all source changes |
| `bun run generate:check` | Current, no generated changes |
| `bun run pack` | Built portable ESM/declarations once and produced alpha.4 archive |
| `bun run package:smoke` | **19 verification groups passed**; fresh npm and Bun consumers outside the repo; temporary fixtures removed |
| Installed declarations | Positive/negative field inference and all new exports passed with `skipLibCheck=false` |
| Installed runtime | Node and Bun exercised original 303/422/403, rich inputs, adapters/sockets, CSRF, replay, typed helpers, testing client, locales and catalog |
| Installed CLI | Init, generation/check, Doctor/SARIF, catalog HTML/JSON, starter GET/422/303/receipt passed |
| VS Code focused tests | 12 pass, 39 assertions: configuration, links, replacement, timeout, disposal and actual transport exit |
| Extension build/package | Typecheck, bundled client, official `@vscode/vsce` packaging and `node --check` passed |
| Real editor transport | Owned Node child to built CLI: initialize, saved config diagnostics, shutdown passed |
| `git diff --check` | Passed |
| Immutable design | `docs/design/v0.5/` unchanged |

The core package does not include the editor's dependencies or validator
development dependencies. The extension bundles its own language client and
includes third-party license notices. Neither artifact was published or pushed.

## Local artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `artifacts/0disoft-typehtml-0.1.0-alpha.4.tgz` | 156382 | `99355013230e77c585984a6d4add425e21f4ff3df3fbc5d91d36c6d3184f1efa` |
| `artifacts/typehtml-vscode-0.1.0.vsix` | 147765 | `5516a46405ed6d4f1b0fa4afcbc4c5a0e4f3d977d2b4298db6e909a8ac89c684` |

The alpha.3 archive remains unchanged: 142832 bytes,
`583c23619a783ba7847a08386c1907217446b70895fc9b1b95df42ab71191f83`.
Artifacts are local ignored build outputs. Installation instructions are in
`docs/DEVELOPER_TOOLS.md` and `integrations/vscode/README.md`.

Implementation commits: `b5d4908`, `e15abae`, `fb7080e`, `dee08c8`, `6f37667`,
`24ab7b8`, `155d6fd`. The final documentation commit records these verified
artifacts without changing packed source behavior.

## Unexecuted coverage

- Actual VS Code extension-host UI session: **NOT_RUN**. Configuration/lifecycle
  tests, VSIX packaging and real stdio transport do not establish full editor UI
  integration.
- Node.js 22 minimum-version execution, Linux/macOS, external services, each
  framework's full application build, Marketplace publication and npm
  publication: **NOT_RUN**.
- Unsaved editor overlays, non-HTML source parsers, opaque validator proof and
  complete application discovery remain unsupported rather than silently
  treated as analyzed.
