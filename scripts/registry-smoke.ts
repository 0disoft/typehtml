import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const registry = 'https://registry.npmjs.org/';
const node = Bun.which('node');
const npmPath = Bun.which(process.platform === 'win32' ? 'npm.cmd' : 'npm');
if (node === null || npmPath === null) throw new Error('Node/npm required for registry verification');
const npm = process.platform === 'win32' ? [node, join(dirname(npmPath), 'node_modules/npm/bin/npm-cli.js')] : [npmPath];
const parent = resolve(tmpdir());
const fixture = await mkdtemp(join(parent, 'typehtml-registry-'));

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: {
    ...process.env, NO_COLOR: '1', NPM_CONFIG_REGISTRY: registry,
    // The public installation check must not depend on the maintainer's login or shared cache.
    NPM_CONFIG_USERCONFIG: join(fixture, 'empty-user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(fixture, 'empty-global.npmrc'),
    NPM_CONFIG_CACHE: join(fixture, 'npm-cache'), BUN_INSTALL_CACHE_DIR: join(fixture, 'bun-cache'),
  } });
  let expired = false;
  const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 120_000);
  try {
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (expired || exit !== 0) throw new Error(`registry command failed (${expired ? 'timeout' : exit}): ${(out + err).slice(-6000)}`);
    return out.trim();
  } finally { clearTimeout(timer); }
}
async function get(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`registry GET failed: ${response.status}`);
  }
  return response;
}

try {
  const packument = await (await get(`${registry}${encodeURIComponent(manifest.name)}`)).json() as {
    'dist-tags': Record<string, string>;
    versions: Record<string, { version: string; dist: { tarball: string; integrity: string } }>;
  };
  expect(packument['dist-tags'].alpha === manifest.version, 'alpha dist-tag does not match the intended release');
  const published = packument.versions[manifest.version];
  expect(published !== undefined && published.version === manifest.version, 'exact registry release is missing');
  const tarballUrl = new URL(published.dist.tarball);
  expect(tarballUrl.origin === registry.slice(0, -1), 'unexpected registry tarball origin');
  const downloaded = Buffer.from(await (await get(tarballUrl.href)).arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(downloaded).digest('base64')}`;
  expect(integrity === published.dist.integrity, 'registry download differs from advertised integrity');
  const archive = join(root, 'artifacts', `0disoft-typehtml-${manifest.version}.tgz`);
  expect(downloaded.equals(await readFile(archive)), 'registry tarball differs from the verified local archive');
  for (const name of ['empty-user.npmrc', 'empty-global.npmrc']) await writeFile(join(fixture, name), '');
  const consumer = join(fixture, 'consumer');
  const launcher = join(fixture, 'launcher');
  await mkdir(consumer); await mkdir(launcher);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await run([...npm, 'install', `${manifest.name}@${manifest.version}`, '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  expect(await run([...npm, 'exec', '--offline', '--', 'typehtml', '--version'], consumer) === manifest.version, 'installed registry CLI version differs');
  const checks = ['anonymous exact-version npm install and CLI', 'registry tarball integrity and exact local byte comparison'];
  for (const manager of ['npm', 'bun'] as const) {
    const runtime = manager === 'npm' ? 'node' : 'bun';
    const app = join(fixture, `${runtime} registry app`);
    const initializer = manager === 'npm'
      ? [...npm, 'exec', '--yes', `--package=${manifest.name}@alpha`, '--', 'typehtml']
      : [process.execPath, 'x', '--package', `${manifest.name}@alpha`, 'typehtml'];
    await run([...initializer, 'init', app, '--runtime', runtime, '--package-manager', manager], launcher);
    const created = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
    expect(created.dependencies[manifest.name] === `^${manifest.version}`, 'starter did not use the intended registry version range');
    const runner = manager === 'npm' ? npm : [process.execPath];
    await run([...runner, 'install', '--ignore-scripts', ...(manager === 'npm' ? ['--no-audit', '--no-fund'] : [])], app);
    const installed = JSON.parse(await readFile(join(app, 'node_modules/@0disoft/typehtml/package.json'), 'utf8'));
    expect(installed.version === manifest.version, 'starter installed a different release');
    await run([...runner, 'run', 'generate'], app);
    await run([...runner, 'run', 'check'], app);
    if (runtime === 'node') await run([...runner, 'run', 'build'], app);
    checks.push(`${manager === 'npm' ? 'npx' : 'bunx'} @alpha init, registry dependency install, generate/check${runtime === 'node' ? '/ESM build' : ''}`);
  }
  console.log(JSON.stringify({ status: 'passed', package: `${manifest.name}@${manifest.version}`,
    distTags: packument['dist-tags'], tarball: tarballUrl.href, integrity,
    sha256: createHash('sha256').update(downloaded).digest('hex'), checks }));
} finally {
  const scope = relative(parent, resolve(fixture));
  if (scope === '' || isAbsolute(scope) || scope === '..' || scope.startsWith(`..${sep}`) || !basename(fixture).startsWith('typehtml-registry-')) throw new Error('registry fixture cleanup escaped its dedicated directory');
  await rm(fixture, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
