import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const artifact = join(root, 'artifacts', `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`);
const bun = process.execPath;
const node = Bun.which('node');
const npmExecutable = Bun.which(process.platform === 'win32' ? 'npm.cmd' : 'npm');
const npm = process.platform === 'win32'
  ? [node ?? 'node', join(dirname(npmExecutable ?? 'npm.cmd'), 'node_modules/npm/bin/npm-cli.js')]
  : [npmExecutable ?? 'npm'];
const checks: string[] = [];
const args = process.argv.slice(2);

async function run(label: string, command: string[], cwd: string, timeoutMs = 90_000): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: { ...process.env, NO_COLOR: '1' } });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer);
  if (timedOut || exitCode !== 0) throw new Error(`${label} failed${timedOut ? ' (timeout)' : ` (${exitCode})`}\n${(stdout + stderr).slice(-8000)}`);
  return stdout.trim();
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function consumer(directory: string, manager: 'npm' | 'bun'): Promise<void> {
  await mkdir(directory);
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `typehtml-${manager}-consumer`, private: true, type: 'module' }));
  const install = manager === 'npm'
    ? [...npm, 'install', artifact, '--ignore-scripts', '--no-audit', '--no-fund']
    : [bun, 'add', artifact, '--ignore-scripts'];
  await run(`${manager} fresh tarball install`, install, directory);
  const installed = join(directory, 'node_modules/@0disoft/typehtml');
  const packageInfo = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  expect(packageInfo.version === manifest.version, `${manager}: installed package version differs`);
  for (const unwanted of ['typescript', '@types/bun', '@types/node']) {
    let exists = false;
    try { await access(join(directory, 'node_modules', unwanted)); exists = true; } catch { /* absent is expected */ }
    expect(!exists, `${manager}: package leaked development dependency ${unwanted}`);
  }
  const binaries = await readdir(join(directory, 'node_modules/.bin'));
  expect(binaries.some((name) => ['typehtml', 'typehtml.cmd', 'typehtml.exe'].includes(name)), `${manager}: installed CLI shim missing`);
  const shimCommand = manager === 'npm'
    ? [...npm, 'exec', '--offline', '--', 'typehtml', '--version']
    : [bun, '--bun', 'run', 'typehtml', '--version'];
  const shimVersion = await run(`${manager} installed CLI shim`, shimCommand, directory);
  expect(shimVersion === manifest.version, `${manager}: CLI shim version differs`);
  const shimHelp = await run(`${manager} installed CLI via Bun`, [bun, '--bun', 'run', 'typehtml', '--help'], directory);
  expect(shimHelp.includes('typehtml init <directory>'), `${manager}: Bun CLI help is missing init`);
  const cli = join(installed, 'dist/cli.js');
  expect((await run(`${manager} direct Node CLI help`, [node!, cli, '--help'], directory)).includes('--form <file>'), `${manager}: Node help missing generic form command`);
  expect((await run(`${manager} direct Bun CLI version`, [bun, cli, '--version'], directory)) === manifest.version, `${manager}: Bun version mismatch`);
  await writeFile(join(directory, 'portable.mjs'), PORTABLE_PROBE);
  for (const [runtime, executable] of [['node', node], ['bun', bun]] as const) {
    const result = JSON.parse(await run(`${manager}/${runtime} imports and native handler`, [executable!, 'portable.mjs'], directory));
    expect(result.success === 303 && result.invalid === 422 && result.csrf === 403 && result.executions === 1, `${manager}/${runtime}: handler protocol mismatch`);
    checks.push(`${manager}/${runtime}: root+contract+doctor+runtime imports, handler 303/422/403, CLI`);
  }
  await writeFile(join(directory, 'reference.mjs'), REFERENCE_PROBE);
  expect(JSON.parse(await run(`${manager} Node reference rejection`, [node!, 'reference.mjs'], directory)).unsupported === true, `${manager}: Node reference did not reject`);
  expect(JSON.parse(await run(`${manager} Bun reference example`, [bun, 'reference.mjs'], directory)).intents === 0, `${manager}: Bun reference could not create a memory store`);
  checks.push(`${manager}: Bun-only reference boundary and bundled contract`);
  await writeFile(join(directory, 'inference.ts'), TYPE_PROBE);
  await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, noEmit: true, skipLibCheck: false, allowImportingTsExtensions: false,
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022', 'DOM'], types: [],
  }, files: ['inference.ts'] }));
  await run(`${manager} installed declarations and inferred types`, [bun, join(root, 'node_modules/typescript/bin/tsc'), '-p', join(directory, 'tsconfig.json')], directory);
  checks.push(`${manager}: installed declarations and positive/negative inference with skipLibCheck=false`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListening());
  });
  const address = server.address();
  expect(address !== null && typeof address !== 'string', 'could not reserve a local test port');
  const port = address.port;
  await new Promise<void>((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
  return port;
}

async function starter(directory: string, installedCli: string): Promise<void> {
  const created = JSON.parse(await run('installed CLI init', [node!, installedCli, 'init', directory, '--package-manager', 'npm'], dirname(directory)));
  expect(created.status === 'created', 'installed init did not create the starter');
  const appPackagePath = join(directory, 'package.json');
  const appPackage = JSON.parse(await readFile(appPackagePath, 'utf8'));
  // Only the disposable test app uses a tarball override; generated app dependencies stay publishable.
  appPackage.dependencies['@0disoft/typehtml'] = pathToFileURL(artifact).href;
  await writeFile(appPackagePath, JSON.stringify(appPackage, null, 2));
  await run('starter fresh npm install', [...npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
  const cli = join(directory, 'node_modules/@0disoft/typehtml/dist/cli.js');
  const generate = ['generate', '--form', 'form.json', '--out-dir', 'generated', '--root', '.'];
  expect(JSON.parse(await run('starter Node generate', [node!, cli, ...generate], directory)).status === 'written', 'starter generation failed');
  expect(JSON.parse(await run('starter Node generate check', [node!, cli, ...generate, '--check'], directory)).status === 'current', 'starter generation is stale');
  const report = JSON.parse(await run('starter Node Doctor', [node!, cli, 'doctor', '--config', 'doctor.config.json'], directory));
  expect(report.exitCode === 0 && report.scope.paths === 1 && report.findings.length === 0, 'starter Doctor did not verify its form');
  checks.push('standalone init: Node generation/check, source hashes, Doctor 1 path/0 findings');
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = Bun.spawn([bun, 'server.ts'], {
    cwd: directory, env: { ...process.env, PORT: String(port), ALLOWED_ORIGIN: origin },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const stdout = new Response(server.stdout).text();
  const stderr = new Response(server.stderr).text();
  const deadline = setTimeout(() => server.kill('SIGKILL'), 25_000);
  try {
    let start: Response | undefined;
    const until = performance.now() + 8_000;
    while (performance.now() < until) {
      if (server.exitCode !== null) throw new Error('starter server exited before listening');
      try { start = await fetch(origin, { signal: AbortSignal.timeout(300) }); break; } catch { await Bun.sleep(50); }
    }
    expect(start?.status === 200, 'starter server did not become ready');
    const body = await start.text();
    const cookie = start.headers.get('set-cookie')?.split(';')[0];
    const csrf = body.match(/name="_bc_csrf" value="([^"]+)"/)?.[1];
    expect(cookie && csrf, 'starter did not issue its local session and CSRF token');
    const submit = (quantity: string) => fetch(`${origin}/greet`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(2000),
      headers: { Cookie: cookie, Origin: origin, Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _bc_csrf: csrf, name: 'Ada', quantity }),
    });
    const invalid = await submit('21');
    expect(invalid.status === 422 && (await invalid.text()).includes('value="21"'), 'starter did not return a preserving 422');
    const valid = await submit('2');
    const location = valid.headers.get('location');
    expect(valid.status === 303 && location !== null && location.startsWith('/thanks?'), 'starter did not redirect after success');
    const receipt = await fetch(new URL(location, origin), { headers: { Cookie: cookie }, signal: AbortSignal.timeout(2000) });
    const receiptBody = await receipt.text();
    expect(receipt.status === 200 && receiptBody.includes('Hello Ada! Quantity: 2') && !receiptBody.includes('not public'), 'starter public receipt mismatch');
    checks.push('standalone Bun HTTP: GET200, invalid422/raw preservation, valid303, public receipt200');
  } finally {
    clearTimeout(deadline);
    if (server.exitCode === null) server.kill('SIGTERM');
    const force = setTimeout(() => { if (server.exitCode === null) server.kill('SIGKILL'); }, 2000);
    await server.exited;
    clearTimeout(force);
    const output = (await stdout) + (await stderr);
    if (output.includes('error:')) process.stderr.write(output.slice(-4000));
  }
}

async function cleanup(directory: string, parent: string): Promise<void> {
  const candidate = resolve(directory);
  const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!same(dirname(candidate), resolve(parent)) || !basename(candidate).startsWith('typehtml-package-smoke-')) throw new Error('refusing cleanup outside the dedicated smoke fixture');
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink() || !same(await realpath(candidate), candidate)) throw new Error('smoke fixture cleanup target changed');
  await rm(candidate, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function main(): Promise<void> {
  let fixture: string | undefined;
  let fixtureParent: string | undefined;
  let failure: unknown;
  let cleanupError: string | undefined;
  let artifactSha256: string | null = null;
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  try {
    expect(node !== null, 'Node.js is required for the portable package smoke test');
    expect(npmExecutable !== null, 'npm is required for the fresh npm consumer');
    expect(!args.some((argument) => argument !== '--pack') && args.length <= 1, 'usage: bun run package:smoke [--pack]');
    if (args.includes('--pack')) await run('package pack', [bun, 'run', 'pack'], root);
    artifactSha256 = hash(await readFile(artifact));
    fixtureParent = await realpath(tmpdir());
    fixture = await mkdtemp(join(fixtureParent, 'typehtml-package-smoke-'));
    const npmConsumer = join(fixture, 'npm-consumer');
    await consumer(npmConsumer, 'npm');
    await consumer(join(fixture, 'bun-consumer'), 'bun');
    await starter(join(fixture, 'starter app'), join(npmConsumer, 'node_modules/@0disoft/typehtml/dist/cli.js'));
    expect(hash(await readFile(artifact)) === artifactSha256, 'tarball changed while package smoke was running');
  } catch (error) {
    failure = error;
  } finally {
    if (fixture !== undefined && fixtureParent !== undefined) {
      try { await cleanup(fixture, fixtureParent); } catch (error) {
        failure = failure ?? error;
        cleanupError = `${fixture}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  process.stdout.write(`${JSON.stringify({
    format: 'typehtml-package-smoke/1', status: failure === undefined ? 'passed' : 'failed',
    package: `${manifest.name}@${manifest.version}`, artifact, sha256: artifactSha256,
    checks, ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : String(failure) }),
    ...(cleanupError === undefined ? {} : { cleanupError }),
  }, null, 2)}\n`);
  if (failure !== undefined) process.exitCode = 1;
}

const PORTABLE_PROBE = `import { defineForm, createFormHandler } from '@0disoft/typehtml';
import * as contract from '@0disoft/typehtml/contract';
import * as doctor from '@0disoft/typehtml/doctor';
import * as runtime from '@0disoft/typehtml/runtime';
if (typeof contract.decodeStrictJson !== 'function' || typeof doctor.runDoctor !== 'function' || typeof runtime.readUrlEncodedForm !== 'function') throw new Error('portable subpath export missing');
const form = defineForm({ id: 'sample.submit', path: '/submit', input: { type: 'object', additionalProperties: false, required: ['name', 'quantity'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, quantity: { type: 'integer', minimum: 1, maximum: 20 } } }, output: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string', maxLength: 200 } } } });
let executions = 0;
const csrf = crypto.randomUUID();
const handler = createFormHandler(form, { allowedOrigins: ['https://consumer.invalid'], authenticate: () => ({ subject: 'test' }), csrfToken: () => csrf, authorize: () => true, execute: ({ input }) => { executions++; return { message: input.name + input.quantity, privateNote: 'not public' }; }, project: (result) => ({ message: result.message }), success: () => ({ location: '/receipt' }) });
const request = (quantity, token = csrf) => new Request('https://consumer.invalid/submit', { method: 'POST', headers: { Origin: 'https://consumer.invalid', Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _bc_csrf: token, name: 'Ada', quantity }) });
const success = await handler(request('2'));
const invalid = await handler(request('21'));
const rejected = await handler(request('2', 'wrong'));
if (success.headers.get('location') !== '/receipt') throw new Error('invalid success location');
console.log(JSON.stringify({ success: success.status, invalid: invalid.status, csrf: rejected.status, executions }));
`;

const REFERENCE_PROBE = `if (!process.versions.bun) {
  try { await import('@0disoft/typehtml/reference/order'); throw new Error('reference unexpectedly imported on Node'); }
  catch (error) { if (!String(error).includes('requires Bun')) throw error; console.log(JSON.stringify({ unsupported: true })); }
} else {
  const { loadReferenceOrderContract, SqliteOrderStore } = await import('@0disoft/typehtml/reference/order');
  const loaded = await loadReferenceOrderContract();
  if (loaded.contract.id !== 'orders.createDraft') throw new Error('bundled reference contract unavailable');
  const store = new SqliteOrderStore(':memory:');
  try { console.log(JSON.stringify({ intents: store.countIntents() })); } finally { store.close(); }
}
`;

const TYPE_PROBE = `import { defineForm, createFormHandler, type InferInput } from '@0disoft/typehtml';
const form = defineForm({ id: 'typed.submit', path: '/typed', input: { type: 'object', additionalProperties: false, required: ['name', 'quantity'], properties: { name: { type: 'string' }, quantity: { type: 'integer' }, choice: { type: 'string', enum: ['yes', 'no'] } } }, output: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } } });
const valid: InferInput<typeof form> = { name: 'Ada', quantity: 2, choice: 'yes' };
// @ts-expect-error the integer codec exposes decoded numbers, not wire strings
const invalidWire: InferInput<typeof form> = { name: 'Ada', quantity: '2' };
// @ts-expect-error required schema fields remain required
const missing: InferInput<typeof form> = { name: 'Ada' };
// @ts-expect-error finite enum literals remain precise
const invalidChoice: InferInput<typeof form> = { name: 'Ada', quantity: 2, choice: 'maybe' };
createFormHandler(form, { allowedOrigins: ['https://consumer.invalid'], authenticate: () => ({ subject: 'test' }), csrfToken: () => 'synthetic', authorize: ({ input }) => { const quantity: number = input.quantity; return quantity > 0; }, execute: ({ input }) => ({ message: input.name }), project: (result) => ({ message: result.message }), success: (output) => ({ location: '/done?message=' + encodeURIComponent(output.message) }) });
void valid;
`;

await main();
