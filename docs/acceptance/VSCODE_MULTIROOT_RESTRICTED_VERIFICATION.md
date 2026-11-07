# VS Code multi-root and Restricted Mode verification

Date: 2026-11-08. This record covers observed native desktop behavior. It
extends `VSCODE_UI_VERIFICATION.md` with multi-root and Restricted Mode cases;
it does not replace that record's separate editor build and single-folder
observations.

## Environment and fixture

- Native Windows x64, VS Code **1.145.2**
  (`c4453f8ea430795f941c1b2ff6c9321135a74a02`).
- QA profile: `TypeHTML-QA-20261108`.
- Installed local `@0disoft/typehtml@0.1.0-alpha.5` tarball and local
  `0disoft.typehtml-doctor@0.1.1` VSIX.
- Two workspace folders, displayed as **Alpha Forms** and **Beta Forms**, each
  with its own installed CLI, Doctor configuration, contract and `form.html`.
  The matching HTML basenames deliberately require folder-aware diagnostics.
- Alpha requires `name`, while its invalid snapshot submits `unknown`. Beta
  requires `email`, while its invalid snapshot submits `wrongEmail`. Each
  invalid snapshot therefore produces BC010 and BC011, for four findings in
  total.

The real VS Code window, Problems panel and command palette were operated and
observed. Native process checks supplemented the UI evidence. The reusable
fixture generator is `scripts/vscode-multiroot-fixture.ts`, committed as
`da75a86`. It installs the local archive and verifies each folder's invalid and
valid cases with its installed Node CLI before editor testing.

## Observed multi-root cases

| Case | Observation | Result |
| --- | --- | --- |
| Independent activation | Problems showed four findings: Alpha's missing `name`/undeclared `unknown` and Beta's missing `email`/undeclared `wrongEmail`. Exactly two Node Doctor processes ran. | PASS |
| Alpha unsaved correction | Corrected Alpha's field in the editor without saving. Disk still held the invalid field and all four saved-snapshot findings remained. | PASS |
| Alpha saved correction | Saving Alpha cleared its two findings. Exactly Beta's two findings remained. | PASS |
| Beta unsaved correction | Corrected Beta without saving; its two findings remained. | PASS |
| Beta saved correction | Saving Beta cleared the remaining two findings. Problems showed zero findings. | PASS |
| Lifecycle baseline | Restored both invalid saved snapshots. Problems again showed exactly four findings, with two Doctor processes. | PASS |
| One broken configuration | Set Alpha to a missing Doctor configuration. Beta retained exactly its two findings and its one Doctor process; Alpha had no Doctor process. | PASS |
| Configuration recovery | Restored Alpha's configuration. Problems returned to exactly four findings and two Doctor processes. | PASS |
| Remove a live root | Removed Beta from the same open workspace file. Only Alpha's two findings and one Doctor process remained. | PASS |
| Re-add a live root | Added Beta back to that same workspace file. Exactly four findings and two Doctor processes returned. | PASS |
| Manual restart | Ran “TypeHTML: Restart Saved-Snapshot Doctor” in the UI. Both previous children, PIDs `27904` and `28448`, exited. Replacement PIDs `17608` and `32548` ran, with exactly four findings and no duplicates. | PASS |
| Window shutdown | Closed the multi-root window. A fresh window inventory no longer contained it; both final children exited and zero fixture Doctor processes remained. | PASS |

The completed cases did not expose a product defect or require source changes.
Changing the folder set or TypeHTML settings intentionally refreshes all
configured clients; replacement of both PIDs is consistent with that policy.
No package or extension version was changed for these completed checks.

## Restricted Mode

| Check | Observation | Result |
| --- | --- | --- |
| Editor restriction | The final `restricted-stable-workspace` window displayed the Restricted Mode banner and status-bar explanation that the folder was not trusted, after opening `form.html` and completing initialization. | PASS |
| Extension status | Extensions showed installed TypeHTML Doctor 0.1.1 greyed out. Its details displayed the shield and manifest explanation, “Runs the workspace's locally installed TypeHTML CLI.” The restriction indicator remained visible throughout inspection. | PASS |
| Execution boundary | The harmless configured CLI writes a marker if invoked. No marker existed during the final restricted session or after closing it; zero fixture Doctor processes ran. The earlier trusted preflight had successfully produced a marker, so absence is not explained by a broken canary path. | PASS |
| Settled host state | The final session log recorded one HTML language-extension activation and zero TypeHTML activations. Its isolated shared storage contained zero trusted URIs. | PASS |
| Existing isolation | Fresh workspace, user-data and shared-data directories isolated the final session. `--skip-welcome` omitted onboarding without operating an authentication dialog. No Trust action or security-setting change was issued by the agent. | PASS |
| Shutdown | Closed the final test window, confirmed its main process exited, and confirmed zero fixture Doctor processes. A separately reopened VS Code window was preserved. | PASS |

