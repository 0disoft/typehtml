# Alpha 7 regression review of the eight-stage implementation

Date: 2026-11-08. Reviewed the eight commits ending at `1e7ed96`; the initial working tree was clean. This delivery remains local-only: no npm/Marketplace publication or push.

## Confirmed defects and corrections

Every correction below has a regression that failed before the fix. Existing URL-encoded defaults, authorization hooks, response statuses, legacy scalar projections, and public field-props calls were retained.

| Defect | Before | Corrected behavior and regression |
| --- | --- | --- |
| Mixed indexed text/file assembly | `rows[0].file` plus `rows[1].caption` was rejected with 422 because the text tree was checked for holes before the file was attached. | Defer this check only for declared upload forms, then check the fully assembled tree. Valid input returns 303; an actual missing middle row returns 422; temporary files and expired capabilities are checked. |
| Disabled selected native choices | A scalar select/radio (including explicit boolean false selections) could omit the preserved raw value when its current option became disabled. | Use an editable text fallback without enabling the host's disabled choice. Native FormData retains the raw scalar; repeated ordering/duplicate behavior remains unchanged. |
| Incompatible scalar boolean rendering | An absent boolean rendered through a textarea override became the submitted true token `on`. | The new native renderer rejects incompatible scalar boolean controls; checkbox and explicit-false select remain supported. Existing `getSchemaFieldProps` behavior is unchanged. |
| Synchronous scheduler failure | A host scheduler that expired synchronously and then threw left an orphaned abort rejection, even when the caller caught the scheduling error. | Register the abort Promise only after scheduling succeeds. The task never executes; parent listeners and the pending guard are released; no unhandled rejection occurs. |
| Caller-owned projection cache | Public transport lookup cached mutable external JSON and reused stale declarations after a change; derived metadata could also bypass full validation. | Fully validate external projections on every lookup. Only internally owned immutable projections retain the O(1) cached lookup. Mutated/forged declarations fail instead of silently using a stale contract. |
| Captured native option labels | Sensitive select/datalist values and text were masked, but the `option label` attribute retained private data. | Mask explicit/implicit option labels and remove duplicate raw label attributes while retaining structural flags. Installed probes verify no synthetic label/value/text secret remains. |

Fix commits: `024ed0a` (upload assembly), `b8664a0` (native rendering/submission), `98db63d` (projection validation/capture labels). Packaging and additional installed probes are in the delivery commit containing this record.

The starter/runtime split, local dependency portability, parser limits, upload lifetime, hook order, and legacy Doctor paths had no additional confirmed defect in this review. A suspected multipart-origin bypass was rejected after tracing the independent `analyzeTarget` origin check; that code was not changed.

## Verification performed

- **703 tests / 5,149 assertions across 74 files**, zero failures. Strict type checking and unchanged-reference generation check passed.
- Fresh outside-repository npm and Bun consumers: **28 installed check groups**, including both Node/Bun runtimes, declarations with `skipLibCheck=false`, malformed wire input, rich contracts, mixed indexed uploads, actual gaps, exact file limits, cleanup and adapter exports.
- Both generated starter servers: GET 200, preserving invalid 422, success 303 and public receipt 200. Extracted kit: space-containing target, relocation, one npm install, current core bytes, current VSIX bytes and installed CLI all passed.
- Actual React **19.3.1**, React DOM **19.3.1**, Svelte **5.57.3**, jsdom **27.4.0**: **nine check groups** passed, including actual native FormData for disabled choices, incompatible boolean rejection, synchronous scheduler failure, StrictMode, pending/cancel/stale results, editable props and resource cleanup. This is a simulated DOM, not a real browser.
- Actual Hono **4.13.17**, Astro **7.4.7**, SvelteKit **3.1.1**, Svelte **5.57.3** and Vite **8.3.6**: **nine SSR states** passed with the installed alpha.7 capture adapter. Initial/422/dynamic rows, redaction and listener/temporary-directory cleanup were verified.
- Installed alpha.7 Node CLI JSON, SARIF and LSP agreed for two-error, one-error and zero-structural-error rich fixtures; file-content uncertainty remained visible.
- VSIX 0.1.3's independent type check and packaging passed. Its archive manifest declares the expected version and retains `untrustedWorkspaces.supported: false`. The executable extension bundle is byte-identical to 0.1.2: SHA-256 `ca8f4ceb05b9b814b9b8d08cdc9a0ac7340ef121452cd013ae528d467a572289`.

Native Windows used Node **24.14.0** and Bun **1.4.4**. Reproduction commands: `bun test`, `bun run typecheck`, `bun run generate:check`, `bun run package:smoke`, `bun run starter:smoke`, `bun scripts/framework-state-smoke.ts`, `bun scripts/framework-smoke.ts --package ./artifacts/0disoft-typehtml-0.1.0-alpha.7.tgz`, and `bun scripts/vscode-rich-fixture.ts <new-name>`.

## Updated local artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `artifacts/0disoft-typehtml-0.1.0-alpha.7.tgz` | 204257 | `e45004c7ba11ca2870fc5aadf558c49eaad8a12d90cbfd1dd5a94f9537dad0ef` |
| `artifacts/typehtml-starter-0.1.0-alpha.7.tar.gz` | 359824 | `58d659661916eeed9f3564fb1d5e4b411a0be322f937c9cd8ce074df447dfe9b` |
| `artifacts/typehtml-vscode-0.1.3.vsix` | 148022 | `a8e7c77dcb884d0dad949e9271c14c30d28955d1635312ca5895358508a4f69a` |

The kit contains byte-identical copies of the current core archive and VSIX. Existing alpha.6 artifacts and acceptance records were preserved.

## Not repeated or not claimed

Real VS Code window/multi-root/Restricted Mode interactions were not repeated in this review; the unchanged extension bundle has the native evidence in `ALPHA6_EIGHT_STAGES.md`, and the changed CLI was exercised through installed LSP. No real-browser hydration/accessibility audit or native Node 22 execution was performed. Opaque validators, actual file content and complete application behavior remain outside static proof. P0/product-fit and power-loss experiments remain excluded by the owner's earlier decision. These checks support the specific corrections and regression coverage, not a claim that every application scenario is bug-free.
