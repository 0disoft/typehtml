# Changelog

## 0.1.0-alpha.1 — Unreleased

- Introduce the scoped `@0disoft/typehtml` package with compiled ESM and TypeScript declarations.
- Add reusable form definitions with inferred input/output types and a standard Request/Response handler.
- Expose explicit authentication, CSRF, authorization, execution, projection, invalid-response, and success hooks.
- Add the `typehtml` CLI, safe project initialization, and a minimal native-form starter. Keep `boundary` as an alias.
- Support generic JSON form manifests for type/projection generation and source-verified Doctor checks.
- Keep the Bun SQLite order implementation as an explicitly separate reference profile.
- Adopt the MIT license.
- Index Doctor HTML, field, and coverage processing; bound analysis work and submission evidence with explicit incomplete results.
- Reuse prepared immutable Origin policies in form handlers and the reference app.
- Use indexed intent retention cleanup and bounded SQLite session maintenance. `pruneExpired()` now deletes one batch of at most 100 sessions; use `pruneExpiredAsync()` to drain expired sessions while yielding between batches.
- Preserve native session-prune cancellation reasons, snapshot Doctor limits before asynchronous loading, and retain resolved target diagnostics when submission evidence is truncated.

The v0.5 design snapshot and earlier implementation/verification records remain available under `docs/design/` and `docs/acceptance/`. This alpha does not claim framework coverage or exactly-once generic execution.
