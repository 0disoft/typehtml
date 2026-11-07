# Developer tools regression review and alpha.5 artifacts

Date: 2026-11-08. Reviewed baseline: `f7e826b` (alpha.4, VS Code 0.1.0).
Core build commit: `3acd01a`. All five additions were reviewed; seven defects
were corrected. i18n did not require a code change under its documented policy.

## Findings and corrections

| Area | Confirmed problem | Correction and regression evidence |
| --- | --- | --- |
| Typed fields | A union of possible forms accepted a name belonging to only one branch; the code compiled but could throw for another branch. | Field names must be shared by every unnarrowed branch. Concrete-form literals remain precise. Negative declaration tests cover flat/rich/mixed unions and `never`; fresh installed declarations also reject branch-only fields. Narrow a selected form before using its exclusive keys. |
| Typed rendering | Repeated text fields with a custom ID pointed `aria-describedby` at a generated default error ID instead of the custom error element. This underlying rich-props defect was exposed through the new wrapper. | Error links use the same custom ID returned in props; default IDs remain unchanged. Regression checks the error element, hint and ARIA link together. |
| Testing helper | For a raw string with no Content-Type, Node Fetch supplied `text/plain;charset=UTF-8` while Bun left it absent. Negative tests therefore built different requests on each runtime. | Raw bodies use UTF-8 bytes. Explicit media types and Unicode/malformed body contents remain intact. Actual Node subprocess tests and installed Node/Bun probes verify absent headers. |
| Catalog HTML | The 8 MiB HTML limit ran after escaping/rendering all fields. A roughly 2 MiB ampersand value could expand beyond 10 MiB and later fields were still processed before rejection. | Count UTF-8 output incrementally, escape chunks of at most 1,024 UTF-16 units, keep surrogate pairs intact and stop before later field rendering. Exact 8 MiB, +1 byte and no-later-access cases pass. |
| Catalog presence | Arrays with `minItems > 0` but no explicit required flag were labeled optional even though omission decodes to `[]` and fails validation. Default absent arrays/booleans were not explained. | HTML labels now explain minItems requirements and missing `[]`/`false` values. JSON declaration flags and runtime decoding remain unchanged. |
| Catalog output | A requested `docs/design` directory that was itself a filesystem link could resolve outside the design-named path and bypass the immutable-output guard. | Check both the requested path and resolved output path. A link-based regression verifies that neither immutable logical paths nor resolved design paths are written. Concurrent fresh-directory creation also yields exactly one complete winner. |
| VS Code | Opening valid HTML between the 1 MiB RPC cap and 2 MiB snapshot limit sent the entire editor text and terminated the LSP connection. Dirty opens skipped the normal continuation. | Forward an empty `getText()` view with URI/language/version metadata through the normal continuation. Frozen documents and real metadata method receivers are preserved. No buffer text is read, open tracking remains active, and saves remain text-free. A saved file above 1 MiB returns diagnostics and a normal shutdown response. |

## Preserved behavior

- No changes to the generic request boundary, flat handler, authentication or
  authorization order, CSRF policy, scalar duplicate rejection, or unknown-key
  rejection. Normal 422 HTML redisplay and 303 success remain covered.
- Existing handler differential: **238 request combinations matched** in status,
  complete headers, HTML body and hook order against the prior `9814315`
  handler. This comparison shares current low-level parsing/rendering modules;
  it proves handler-flow compatibility, not a complete old-package comparison.
- Catalog differential: **12 legacy HTML cases matched byte-for-byte** against
  `f7e826b`, including escaping, Korean, emoji, chunk boundaries and one/two
  forms. Corrected presence labels are intentional rich-form output changes.
- i18n review covered actual validation codes, immutable constraint/label
  snapshots, language quality/specificity/lookup and explicit fallback. Default
  errors and opaque vendor messages remain unchanged.

## Verification

Native Windows: Bun 1.4.4, Node.js 24.14.0, TypeScript 7.0.2.

| Check | Result |
| --- | --- |
| `bun test` | **582 pass, 0 fail; 3,979 assertions, 62 files** |
| `bun run typecheck` | Passed |
| `bun run generate:check` | Current, no generated changes |
| `bun run pack` | Built alpha.5 ESM/declarations and local tarball |
| `bun run package:smoke` | **21 verification groups passed** outside this repository; fresh npm/Bun consumers and fixture cleanup |
| Installed types | Union-name rejection plus existing literal/domain/output inference; `skipLibCheck=false` |
| Installed runtime | Node/Bun original and new form APIs, adapters, CSRF/idempotency, raw-header regression, i18n and catalog |
| Installed LSP | Both package-manager consumers ran the installed CLI under Node against saved HTML above 1 MiB; metadata-only open, actual BC010 diagnostics and graceful shutdown |
| VS Code focused suite | 16 pass, 49 assertions; frozen dirty/clean documents, normal continuation, paths/trust and child cleanup |
| VSIX packaging | Official `@vscode/vsce` package, extension typecheck and bundled dependency notices passed |
| VSIX integrity | Version 0.1.1, 7 entries, bundled JS SHA-256 matches the tested local build; `node --check` passed |
| Design and whitespace | `docs/design/v0.5/` unchanged; `git diff --check` passed |

The additional installed RPC probe and final documentation do not change packed
runtime behavior. No dependencies were changed. No npm/Marketplace publication,
Git push or user editor installation was performed.

## Updated local artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `artifacts/0disoft-typehtml-0.1.0-alpha.5.tgz` | 157620 | `c19d4644ef94c33258184478d30ab02389d8f09f9038066a4a40cb19a5310093` |
| `artifacts/typehtml-vscode-0.1.1.vsix` | 148021 | `ee4873270eb7d36d20cf9951030e4b49f1bb2eb8ad5c485573740ec86a6dfd10` |

Preserved comparison artifacts:

- alpha.4 tarball: 156382 bytes,
  `99355013230e77c585984a6d4add425e21f4ff3df3fbc5d91d36c6d3184f1efa`.
- VSIX 0.1.0: 147765 bytes,
  `5516a46405ed6d4f1b0fa4afcbc4c5a0e4f3d977d2b4298db6e909a8ac89c684`.

Fix commits: `f27cefd`, `1766527`, `0792476`, `991fd3b`, `4405b77`.
Package metadata: `3acd01a`. Installed RPC probe: `24d289a`.

## Unexecuted coverage

Actual VS Code extension-host UI execution remains **NOT_RUN**. Real protocol
tests and VSIX integrity checks do not establish full editor UI integration.
Node 22 minimum-version execution, Linux/macOS and complete framework host
applications were not rerun. Unsaved overlays, non-HTML parsers, arbitrary-schema
proof and whole-application completeness remain outside the documented scope.
