# Alpha 7 native VS Code verification

Date: 2026-11-09 (Asia/Seoul). This supplements the earlier alpha.7 code regression review with newly executed native desktop checks. No product defect was found; no core/extension source or installation artifact was changed.

## Environment and isolation

- Windows x64; VS Code 1.145.2, build `c4453f8ea430795f941c1b2ff6c9321135a74a02`.
- Fresh locally installed core `0.1.0-alpha.7` and VSIX `0.1.3`, using dedicated `alpha7-ui-data` and `alpha7-ui-ext` directories.
- New rich fixture `alpha7-ui-20261109` and independent Alpha/Beta installations under `alpha7-multi-20261109`, created by the existing fixture scripts. Their installed Node CLI checks, including rich JSON/SARIF/LSP parity, passed before GUI testing.
- Restricted fixture `alpha7-restricted-20261109` used separate fresh user-data and shared-data directories, with `--skip-welcome` from first launch. No trust action, security-setting change or authentication dialog was operated. Other applications were preserved.

## Observed desktop results

| Check | Observation | Result |
| --- | --- | --- |
| Rich initial form | Problems displayed two BC011 errors (encoding and duplicate scalar) and one BC012 file-content unknown, with visible fix descriptions. | PASS |
| Unsaved correction | Editor contained multipart enctype but disk did not; both saved-snapshot errors remained. | PASS |
| First saved correction | Encoding error cleared; duplicate scalar and file-content unknown remained. | PASS |
| Second saved correction | Structural errors cleared; file-content unknown and explanation remained. | PASS |
| Single-folder shutdown | Its Doctor child exited after closing the QA window; zero matching processes remained. | PASS |
| Multi-root activation | Alpha/Beta each showed two errors, four total, using two distinct installed Doctor processes. | PASS |
| Independent saved state | Alpha's unsaved correction retained four errors; saving it cleared only Alpha's errors, leaving Beta's two. | PASS |
| Remove live root | Removing Beta from the same workspace file cleared Beta's diagnostics and reduced Doctor processes from two to one; Alpha remained clean. | PASS |
| Re-add live root | Restoring Beta brought back exactly its two errors and two total Doctor processes. | PASS |
| Restart through UI | “TypeHTML: Restart Saved-Snapshot Doctor” replaced PIDs 9140/11384 with 5460/19596. Old children exited and exactly two errors remained, without duplicate diagnostics. | PASS |
| Multi-root shutdown | Closing its QA window left zero matching Doctor processes. | PASS |
| Restricted Mode | Banner and status retained Restricted Mode; installed TypeHTML Doctor 0.1.3 was greyed out. Its details showed the shield explanation, “Runs the workspace's locally installed TypeHTML CLI.” | PASS |
| Restricted execution boundary | A harmless canary executed directly produced its positive-control marker. During and after the restricted session, its execution marker was absent. HTML language activation was logged once; no TypeHTML activation or fixture Doctor child appeared. | PASS |
| Final cleanup | All dedicated QA windows closed; zero matching Doctor processes and no restricted execution marker remained. | PASS |

This run did not repeat the earlier broken-config GUI case or edit/save Beta to clear its errors; it verified Beta's independent persistence, removal, restoration and restart instead. Editor diagnostics intentionally use saved selected HTML rather than unsaved buffers or application-wide analysis. File bytes and opaque runtime validation remain outside static proof.

The targeted `bun test test/integrations/vscode.test.ts` passed: **16 tests, 49 assertions**, zero failures. Only this acceptance document changed, so unrelated full core/SSR checks were not repeated.

## Artifact preservation

Fresh SHA-256 checks matched the alpha.7 delivery record. Since no product change was required, the verified existing installation artifacts were retained without a version bump or rebuild:

| Artifact | SHA-256 |
| --- | --- |
| `0disoft-typehtml-0.1.0-alpha.7.tgz` | `e45004c7ba11ca2870fc5aadf558c49eaad8a12d90cbfd1dd5a94f9537dad0ef` |
| `typehtml-vscode-0.1.3.vsix` | `a8e7c77dcb884d0dad949e9271c14c30d28955d1635312ca5895358508a4f69a` |
| `typehtml-starter-0.1.0-alpha.7.tar.gz` | `58d659661916eeed9f3564fb1d5e4b411a0be322f937c9cd8ce074df447dfe9b` |

No npm/Marketplace publication or push was performed.
