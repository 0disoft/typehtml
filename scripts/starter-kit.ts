import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const artifactName = `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`;
const artifacts = join(root, 'artifacts');
const stagingRoot = join(root, '.typehtml');
await mkdir(stagingRoot, { recursive: true });
await mkdir(artifacts, { recursive: true });
const stage = await mkdtemp(join(stagingRoot, 'starter-kit-'));
const archive = join(artifacts, `typehtml-starter-${manifest.version}.tar.gz`);
const temporaryArchive = join(stage, 'kit.tar.gz');
try {
  const contents = join(stage, 'typehtml-starter');
  await mkdir(contents);
  await copyFile(join(artifacts, artifactName), join(contents, 'typehtml.tgz'));
  const built = await Bun.build({ entrypoints: [join(root, 'scripts/starter-bootstrap.ts')], target: 'node', format: 'esm',
    outdir: contents, naming: 'create-typehtml.mjs', minify: false });
  if (!built.success) throw new AggregateError(built.logs, 'standalone initializer build failed');
  let editor = '';
  const extension = JSON.parse(await readFile(join(root, 'integrations/vscode/package.json'), 'utf8'));
  const vsix = `typehtml-vscode-${extension.version}.vsix`;
  try {
    await copyFile(join(artifacts, vsix), join(contents, vsix));
    editor = `\nOptional editor extension: install ${vsix} using VS Code's Extensions: Install from VSIX command.\n`;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await writeFile(join(contents, 'README.md'), `# TypeHTML ${manifest.version} local starter kit\n\nRequires Node.js 22+ to run the initializer. No source checkout or registry publication is needed.\n\n\`\`\`sh\nnode create-typehtml.mjs ../my-app --package-manager npm --runtime node\ncd ../my-app\nnpm install\nnpm run generate\nnpm run doctor\nnpm run dev\n\`\`\`\n\nChoose --runtime node (Node.js 22+, compiled ESM) or --runtime bun (Bun 1.4+), independently of --package-manager npm|bun. The kit defaults to Node/npm; the installed CLI retains its legacy Bun default. The initializer copies typehtml.tgz into the app and writes a relative file dependency; moving the app preserves that dependency. Installation may download third-party dependencies. No installation or server is started by the initializer.\n${editor}`);
  const packed = Bun.spawnSync(['tar', '-czf', temporaryArchive, '-C', stage, 'typehtml-starter'], { stdout: 'inherit', stderr: 'inherit' });
  if (packed.exitCode !== 0) throw new Error('starter kit archive failed');
  await rename(temporaryArchive, archive);
  console.log(JSON.stringify({ status: 'written', archive, version: manifest.version, editorIncluded: editor !== '' }));
} finally {
  // mkdtemp exclusively owns this subtree; never remove an app or an existing artifact directory.
  await rm(stage, { recursive: true, force: true });
}
