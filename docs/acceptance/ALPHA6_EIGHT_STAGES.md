# Alpha 6 eight-stage implementation and verification

Date: 2026-11-08. Local installation delivery only; no npm/Marketplace publication or push.
Existing flat URL-encoded forms, hook order, error statuses, scalar projection formats and saved-snapshot editor behavior remain supported.

## Completed stages

| Stage | Delivered behavior | Scoped commit |
| --- | --- | --- |
| 1 | Standalone relocatable starter kit, sibling local tarball, automatic relative package dependency | `43ed392` |
| 2 | Independent Node/Bun runtime and npm/Bun manager; compiled Node ESM starter | `e6811da` |
| 3 | Shared immutable normalized transport declarations for decoding and HTML helpers | `e45b220` |
| 4 | Bounded dynamic object rows, canonical names, stable caller-owned identity and immutable array helpers | `9cd8294` |
| 5 | Opt-in streaming multipart/files, exact payload/count/deadline limits, private temporary storage and request cleanup | `7a4cc5e` |
| 6 | Verified rich wire manifests, generator/Doctor integration, count intervals and actionable SARIF/LSP metadata | `b4139e2` |
| 7 | Shared initial/422 rendering, accessible labels/errors/focus, input-only preview and thin host React/Svelte state connections | `6599f70` |
| 8 | Explicit redacted framework captures, actual installed-framework/editor regression checks, documentation and refreshed local artifacts | Delivery commit containing this record |

Each stage was checked before its scoped commit. The final integrated unit run passed **697 tests / 5,102 assertions across 74 files**, with zero failures. Strict type checking, unchanged-reference generation check, and diff whitespace checks passed. The extension's independent type check and VSIX build also passed.

## Installed artifacts and actual framework checks

- Fresh npm and Bun consumers installed the alpha.6 tarball outside the repository. **28 check groups** passed: Node/Bun public imports, inferred declarations with `skipLibCheck=false`, existing handlers and socket adapters, collections, request-owned uploads and cleanup, exact 4-byte file payload/5-byte rejection, native rendering, rich projection, and new adapter exports.
- Both generated starter servers served GET 200, preserving invalid 422, success 303 and public receipt 200. The Node starter compiled ESM before execution. The extracted standalone kit passed initialization into a path containing spaces, byte-identical local dependency, relocation, one npm install and installed CLI checks.
- Actual installed React **19.3.1**, React DOM **19.3.1**, Svelte **5.57.3** and jsdom **27.4.0** passed seven state/lifecycle groups: StrictMode effect replay, duplicate guard, cancellation, stale-result suppression, editable uncontrolled props, unmount, timer/listener/subscription cleanup. This used a **simulated DOM, not a real browser**.
- Actual Hono **4.13.17**, Astro **7.4.7**, SvelteKit **3.1.1**, Svelte **5.57.3** and Vite **8.3.6** rendered initial, invalid 422 and dynamic two-row pages: **nine states** passed using the installed public capture subpath. Redaction/status/row metadata were checked. Owned loopback servers were closed and refused follow-up connections; temporary consumers were removed.
- Installed Node CLI JSON, SARIF and LSP reports agreed for rich fixtures with two errors, one corrected error, and zero structural errors. File-content uncertainty remained visible in every appropriate state.

Reproduction: `bun run package:smoke`, `bun run starter:smoke`, `bun scripts/framework-state-smoke.ts`, and `bun scripts/framework-smoke.ts --package ./artifacts/0disoft-typehtml-0.1.0-alpha.6.tgz`. Fixture dependencies follow explicit major ranges and may resolve newer compatible stable patches on later runs. Node **24.14.0** and Bun **1.4.4** were used here; the test frameworks' engine requirements are separate from the core Node 22+ contract.

## Native Windows VS Code observations

VS Code **1.145.2**, build `c4453f8ea430795f941c1b2ff6c9321135a74a02`, x64; local TypeHTML Doctor **0.1.2** VSIX. Computer-use automation operated only dedicated QA windows and synthetic fixture documents.

| Case | Observed result |
| --- | --- |
| Rich initial state | Problems showed two BC011 errors plus one BC012 file-content unknown. Fix text was visible for each finding. |
| Unsaved encoding correction | The editor showed the new enctype, disk retained the invalid form, and both saved-snapshot errors remained. |
| Saved encoding correction | The encoding error cleared; duplicate scalar error and file-content unknown remained. |
| Saved duplicate correction | Structural errors reached zero; file-content unknown and its explanation remained. |
| Multi-root activation | Alpha and Beta used their separate installed CLIs/configs; four errors and exactly two Doctor processes appeared. |
| Multi-root independence | Alpha's unsaved correction retained all four errors. Saving Alpha cleared only its two errors; Beta retained its two. |
| Trusted window shutdown | Rich and multi-root Doctor children exited after their owned windows closed. |
| Restricted Mode | A fresh user-data **and shared-data** directory retained the Restricted Mode banner/status. Installed extension 0.1.2 was greyed out with its shield explanation, “Runs the workspace's locally installed TypeHTML CLI.” |
| Restricted execution boundary | A directly invoked harmless canary produced a positive-control marker. The restricted editor never invoked it; no execution marker or Doctor process appeared. The HTML language extension activated while TypeHTML did not. |
| Final cleanup | Dedicated QA windows closed; zero fixture Doctor processes remained and the restricted canary marker was still absent. |

No trust/security action, authentication dialog or unrelated window was operated. The fresh restricted shared storage was needed to avoid inheriting an already trusted parent. Broader root-removal/re-addition, restart and broken-config lifecycle cases remain covered by the existing automated tests and earlier alpha.5 native record; those additional GUI cases were not repeated for this delivery. The new rich fixture is reproducible with `bun scripts/vscode-rich-fixture.ts <new-name>`; it refuses existing paths.

## Local delivery artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `artifacts/0disoft-typehtml-0.1.0-alpha.6.tgz` | 203261 | `fb6826134b92c3809fc533523817f25af759338dce4c809a7b751fee7f29cdbe` |
| `artifacts/typehtml-starter-0.1.0-alpha.6.tar.gz` | 358813 | `f3c496d98ddeba3d50ce1c68cd32477f4eaf4433e08c3c1ba590df4aafbb5ef7` |
| `artifacts/typehtml-vscode-0.1.2.vsix` | 148021 | `cf9968fc3a579f3de0d7cd3576989fd62795235d5225e667570b57782ceed19c` |

The starter kit includes the same core archive and the new VSIX. Third-party dependency installation may require network access; this is not a fully offline dependency bundle.

## Explicit remaining limits

P0 comparison/product-fit and power-loss experiments remain excluded by the owner's recorded decision; these functional checks are not P0 evidence. No client hydration or real-browser React/Svelte accessibility audit was performed. Doctor does not prove opaque schema refinements, file content, future JavaScript states, authorization or database effects. Dynamic-row file slots and nested row collections remain unsupported and reject explicit declarations. Upload capabilities expire with the request; applications must await durable copies and perform their own content inspection. Client cancellation does not undo committed effects and submission helpers never retry POST operations. Capture redacts declared control values, not arbitrary secrets anywhere in a production page. Publication remains a separate owner decision.