Source review confirms two defenses: the extension manifest declares
`untrustedWorkspaces.supported: false`, and `createLaunchPlan` returns `null`
when `workspace.isTrusted` is false before resolving or launching workspace
executables. The editor and canary observations above independently exercise the
execution boundary.

A separate installation of VSIX 0.1.1 was prepared with fresh
`restricted-user-data-20261108` and `restricted-extensions-20261108` directories.
Opening `restricted-workspace/form.html` did **not** establish Restricted Mode:
no restriction indicator was observed, and its harmless `canary.cjs` executable
recorded one launch before exiting. The resulting connection error is expected
for that deliberately non-LSP executable. This is a failed test precondition,
not evidence that TypeHTML executed inside Restricted Mode. VS Code 1.145.2
stores its trust model in application-shared storage: changing only
`--user-data-dir` still inherited an existing trusted ancestor. Adding a fresh
`--shared-data-dir` was necessary. A manual inspection request was withdrawn
when this safe isolation route was identified.

An intermediate `restricted-isolated-workspace` initially showed Restricted Mode
and no execution, but later acquired a trusted entry while that window was
open. The logs do not identify the cause. Its later executions are excluded
from Restricted Mode evidence. The first such execution preceded the subsequent
onboarding-skipping relaunch, so that flag cannot explain the earlier trust
transition. The final acceptance run used new
`restricted-stable-workspace`, `restricted-stable-user-data-20261108` and
`restricted-stable-shared-data-20261108` paths, with `--skip-welcome` from the
first launch. It retained the restriction throughout the complete inspection
and left no canary marker. Neither an authentication dialog nor a trust prompt
was operated. The dedicated preflight/intermediate app instances were stopped
after inspection; no graceful-shutdown claim is made for those instances.

The targeted `bun test test/integrations/vscode.test.ts` check passed: **16
tests, 49 assertions, zero failures**. It includes the untrusted launch gate,
client replacement/disposal and owned-process cleanup. `bun run typecheck`
also passed. These results support the independently observed editor behavior.

## Reproduction

1. From the repository root, run
   `bun scripts/vscode-multiroot-fixture.ts <new-fixture-prefix>`. The script
   refuses existing fixture paths to preserve manual edits.
2. Open the generated `.typehtml/vscode-ui/<new-fixture-prefix>.code-workspace`
   with the QA profile and dedicated extensions directory containing VSIX
   0.1.1. Open each folder's `form.html`.
3. Follow the multi-root table. Correct Alpha from `name="unknown"` to
   `name="name"`, and Beta from `name="wrongEmail"` to `name="email"`.
   Check unsaved and saved states separately.
4. Restore both invalid snapshots for lifecycle checks. Break and restore only
   Alpha's `typehtml.doctorConfig`. Remove and re-add Beta in the same workspace
   file, then run the restart command.
5. Close the multi-root test window and verify its two children exit.
6. For Restricted Mode, copy a valid fixture to a new workspace, replacing
   `typehtml.cliPath` with a harmless local canary that appends a marker beside
   itself and exits. Keep a valid Doctor config and open `form.html`. Install
   the VSIX and launch using the same dedicated `--extensions-dir`, plus fresh
   `--user-data-dir` **and** `--shared-data-dir`. Use `--skip-welcome` from the
   first launch to omit onboarding. Do not use `--disable-workspace-trust`.
7. Observe the Restricted Mode banner/status and the extension's shield
   explanation in Extensions. Verify no marker or Doctor child appears, then
   close only that test window. If the workspace becomes trusted, exclude that
   interval rather than treating it as a Restricted Mode result.

## Artifact verification

No artifact regeneration is required by the completed documentation/fixture-only
work. A fresh SHA-256 comparison in this session confirmed both existing local
artifacts unchanged.

| Artifact | Bytes | SHA-256 verified this session |
| --- | ---: | --- |
| `artifacts/0disoft-typehtml-0.1.0-alpha.5.tgz` | 157620 | `c19d4644ef94c33258184478d30ab02389d8f09f9038066a4a40cb19a5310093` |
| `artifacts/typehtml-vscode-0.1.1.vsix` | 148021 | `ee4873270eb7d36d20cf9951030e4b49f1bb2eb8ad5c485573740ec86a6dfd10` |

These cases do not establish Linux/macOS, the VS Code 1.91 minimum version,
remote/virtual workspaces, nested-root behavior or source-template analysis.
The VSIX and core archive were retained unchanged because no product defect was
found. No npm or Marketplace publication or Git push was performed.
