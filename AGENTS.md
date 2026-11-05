# AGENTS.md

## Scope

This repository is design-first. The v0.5 package under `docs/design/v0.5/` is a reference snapshot, not a released SDK.

## Commands

- `bun test` — run the unit tests.
- `bun run typecheck` — run TypeScript in no-emit strict mode.
- `bun test test/contract/strict-json.test.ts` — run the focused contract tests.
- `bun run doctor -- --config <path>` — run the form-only Doctor.
- `bun run example` — start the local reference order demo (not an acceptance run).

## Rules

- The project owner explicitly asked for the P1 reference runtime to be implemented before P0 evidence exists. It lives under `src/runtime/`, `src/adapter/`, and `src/render/`, and the demo is `examples/order-app.ts`. P0a/P0b comparison results remain NOT_RUN; do not present the reference runtime as P0 evidence or product validation.
- Keep `docs/design/v0.5/` unchanged. Add a new version directory for revisions.
- Do not introduce `.thtml`, a new reactivity model, a server generator, or general information-flow analysis.
- Prefer Bun + TypeScript and standard library APIs. Add dependencies only when the task requires them.
- Record unexecuted checks and unknown/unsupported coverage honestly in `docs/acceptance/`.
