# Native VS Code UI verification

Date: 2026-11-08. This record supersedes the actual-editor **NOT_RUN** item in
the alpha.4/alpha.5 records for the environment and cases below. It is an
observed desktop session, not only a simulated client or protocol test.

## Environment and isolation

- Native Windows x64, VS Code **1.142.0** (`6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1`).
- Installed local `@0disoft/typehtml@0.1.0-alpha.5` tarball in the fixture
  workspace, and installed `0disoft.typehtml-doctor@0.1.1` from the local VSIX.
- Empty profile `TypeHTML-QA-20261108` and a dedicated extensions directory
  under `.typehtml/vscode-ui/extensions`. The normal profile's extension
  installation and settings were not edited. The workspace was trusted by
  VS Code without changing trust/security settings or accepting a security
  prompt. Editor accessibility was enabled only in the QA profile.
- Fixture: `.typehtml/vscode-ui/workspace`. Auto-save was disabled only in this
  fixture's workspace settings. All edited HTML and configuration files belonged
  to the fixture. No application server or external business operation ran.

The real window and its Problems/Output panels were operated and observed using
the Windows Computer Use skill. Process checks supplemented the UI observations.
The fixture generator is committed as `scripts/vscode-ui-fixture.ts` (`3620f48`).

## Observed cases

| Case | Observation | Result |
| --- | --- | --- |
| Local installation and activation | CLI confirmed VSIX 0.1.1 installed in the QA profile; opening HTML activated the extension and one Node LSP process. | PASS |
| Invalid small form | Problems showed exactly BC011 for undeclared `unknown` and BC010 for missing required `name`, with TypeHTML source and line locations. | PASS |
| Unsaved correction | Replaced `name="unknown"` with `name="name"` in the editor. The dirty buffer showed the correction; disk still contained `unknown`; both saved-file diagnostics remained. | PASS |
| Saved correction | Saved through VS Code. Problems changed to “No problems have been detected in the workspace.” | PASS |
| Undo and save | Undid the correction without saving: Problems stayed empty. Saving the invalid field restored exactly the two diagnostics. | PASS |
| First manual restart | Ran “TypeHTML: Restart Saved-Snapshot Doctor” from the command palette. The previous child exited; exactly one replacement ran; diagnostic count stayed two. | PASS |
| Configuration replacement | Changed the fixture's Doctor config to `doctor-large.json`; the old process was replaced and diagnostics moved to the selected large document. | PASS |
| Open large saved HTML | Opened **1,500,415 bytes** of HTML in the real editor. BC010/BC011 remained visible; the same LSP child remained alive across open. The document exceeds the 1,048,576-byte RPC cap and fits the 2 MiB snapshot cap. | PASS |
| Large edit and save | Unsaved correction kept the two diagnostics; saving cleared them. The saved file became 1,500,412 bytes and the LSP process remained unchanged. | PASS |
| Missing configuration | Selected a missing Doctor JSON file. The child was released (zero active Doctor processes). Output → TypeHTML Doctor visibly reported `ENOENT` and the fixture path, without a restart loop. | PASS |
| Recovery and repeated restart | Restored `doctor-all.json`: one child ran, the invalid small form showed two diagnostics and the corrected large form showed none. A second manual restart replaced the child without duplicate diagnostics or extra processes. | PASS |
| Window shutdown | Closed the QA window. A fresh window inventory returned no VS Code windows; the last child exited and zero fixture Doctor processes remained. | PASS |

No additional product defect was found in these cases, so no runtime code,
package version, or VSIX version was changed. The reproduction script and this
acceptance record are the only new repository content. `bun run typecheck` and
`git diff --check` passed. The previous full-suite/package results remain in
`DEVELOPER_TOOLS_REGRESSION_ALPHA5.md`; they were not needlessly rerun for a
documentation/fixture-only change.

## Reproduction

1. From the repository root, run
   `bun scripts/vscode-ui-fixture.ts <new-workspace-name>`. It installs the local
   tarball and verifies invalid small/large and valid snapshots with the actual
   installed Node CLI. It refuses an existing fixture directory so manual edits
   are preserved.
2. Open that fixture with `code --new-window --profile <qa-profile>` and a
   dedicated `--extensions-dir`. Opening first creates a missing empty profile;
   the CLI's install-only operation requires that profile to exist.
3. Use the same profile/extensions directory to install the local VSIX with
   `code --install-extension <absolute-vsix-path>`. Open `form.html` in VS Code.
4. Follow the table above. Use `doctor-large.json` for the large document and
   `doctor-all.json` for both documents. Valid/invalid restoration copies and
   expected CLI findings are in the fixture's `variants/` and
   `fixture-expectations.json`.

The QA profile and ignored fixture are retained for reproduction; the window and
all its Doctor processes were closed. No user working files, credentials or
security settings were changed. No publication or Git push was performed.

## Artifacts retained unchanged

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `artifacts/0disoft-typehtml-0.1.0-alpha.5.tgz` | 157620 | `c19d4644ef94c33258184478d30ab02389d8f09f9038066a4a40cb19a5310093` |
| `artifacts/typehtml-vscode-0.1.1.vsix` | 148021 | `ee4873270eb7d36d20cf9951030e4b49f1bb2eb8ad5c485573740ec86a6dfd10` |

This session does not establish Linux/macOS, VS Code 1.91 minimum-version,
remote/virtual workspace, multi-root UI, or Restricted Mode UI behavior. Saved
HTML is the supported analysis surface; unsaved overlays and source templates
remain outside its scope. The deliberate missing-config error is expected
negative-case evidence, not an unexplained runtime failure.
