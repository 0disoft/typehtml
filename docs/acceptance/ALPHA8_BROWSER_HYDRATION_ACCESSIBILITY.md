# Alpha 8 browser hydration and accessibility verification

Date: 2026-11-09 (Asia/Seoul). This supplements the earlier jsdom/framework-state and native VS Code checks with actual browser execution. One browser integration defect was reproduced and fixed. No registry or Marketplace publication was performed.

## Reproduced defect and compatibility

The existing `focusNativeErrorSummary` was reachable only through server-rendering/root exports. Importing it into a browser entry failed the actual consumer's browser build: `node:crypto` had no browser export named `timingSafeEqual`, reached through the root's server CSRF API. This prevented a consumer from using the supplied focus helper alongside the browser-safe framework connections.

The DOM-only function now lives in `src/form/focus.ts`. Both `@0disoft/typehtml/adapters/react` and `@0disoft/typehtml/adapters/svelte` re-export it. The existing root/native-render export, arguments, default options and return value are preserved; the two adapter exports reference the same function. The package root still contains server APIs and is not a browser entry point. Browser consumers should use the documented adapter imports. No form interception, automatic focus or new reactive state was introduced.

## Environment and reproducibility

- Windows x64, Bun 1.4.4, Node.js 24.14.0.
- Fresh installed `@0disoft/typehtml@0.1.0-alpha.8` tarball in a disposable consumer outside the source repository; no source aliases.
- React/React DOM 19.3.1; Svelte 5.57.3; Playwright 1.65.0; axe-core 4.14.0.
- Actual installed Google Chrome 155.0.8059.40, launched headless in an isolated profile. This is browser-engine execution, not jsdom.
- Both development and production server/client builds. React uses `renderToString` + `hydrateRoot` with a StrictMode root. Svelte uses independently compiled server/client components, `render` + `hydrate`, the real writable store and component lifecycle.
- Re-run from the repository with `bun scripts/browser-hydration-smoke.ts`. Requires Node/npm, Bun and an installed Chrome discoverable by Playwright's `chrome` channel. The script installs major-range framework/browser-check dependencies in its own temporary directory, starts a bounded loopback fixture and closes the browser/server and removes the consumer in `finally`. It does not install dependencies in the repository, publish packages or alter an existing browser session.

The fixture supplies synthetic initial/invalid native HTML to React `dangerouslySetInnerHTML` and Svelte `{@html}`. React additionally renders an input through `toReactFieldProps`. Browser-side event handlers and task state belong to the host components. The POST endpoint echoes fixture entries to verify native browser encoding; it is not a production validation endpoint.

## Observed browser results

All rows passed for **React development, React production, Svelte development and Svelte production**.

| Check | Observation |
| --- | --- |
| No-JavaScript baseline | Native text, checkbox, textarea, select and radio state remained usable. A real POST preserved entry order, checkbox omission and CRLF textarea encoding. Four POSTs passed. |
| Delayed hydration | The client bundle was held until text/textarea edits were made. Hydration reused the original input node and preserved those edits. React uncontrolled field-props edits also survived hydration and later state updates. |
| Native controls | Text edits, checked boolean, two ordered checkbox values, multiline text, changed select and radio produced the exact expected `FormData` sequence. |
| Host submission | Keyboard activation of the actual Save submitter entered submitting state, disabled the host start button and rejected another pending run with `SubmissionPendingError`. |
| Cancellation and stale work | Space activated Cancel, the task signal aborted, and resolving the cancelled operation could not replace a later pending operation. The later result completed normally. |
| Error propagation | An asynchronous host failure retained the original Error object. An already-aborted per-run signal retained its reason and invoked host work zero times. |
| Unmount | Unmount removed the component DOM and aborted its active task signal. |
| Keyboard and field semantics | Tab reached the next checkbox. Role/name queries found the expected labeled controls. All described-by/labelled-by targets existed; invalid text had `aria-invalid="true"`. |
| Summary focus | The newly exported browser helper focused the actual summary. Enter on its error link moved focus to the associated input. |
| Browser diagnostics | Zero captured console warnings/errors and zero page errors. React initial/invalid hydration recoverable-error lists were empty. |

axe-core ran the WCAG 2 A/AA and WCAG 2.1 A/AA tag sets on the initial/invalid documents in all four combinations:

| Build/framework | Initial rules passing | Invalid rules passing | Violations | Incomplete rules |
| --- | ---: | ---: | ---: | ---: |
| React development | 20 | 24 | 0 | 0 |
| React production | 20 | 24 | 0 | 0 |
| Svelte development | 20 | 24 | 0 | 0 |
| Svelte production | 20 | 24 | 0 | 0 |

This is eight automated document audits, with 176 passing rule/document results. It is not a count of distinct accessibility rules or a WCAG conformance certification. Screen-reader speech, visual design/zoom/high-contrast, other browser engines/mobile devices and arbitrary application routes were not tested. These selected fixtures do not prove application-wide behavior. The earlier P0 experiments remain NOT_RUN.

## Regression and packaging checks

- `bun test`: **704 tests, 5,154 assertions, zero failures** across 74 files. Includes the new shared-export regression and existing summary-focus/rendering/submission cases.
- `bun run typecheck` and `bun run generate:check`: passed; generated reference artifacts were current.
- `bun run pack`: built portable ESM/declarations and the local alpha.8 tarball.
- `bun run package:smoke`: **28 check groups passed**, including fresh npm/Bun consumers, Node/Bun runtime/CLI/types and standalone HTTP flows.
- `npm run package` in `integrations/vscode`: typecheck, dependency-notice preparation, build and VSIX packaging passed.
- `bun run starter:pack` and `bun run starter:smoke`: passed; extracted kit contained byte-identical current core/VSIX, and its relocatable Node initializer installed successfully.

VSIX 0.1.4 refreshes local release metadata/documentation. Its `extension/dist/extension.cjs` SHA-256 is byte-identical to 0.1.3: `ca8f4ceb05b9b814b9b8d08cdc9a0ac7340ef121452cd013ae528d467a572289`. No extension runtime changed, so this task did not repeat the previous native VS Code/multi-root/Restricted Mode GUI checks. Those observations remain recorded in `ALPHA7_VSCODE_NATIVE_VERIFICATION.md`.

| Local artifact | SHA-256 |
| --- | --- |
| `0disoft-typehtml-0.1.0-alpha.8.tgz` | `678b3d11703916b79d36ca12559e1f5e9cb51032d95ad18b45040aec1aeddca3` |
| `typehtml-vscode-0.1.4.vsix` | `fc58ae18312900509753edb07a4216e66d33c061e791ea2c0b130616b773958e` |
| `typehtml-starter-0.1.0-alpha.8.tar.gz` | `13e3f2bdc1d12c0efd9f6704d4910d613f53a98cea0e5a528d5f6562b5340bf6` |

Existing alpha.7/VSIX 0.1.3 artifacts were preserved. No npm/Marketplace publication or push was performed.
