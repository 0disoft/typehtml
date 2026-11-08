import { createHash } from 'node:crypto';
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const artifact = join(root, 'artifacts', `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`);
await access(artifact);
const node = Bun.which('node');
const npmExecutable = Bun.which(process.platform === 'win32' ? 'npm.cmd' : 'npm');
if (node === null || npmExecutable === null) throw new Error('Node.js 24+ and npm are required for actual framework state checks');
const npm = process.platform === 'win32' ? [node, join(dirname(npmExecutable), 'node_modules/npm/bin/npm-cli.js')] : [npmExecutable];
const parent = resolve(tmpdir());
const fixture = await mkdtemp(join(parent, 'typehtml-framework-'));

async function run(label: string, command: string[], timeoutMs: number): Promise<string> {
  const child = Bun.spawn(command, { cwd: fixture, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: {
    ...process.env, NODE_ENV: 'development', NO_COLOR: '1', TYPEHTML_SMOKE_EXPECTED_VERSION: manifest.version,
  } });
  let expired = false;
  const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeoutMs);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (expired || exit !== 0) throw new Error(`${label} failed${expired ? ' (timeout)' : ` (${exit})`}: ${(stdout + stderr).slice(-6000)}`);
    return stdout.trim();
  } finally { clearTimeout(timer); }
}

try {
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'typehtml-framework-state-consumer', private: true, type: 'module' }));
  // Major ranges deliberately follow stable updates; this consumer is removed after the check.
  await run('disposable framework install', [...npm, 'install', artifact, 'react@19', 'react-dom@19', 'svelte@5', 'jsdom@27',
    '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], 120_000);
  await copyFile(join(root, 'scripts/probes/framework-state.mjs'), join(fixture, 'framework-state.mjs'));
  const report = JSON.parse(await run('actual React/Svelte state', [node, 'framework-state.mjs'], 20_000));
  if (report.status !== 'passed') throw new Error('framework probe did not report success');
  const sha256 = createHash('sha256').update(await readFile(artifact)).digest('hex');
  console.log(JSON.stringify({ ...report, artifact: basename(artifact), sha256, temporaryConsumer: 'removed after verification', publication: 'none' }));
} finally {
  const scope = relative(parent, resolve(fixture));
  if (scope === '' || isAbsolute(scope) || scope === '..' || scope.startsWith(`..${sep}`) || !basename(fixture).startsWith('typehtml-framework-')) {
    throw new Error('framework consumer cleanup escaped its dedicated temporary directory');
  }
  await rm(fixture, { recursive: true, force: true });
}
