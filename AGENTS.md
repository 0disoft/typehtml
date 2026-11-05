# AGENTS.md

## Scope

This repository is design-first. The v0.5 package under `docs/design/v0.5/` is a reference snapshot, not a released SDK.

## Commands

- `bun test` — run the unit tests.
- `bun test test/contract/strict-json.test.ts` — run the focused contract tests.

## Rules

- Do not implement the P1 runtime, Hono adapter, SQLite adapter, or Doctor before P0a/P0b evidence.
- Keep `docs/design/v0.5/` unchanged. Add a new version directory for revisions.
- Do not introduce `.thtml`, a new reactivity model, a server generator, or general information-flow analysis.
- Prefer Bun + TypeScript and standard library APIs. Add dependencies only when the task requires them.
- Record unexecuted checks and unknown/unsupported coverage honestly.
