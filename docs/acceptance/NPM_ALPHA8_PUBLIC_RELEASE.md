# First public npm release: alpha.8

Date: 2026-11-09 (Asia/Seoul). The owner authorized public npm publication after making `0disoft/typehtml` public. This records the actual registry release and installation verification, not only a local package build.

## Published package

- Package: [`@0disoft/typehtml@0.1.0-alpha.8`](https://www.npmjs.com/package/@0disoft/typehtml/v/0.1.0-alpha.8).
- Registry: `https://registry.npmjs.org/`; access status: `public`.
- Observed dist-tags: `alpha` and `latest` both point to `0.1.0-alpha.8`. npm initialized `latest` during the first registration. Documentation explicitly uses `@alpha` or the exact version; this is still a prerelease with no stable API promise.
- Verified archive source commit: `8430f591f6b22ed4a05c49cf070579dc3c5eb48f`. No core implementation changed from the previously verified alpha.8; this preparation updated public installation/release documentation and added registry verification tooling.
- Publish command: `npm publish ./artifacts/0disoft-typehtml-0.1.0-alpha.8.tgz --ignore-scripts --access public --tag alpha --registry=https://registry.npmjs.org/`.
- npm returned `+ @0disoft/typehtml@0.1.0-alpha.8` and exit 0 after npm's own browser authentication. An earlier expired authentication attempt failed without publishing; the registry was checked before retrying.
- Public metadata initially lagged the successful upload and showed a `0.0.0-stage` placeholder. Checks continued until the exact version, full metadata, tarball and normal client installation were available. The staged-package list was empty; the placeholder was not treated as a completed TypeHTML release.

The exact prebuilt archive was published, rather than repacking the source during upload. The registry metadata contains no `gitHead`; this document records the source commit. This local publication does not claim an OIDC provenance statement.

## Archive identity

- 194 files; compressed size 205,515 bytes; unpacked size 817,298 bytes.
- Includes 183 compiled JavaScript/declaration/reference files under `dist/`, seven user guides, README, changelog, license and package metadata.
- Publish dry-run review found no `.npmrc`, `.env`, `node_modules`, tests, source scripts, agent instructions or source-only research records in the archive.
- Registry tarball: `https://registry.npmjs.org/@0disoft/typehtml/-/typehtml-0.1.0-alpha.8.tgz`.
- SHA-1: `b6f92c97e657c1af93ab33c73e26122a880c2cca`.
- SHA-256: `fe45d6853272781b57ca9ff06768d9595851d1493307921328cd7c01c69d6956`.
- Registry SHA-512 integrity: `sha512-sMVX+oM65v2DGAlRcKxkUQrPQ7G2UqWDHEQnrdZCUCu6VFaS6t6Y+PVTUOwr+E5CVbb5uME4Qx6GHOMoP/UbaA==`.

The independently downloaded registry tarball matched both its advertised SHA-512 and the complete bytes of the verified local archive. The earlier browser acceptance document retains its historical pre-publication archive hash; this publication includes the updated installation documentation and therefore has a different archive hash at the same previously unpublished version.

## Executed verification

| Check | Result |
| --- | --- |
| TypeScript no-emit check | PASS |
| CLI/initializer unit tests | 12 tests, 171 assertions, zero failures |
| Reference generation check | PASS; generated files current |
| Fresh local archive consumers | 28 package-smoke groups passed, including npm/Bun installation, Node/Bun runtime/types/CLI and standalone native HTTP flows |
| npm publish dry run | PASS; exact archive and file allowlist reviewed |
| Registry download | PASS; advertised integrity and byte-for-byte local comparison |
| Anonymous npm consumer | PASS; exact-version install and installed CLI, with empty npm user/global configuration and a new temporary cache |
| Public `npx @alpha` initialization | PASS; Node/npm project in a space-containing path, registry dependency installation, generation, generated/type/Doctor checks and ESM build |
| Public `bunx @alpha` initialization | PASS; Bun project, registry dependency installation, generation and generated/type/Doctor checks |
| Temporary consumers | Removed in `finally`; no application server was started by the registry probe |

Reproduce the registry checks with `bun scripts/registry-smoke.ts`. It reads the current package version and compares the public tarball against the existing local archive; it does not publish. Its metadata requests use npm's scoped registry path and an explicit JSON Accept header.

The prior full suite (704 tests, 5,154 assertions) and actual Chrome React/Svelte hydration/accessibility verification are recorded in `ALPHA8_BROWSER_HYDRATION_ACCESSIBILITY.md`. Those unchanged implementation checks were reused rather than rerunning the full suite for documentation-only publication preparation. Browser engines/screen readers and application-wide behavior outside that earlier scope remain unverified. P0 experiments remain NOT_RUN.

## Local companion artifacts

Public installation documentation was also refreshed in the local VSIX/starter kit. Versions were retained because no extension/core behavior changed during publication preparation.

| Artifact | SHA-256 |
| --- | --- |
| `typehtml-vscode-0.1.4.vsix` | `48e87439fc9989dc9674f9a700a4932ac8c8f181962cf68fca1e82f4a82bff3b` |
| `typehtml-starter-0.1.0-alpha.8.tar.gz` | `c48896050d8d904cdea82a87836b021216911a57653423e9aa83b71883056e1d` |

VSIX packaging and starter-kit extraction/install verification passed. The extension JavaScript hash remains `ca8f4ceb05b9b814b9b8d08cdc9a0ac7340ef121452cd013ae528d467a572289`, unchanged from the previously verified editor build. No new editor GUI run, Marketplace publication or GitHub release-asset upload was performed. Local `artifacts/` files remain ignored by Git; npm now hosts the core archive independently.
