# AGENTS.md

## Scope

This repository develops the `@0disoft/typehtml` alpha package. The generic form API is under `src/form/`; the Bun SQLite order runtime remains a separate reference. The v0.5 package under `docs/design/v0.5/` is an immutable reference snapshot.

## Commands

- `bun test` — run the unit tests.
- `bun run typecheck` — run TypeScript in no-emit strict mode.
- `bun run build` — emit portable ESM JavaScript and declarations into `dist/`.
- `bun run pack` — build once and write the installable archive into `artifacts/`.
- `bun run package:smoke` — install the existing archive into fresh temporary consumers and verify CLI, types, and runtime behavior.
- `bun test test/contract/strict-json.test.ts` — run the focused contract tests.
- `bun run doctor -- --config <path>` — run the form-only Doctor.
- `bun run example` — start the local reference order demo (not an acceptance run).

## Rules

- The project owner explicitly asked for the P1 reference runtime to be implemented before P0 evidence exists. It lives under `src/runtime/`, `src/adapter/`, and `src/render/`, and the demo is `examples/order-app.ts`. P0a/P0b comparison results remain NOT_RUN; do not present the reference runtime as P0 evidence or product validation.
- Keep `docs/design/v0.5/` unchanged. Add a new version directory for revisions.
- Do not introduce `.thtml`, a new reactivity model, a server generator, or general information-flow analysis.
- Prefer Bun + TypeScript and standard library APIs. Add dependencies only when the task requires them.
- Public CLI/core exports support Node 22+ and Bun 1.4+. Keep Bun SQLite out of portable imports; expose the order runtime only through `@0disoft/typehtml/reference/order`.
- Keep package metadata and `src/version.ts` consistent. Verify the packed archive outside this repository before a release. Publishing and push remain separate external actions.
- Record unexecuted checks and unknown/unsupported coverage honestly in `docs/acceptance/`.
