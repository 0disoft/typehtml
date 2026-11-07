# TypeHTML Doctor for VS Code

This optional desktop extension connects the locally installed TypeHTML CLI to
VS Code's Problems panel. It analyzes **saved HTML snapshots explicitly listed
in a Doctor configuration**. It does not analyze unsaved changes, JSX/TSX,
Astro/Svelte source, application routes, or arbitrary templates. Diagnostics
retain Doctor's supported/unknown analysis status; they do not prove complete
application correctness.

## Install locally

1. Install the TypeHTML `.tgz` in your application using `npm install <archive>`
   or `bun add <archive>`.
2. In VS Code, choose **Extensions: Install from VSIX...** and select
   `typehtml-vscode-0.1.0.vsix` from this repository's `artifacts/` directory.
3. Open a trusted local workspace folder and configure its Doctor JSON path:

```json
{
  "typehtml.doctorConfig": "snapshots/doctor.config.json"
}
```

Open or save an HTML file to run Doctor. Use **TypeHTML: Restart Saved-Snapshot
Doctor** after changing the configuration JSON, contract files, or HTML files
outside VS Code. Editing text without saving leaves diagnostics based on the
last saved snapshot. For rendered applications, recapture HTML before saving
or restarting Doctor.

All configuration and CLI paths must be relative to the workspace folder and
remain inside it. `typehtml.cliPath` defaults to
`node_modules/@0disoft/typehtml/dist/cli.js`. If Node.js 22+ is not on VS Code's
PATH, set `typehtml.nodePath` to its executable in **user settings**; this setting
does not accept arguments and cannot be controlled by workspace settings.
Each local workspace folder with a nonempty `typehtml.doctorConfig` gets its
own client. An empty path disables that folder. Restricted Mode and virtual
workspaces do not launch workspace executables.
Filesystem links are resolved before launch; CLI/configuration links to a
location outside the workspace folder are rejected. Install the package inside
that folder rather than linking to an external checkout or global package store.

The extension launches Node directly with separate argument values and no shell.
Restart/configuration changes await shutdown of the previous client. Failed
clients do not restart in a loop; inspect **Output → TypeHTML Doctor**, fix the
configuration/runtime problem, and run the restart command. Initialization has
a 10-second deadline, after which client shutdown and disposal run.

## Build the VSIX

From `integrations/vscode`:

```sh
npm ci --ignore-scripts
npm run package
```

Packaging runs the extension type check and bundles its language client with
Bun, then uses Microsoft's `@vscode/vsce` to create an installable VSIX in
`artifacts/`. It does not publish to the Marketplace. Node.js 22+ and Bun 1.4+
are required to build. The editor dependencies are isolated here and are not
added to the TypeHTML npm package. `minimatch` is intentionally promoted to its
patched major 11 for the language client/packager; the compatibility check below
and VSIX packaging exercise the APIs they use.

Focused launch/lifecycle tests run from the repository root:

```sh
bun test test/integrations/vscode.test.ts
```

The tests cover trust/opt-in gates, argument boundaries, filesystem-link escape,
serialized replacement, startup deadlines, disposal during factory/startup waits,
and real Node child termination and stream cleanup. A real VS Code
extension-host session must still be checked separately; unit tests and creating
a VSIX alone do not prove the editor's complete UI integration.

References: [VS Code language server guide](https://code.visualstudio.com/api/language-extensions/language-server-extension-guide),
[Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust),
and [local VSIX packaging](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
