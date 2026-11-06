# Changelog

## 0.1.0-alpha.3 — Local regression fixes

- Stop canceled requests before starting business effects after asynchronous guards.
- Separate projected output-schema input from its transformed success type; retain nested repeated-field error links.
- Preserve scalar radio values on invalid redisplay and generate required radio selection hints even for empty allowed values.
- Enforce rendered HTML deadlines against elapsed monotonic time and snapshot render/fetch callbacks per collection.
- Treat disabled checked radios as conditional required-field supply instead of falsely passing Doctor; assemble fragmented LSP frames in linear time.
- Enforce idempotency JSON size during encoding and reject malformed Unicode scope identities before storage.
- Check SQLite replay authorization inside the immediate transaction, retain callback snapshots, and reject bound asynchronous callbacks.
- Retain local-only packaging; no npm publication.

## 0.1.0-alpha.2 — Local package

- Preserve the flat-form API and share its request boundary with additive Standard Schema forms (Zod, Valibot, ArkType).
- Add explicit boolean, ordered repeated-array and fixed nested-path codecs without relaxing scalar/protocol duplicate rejection.
- Add native HTML attributes, accessible error/state helpers and configurable error messages/locales.
- Add thin Hono, Astro, React Router, SvelteKit endpoint, Node/Express and Fastify adapters.
- Extend Doctor to scalar textarea/select/radio/checkbox controls, bounded rendered-HTML capture, text/SARIF output, managed watch and saved-snapshot stdio LSP.
- Add signed session-bound CSRF and bounded pluggable rate limiting.
- Add fenced generic idempotency, bounded memory storage and a separate Bun SQLite adapter with same-database atomic business/outcome writes.
- Declare optional request-key protocol in static manifests; retain keys and exact ordered values on invalid-form redisplay.
- Include new integration documentation and extend fresh npm/Bun consumer verification. No registry publication.

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
