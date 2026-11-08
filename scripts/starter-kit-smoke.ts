import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const fixture = await mkdtemp(join(tmpdir(), 'typehtml-kit-'));
const node = Bun.which('node');
if (node === null) throw new Error('Node.js is required for the standalone kit check');
async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill(), 90_000);
  try {
    const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`${command[0]} failed (${exit}): ${error.slice(-2000)}`);
    return out;
  } finally { clearTimeout(timeout); }
}
try {
  await run(['tar', '-xzf', join(root, 'artifacts', `typehtml-starter-${manifest.version}.tar.gz`), '-C', fixture], fixture);
  const kit = join(fixture, 'typehtml-starter');
  const app = join(fixture, 'app with spaces');
  const created = JSON.parse(await run([node, join(kit, 'create-typehtml.mjs'), app, '--package-manager', 'npm'], fixture));
  if (created.status !== 'created') throw new Error('initializer did not create the app');
  const pkg = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
  if (pkg.dependencies['@0disoft/typehtml'] !== 'file:./vendor/typehtml.tgz') throw new Error('starter dependency is not relative');
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const kitDigest = digest(await readFile(join(kit, 'typehtml.tgz')));
  if (digest(await readFile(join(app, 'vendor/typehtml.tgz'))) !== kitDigest) throw new Error('archive copy differs');
  if (kitDigest !== digest(await readFile(join(root, 'artifacts', `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`)))) throw new Error('starter kit contains a stale core archive');
  const extension = JSON.parse(await readFile(join(root, 'integrations/vscode/package.json'), 'utf8'));
  const vsixName = `typehtml-vscode-${extension.version}.vsix`;
  let editorVerified = false;
  let sourceVsix: Uint8Array | undefined;
  try { sourceVsix = await readFile(join(root, 'artifacts', vsixName)); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (sourceVsix !== undefined) {
    if (digest(await readFile(join(kit, vsixName))) !== digest(sourceVsix)) throw new Error('starter kit contains a stale VSIX');
    editorVerified = true;
  }
  const moved = join(fixture, 'moved app');
  await rename(app, moved);
  const npm = Bun.which(process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (npm === null) throw new Error('npm is required for kit installation');
  const installer = process.platform === 'win32' ? [node, join(dirname(npm), 'node_modules/npm/bin/npm-cli.js')] : [npm];
  await run([...installer, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], moved);
  const version = (await run([node, join(moved, 'node_modules/@0disoft/typehtml/dist/cli.js'), '--version'], moved)).trim();
  if (version !== manifest.version) throw new Error('installed kit version differs');
  console.log(JSON.stringify({ status: 'passed', version, editorVerified, checks: ['standalone Node initializer', 'space-containing path', 'byte-identical current local archive', 'current VSIX when available', 'movable relative dependency', 'one npm install', 'installed CLI'] }));
} finally { await rm(fixture, { recursive: true, force: true }); }
