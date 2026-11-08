# Changelog

## 0.1.0-alpha.8 — Browser hydration and accessibility verification

- Expose the existing error-summary focus helper through the browser-safe React and Svelte entry points, avoiding Node crypto/storage imports in browser bundles; preserve the root export and behavior.
- Add fresh installed-package Chrome verification for development/production SSR hydration, pre-hydration edits, native controls and no-JavaScript POST, host state/cancellation, keyboard focus and automated accessibility checks.
- Refresh local core, starter-kit and VSIX 0.1.4 artifacts without publication. The extension runtime remains unchanged.

## 0.1.0-alpha.7 — Eight-stage regression fixes

- Check fixed indexed array holes after declared text and file slots are assembled; retain rejection of actual gaps and existing URL-encoded defaults.
- Preserve raw scalar values when a selected native choice becomes disabled, including explicit boolean false tokens.
- Reject scalar boolean rendering overrides that can silently change false into a submitted true token; keep existing field-props APIs unchanged.
- Avoid an unhandled abort rejection when an injected submission scheduler expires synchronously and then throws.
- Fully revalidate caller-owned rich projections on lookup; cache only owned immutable projections.
- Redact sensitive select/datalist option label attributes and duplicate raw labels as well as values/text.
- Extend installed Node/Bun and native DOM probes and refresh local core, starter-kit and VSIX 0.1.3 artifacts without publication.

## 0.1.0-alpha.6 — Portable installation and richer native forms

- Add a relocatable starter kit containing a standalone initializer and local package; choose Node/Bun runtime independently from npm/Bun installation.
- Share immutable transport declarations across decoding, HTML helpers and verified rich Doctor projections.
- Add bounded dynamic object rows with explicit stable identity and immutable host array helpers.
- Add opt-in streaming multipart uploads with byte/count/time bounds, private temporary storage and request-owned cleanup.
- Extend Doctor to rich native form structure and carry schema locations, reasons and fixes through JSON, text, SARIF and LSP; retain unknown opaque validation and redacted values.
- Share initial/422 native rendering, labels, choices, accessible errors and validation-only previews; add optional React/Svelte connections using host state without automatic submission retries.
- Capture explicitly selected Hono/Astro/SvelteKit response states with bounded reads and control-value redaction.
- Refresh local npm tarball, starter kit and VS Code extension 0.1.2; no registry or Marketplace publication.

## 0.1.0-alpha.5 — Developer tools regression fixes

- Restrict typed helper names to keys shared by every form in an unnarrowed union.
- Preserve absent raw-request Content-Type consistently on Node and Bun instead of synthesizing text/plain.
- Correct custom error-ID links for repeated text fields exposed through the typed helper.
- Enforce catalog HTML budgets during rendering and describe repeated-field presence accurately.
- Reject immutable design output paths even when their directories are filesystem links.
- Refresh the separate VS Code extension without sending document bodies that can exceed LSP frame limits.
- Rebuild local npm and VSIX installation artifacts; no registry or Marketplace publication.

## 0.1.0-alpha.4 — Local developer tools

- Add opt-in field-name type checking from explicit wire declarations, preserving existing dynamic helpers.
- Add a separate testing entry point for native Request construction and in-process handler submission, including duplicate and malformed request cases.
- Add reusable English/Korean validation messages using declared bounds and explicit quality-aware locale negotiation; retain default and opaque vendor messages.
- Add read-only static form catalogs with bounded JSON/HTML exports and a static-manifest CLI command.
- Add an independently packaged local VS Code extension connecting saved HTML snapshots to the existing Doctor LSP.
- Extend fresh installed-package runtime and declaration checks. Keep npm and editor publication separate and unperformed.

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
