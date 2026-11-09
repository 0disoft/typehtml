# Releasing TypeHTML

The public package is `@0disoft/typehtml`. Prereleases use the `alpha` dist-tag and public access. Do not promote an alpha to `latest` as part of a routine alpha release. npm core publication, Git push/tags, GitHub release assets and Marketplace publication are separate actions. This guide does not configure automatic publishing or CI jobs.

## Prepare the source

1. Confirm the target version is not already published with `npm view @0disoft/typehtml@<version> version`. npm versions cannot be overwritten.
2. For a new code release, update `package.json` and `src/version.ts` together, add its changelog entry and update current installation examples. Historical acceptance records and `docs/design/v0.5/` remain unchanged. Documentation-only preparation before the first publication of an unused version does not need another version bump.
3. Review the exact working tree and commit the intended source/documentation. Preserve unrelated changes. Record the source commit in the release acceptance report.

Use Node.js 22+, Bun 1.4+ and npm. Authenticate locally with `npm login --auth-type=web --registry=https://registry.npmjs.org/`, completing login and any required 2FA in npm's own flow. Never put credentials or authentication material in source, reports or chat. `npm whoami` and `npm org ls 0disoft` can confirm identity and organization access without printing credentials.

## Verify the exact archive

From the repository root:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run generate:check
bun run pack
bun run package:smoke
```

Reuse passing checks for unchanged source rather than repeatedly running identical suites. `pack` builds once and writes `artifacts/0disoft-typehtml-<version>.tgz`. `package:smoke` installs that archive into fresh npm/Bun consumers outside the repository and verifies runtime, declarations, CLI and native HTTP flows. For browser-facing changes, also run `bun scripts/browser-hydration-smoke.ts`; this needs installed Chrome and temporary framework dependencies.

Review a publish dry run using the **archive**, not a source-directory publish that could rebuild different bytes:

```sh
npm publish ./artifacts/0disoft-typehtml-<version>.tgz --dry-run --ignore-scripts --access public --tag alpha --registry=https://registry.npmjs.org/
```

The allowlist is compiled `dist/`, README, license, changelog and the selected user guides declared in `package.json`. Inspect the reported files; credentials, local configuration, tests, caches, `node_modules`, editor bundles and source-only research records do not belong in the core archive. Record its SHA-256/SHA-512 and file count. Do not edit the archive or rebuild it between verification and publication.

## Publish and verify

Only after publication is explicitly authorized:

```sh
npm publish ./artifacts/0disoft-typehtml-<version>.tgz --ignore-scripts --access public --tag alpha --registry=https://registry.npmjs.org/
npm view @0disoft/typehtml@<version> version dist.integrity dist.tarball --json --registry=https://registry.npmjs.org/
npm dist-tag ls @0disoft/typehtml --registry=https://registry.npmjs.org/
```

Complete npm's own authentication/2FA challenge when requested. If a request fails or times out ambiguously, query the exact registry version before retrying; do not assume the upload failed or change versions blindly. Download the registry tarball and compare its SHA-512 integrity and bytes with the verified local archive. Use a fresh consumer/cache to install the exact published version and execute the documented registry `npx`/`bunx` starter flow. Verify `alpha` points to the intended version.

`bun scripts/registry-smoke.ts` performs those public registry/download checks and fresh npm/Node and Bun starter generation/checks for the current version. It uses dedicated temporary caches and empty npm configuration files, then removes its consumer. It does not publish, start a server or require registry authentication.

Record the registry URL, version, dist-tag, source commit, archive integrity and actual verification outcomes under `docs/acceptance/`. A successful npm upload does not prove that CI, Marketplace publication, every application route or every browser was tested. Commit the release evidence and push only the authorized commits/tags.

## Optional local editor and starter-kit artifacts

The VSIX is separate from the npm core package and has no Marketplace listing:

```sh
# In integrations/vscode:
npm ci
npm run package
# Back in the repository root:
bun run starter:pack
bun run starter:smoke
```

Update the extension version when its release-relevant behavior changes; documentation-only updates do not require a version bump. The starter kit embeds the current core tarball and VSIX when present. Verify their hashes after extraction. `artifacts/` is ignored by Git: pushing source does not back up those generated archives. Rebuild them from source or distribute them through an explicitly authorized release-asset channel.
