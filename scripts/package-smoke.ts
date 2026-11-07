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
  for (const unwanted of ['typescript', '@types/bun', '@types/node', 'zod', 'valibot', 'arktype', 'vscode-languageclient', '@vscode/vsce']) {
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
  await access(join(installed, 'docs/FORM_INTEGRATIONS.md'));
  await access(join(installed, 'docs/DEVELOPER_TOOLS.md'));
  await writeFile(join(directory, 'developer.mjs'), DEVELOPER_PROBE);
  for (const [runtime, executable] of [['node', node], ['bun', bun]] as const) {
    expect(JSON.parse(await run(`${manager}/${runtime} developer tools`, [executable!, 'developer.mjs'], directory)).passed === true, `${manager}/${runtime}: developer tools mismatch`);
    checks.push(`${manager}/${runtime}: typed field helpers, native testing client, opt-in i18n and static catalog`);
  }
  await writeFile(join(directory, 'editor-rpc.mjs'), await readFile(join(root, 'scripts/probes/editor-rpc.mjs'), 'utf8'));
  expect(JSON.parse(await run(`${manager}/node installed editor LSP`, [node!, 'editor-rpc.mjs'], directory)).passed === true, `${manager}/node: saved snapshot LSP mismatch`);
  checks.push(`${manager}/node: installed CLI LSP, 1.5 MiB saved HTML, metadata-only open, diagnostics and shutdown`);
  await writeFile(join(directory, 'extended.mjs'), EXTENDED_PROBE);
  for (const [runtime, executable] of [['node', node], ['bun', bun]] as const) {
    expect(JSON.parse(await run(`${manager}/${runtime} extended native forms`, [executable!, 'extended.mjs'], directory)).passed === true, `${manager}/${runtime}: extended form mismatch`);
    checks.push(`${manager}/${runtime}: schema forms, nested/repeated/boolean input, CSRF, replay, adapters and Node sockets`);
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
  await writeFile(join(directory, 'catalog.config.json'), JSON.stringify({ format: 'typehtml-catalog/1', forms: ['form.json'] }));
  const catalog = JSON.parse(await run('installed Node static catalog', [node!, cli, 'catalog', '--config', 'catalog.config.json', '--out-dir', 'form catalog'], directory));
  expect(catalog.forms === 1 && catalog.status === 'written', 'installed static catalog failed');
  expect((await readFile(join(directory, 'form catalog', 'index.html'), 'utf8')).includes('greeting.create'), 'installed catalog HTML missing form');
  checks.push('installed Node catalog CLI: static JSON manifest to read-only HTML and JSON');
  const sarif = JSON.parse(await run('installed Node Doctor SARIF', [node!, cli, 'doctor', '--config', 'doctor.config.json', '--format', 'sarif'], directory));
  expect(sarif.version === '2.1.0' && sarif.runs.length === 1, 'installed Doctor SARIF mismatch');
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
  catch (error) { if (!String(error).includes('requires Bun')) throw error; }
  try { await import('@0disoft/typehtml/sqlite/idempotency'); throw new Error('SQLite unexpectedly imported on Node'); }
  catch (error) { if (!String(error).includes('requires Bun')) throw error; console.log(JSON.stringify({ unsupported: true })); }
} else {
  const { loadReferenceOrderContract, SqliteOrderStore } = await import('@0disoft/typehtml/reference/order');
  const loaded = await loadReferenceOrderContract();
  if (loaded.contract.id !== 'orders.createDraft') throw new Error('bundled reference contract unavailable');
  const store = new SqliteOrderStore(':memory:');
  try {
    const { SqliteIdempotencyStore } = await import('@0disoft/typehtml/sqlite/idempotency');
    const { createIdempotencyKey, idempotencyDigest } = await import('@0disoft/typehtml');
    const idempotency = new SqliteIdempotencyStore(':memory:');
    try {
      let effects = 0;
      const operation = { scope:'consumer',key:createIdempotencyKey(),inputDigest:idempotencyDigest({}),authorize:()=>true,execute:()=>{effects++;return {ok:true}} };
      idempotency.executeAtomic(operation);
      if (!idempotency.executeAtomic(operation).replayed || effects !== 1) throw new Error('SQLite replay failed');
      console.log(JSON.stringify({ intents: store.countIntents() }));
    } finally { idempotency.close(); }
  } finally { store.close(); }
}
`;

const EXTENDED_PROBE = `import { createServer } from 'node:http';
import { defineSchemaForm, createSchemaFormHandler, createSignedCsrf, InMemoryIdempotencyStore, createIdempotencyKey, executeIdempotent, idempotencyDigest, getSchemaFieldProps, createFormState } from '@0disoft/typehtml';
import { toHono, toAstro, toReactRouter, toSvelteKit } from '@0disoft/typehtml/adapters/web';
import { toNodeListener, toExpress, createFastifyRoute } from '@0disoft/typehtml/adapters/node';
const origin='https://consumer.invalid';
const identity={'~standard':{version:1,vendor:'consumer',validate:(value)=>({value})}};
const form=defineSchemaForm({id:'consumer.rich',path:'/submit',protocol:{requestKey:'required'},fields:{'person.name':{type:'string',required:true,minLength:1},tags:{type:'array',items:{type:'string'},maxItems:3},accepted:{type:'boolean'},count:{type:'integer',minimum:1}},input:identity,output:identity});
const csrf=createSignedCsrf({secret:new Uint8Array(32).fill(9)});
const store=new InMemoryIdempotencyStore();const key=createIdempotencyKey();let effects=0;
const handle=createSchemaFormHandler(form,{allowedOrigins:[origin],authenticate:()=>({id:'p'}),csrfToken:()=>csrf.issue('p'),verifyCsrf:({token})=>csrf.verify(token,'p'),authorize:()=>true,execute:async({input,requestKey,request})=>(await executeIdempotent({store,scope:'p:rich',key:requestKey,inputDigest:idempotencyDigest(input),authorize:()=>true,signal:request.signal,execute:()=>{effects++;if(input.person.name!=='Ada'||input.tags.join(',')!=='b,a,b'||input.accepted!==false)throw new Error('decode mismatch');return {message:'ok'}}})).value,project:(value)=>value,success:()=>({location:'/done'})});
const body=(count='2')=>new URLSearchParams([['_bc_csrf',csrf.issue('p')],['_bc_request',key],['person.name','Ada'],['tags','b'],['tags','a'],['tags','b'],['count',count]]);
const request=(count)=>new Request(origin+'/submit',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:body(count)});
if((await handle(request('0'))).status!==422)throw new Error('missing 422');
for(const adapter of [toAstro(handle),toReactRouter(handle),toSvelteKit(handle)])if((await adapter({request:request('2')})).status!==303)throw new Error('web adapter');
if((await toHono(handle)({req:{raw:request('2')}})).status!==303||effects!==1)throw new Error('replay');
if(typeof toExpress!=='function'||typeof createFastifyRoute!=='function')throw new Error('node exports');
if(!getSchemaFieldProps(form,'person.name',{state:createFormState({},[])}).required)throw new Error('props');
const outputTransform={'~standard':{version:1,vendor:'consumer',validate:(value)=>typeof value?.count==='string'?{value:{count:Number(value.count)}}:{issues:[{message:'expected projected string count'}]}}};
const transformed=defineSchemaForm({id:'consumer.transformed',path:'/transformed',fields:{name:{type:'string'}},input:identity,output:outputTransform});
const transformedHandler=createSchemaFormHandler(transformed,{allowedOrigins:[origin],authenticate:()=>({}),csrfToken:()=>'token',authorize:()=>true,execute:()=>({count:'2'}),project:(value)=>value,success:(output)=>({location:'/done?count='+output.count.toFixed(0)})});
const transformedResponse=await transformedHandler(new Request(origin+'/transformed',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:'_bc_csrf=token&name=Ada'}));
if(transformedResponse.status!==303||transformedResponse.headers.get('location')!=='/done?count=2')throw new Error('output transformation mismatch');
const server=createServer(toNodeListener(handle,{origin}));
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
try{const port=server.address().port;const response=await fetch('http://127.0.0.1:'+port+'/submit',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:body(),signal:AbortSignal.timeout(5000)});if(response.status!==303||effects!==1)throw new Error('Node socket integration');await response.arrayBuffer();}
finally{server.closeAllConnections?.();await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));}
console.log(JSON.stringify({passed:true}));
`;

const DEVELOPER_PROBE = `import assert from 'node:assert/strict';
import { defineForm, createFormHandler, defineSchemaForm, createFormHelpers, createFormMessages, createFormState, resolveFormLocale } from '@0disoft/typehtml';
import { createFormRequest, createFormTestClient } from '@0disoft/typehtml/testing';
import { createFormCatalog, renderFormCatalog, serializeFormCatalog } from '@0disoft/typehtml/catalog';
const schema={type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string',minLength:1,maxLength:3}}};
const form=defineForm({id:'developer.submit',path:'/developer',input:schema,output:schema});
const helper=createFormHelpers(form);assert.equal(helper.field('name').name,'name');assert.equal(helper.form().action,'/developer');assert.throws(()=>helper.field('typo'));
let effects=0;
const handler=createFormHandler(form,{allowedOrigins:['https://typehtml.test'],authenticate:()=>({}),csrfToken:()=>'explicit-token',authorize:()=>true,execute:({input})=>{effects++;return input},project:(value)=>value,success:()=>({location:'/done'})});
const client=createFormTestClient(form,handler);
assert.equal((await client.submit({csrfToken:'explicit-token',entries:[['name','Ada']]})).status,303);
assert.equal((await client.submit({csrfToken:'wrong',entries:[['name','Ada']]})).status,403);
assert.equal((await client.submit({csrfToken:'explicit-token',entries:[['name','Ada'],['name','Ada']]})).status,400);
const invalid=await client.submit({csrfToken:'explicit-token',entries:[['name','Long'] ]});assert.equal(invalid.status,422);assert.match(await invalid.text(),/Long/);assert.equal(effects,1);
assert.equal(new URL(createFormRequest(form).url).pathname,'/developer');
const raw=createFormRequest(form,{rawBody:'name=%ZZ&note=한글😀'});assert.equal(raw.headers.get('content-type'),null);assert.equal(await raw.text(),'name=%ZZ&note=한글😀');
const messages=createFormMessages('ko',{fields:form.input.schema.properties,labels:{name:'이름'}});
const state=createFormState({name:'Long'},[{field:'name',code:'MAX_LENGTH',message:'original'}],{locale:'ko',messages});assert.match(state.fieldErrors.name[0],/3/);assert.equal(resolveFormLocale({supportedLocales:['en','ko'],fallbackLocale:'en',acceptLanguage:'ko-KR, en;q=0.8'}),'ko');
const identity={'~standard':{version:1,vendor:'not-exported',validate:(value)=>({value})}};
const rich=defineSchemaForm({id:'developer.rich',path:'/rich',fields:{'user.name':{type:'string'},tags:{type:'array',items:{type:'string'}}},input:identity,output:identity});
assert.equal(createFormHelpers(rich).name('user.name'),'user.name');
const catalog=createFormCatalog([form,rich],{title:'Developer <catalog>'});assert.equal(catalog.forms.length,2);assert.equal(catalog.forms[1].validation,'standard-schema-not-statically-analyzed');assert.ok(!serializeFormCatalog(catalog).includes('not-exported'));assert.match(renderFormCatalog(catalog),/Developer &lt;catalog&gt;/);
console.log(JSON.stringify({passed:true}));
`;

const TYPE_PROBE = `import { defineForm, createFormHandler, type InferInput } from '@0disoft/typehtml';
import { createFormHelpers, createFormMessages, resolveFormLocale } from '@0disoft/typehtml';
import { createFormRequest, createFormTestClient } from '@0disoft/typehtml/testing';
import { createFormCatalog, renderFormCatalog } from '@0disoft/typehtml/catalog';
import { defineSchemaForm, createSchemaFormHandler, type StandardSchemaV1, type SchemaFormInput } from '@0disoft/typehtml';
import { toHono, toAstro } from '@0disoft/typehtml/adapters/web';
import { collectRenderedHtml, doctorToSarif, runDoctorLanguageServer } from '@0disoft/typehtml/doctor';
void collectRenderedHtml;void doctorToSarif;void runDoctorLanguageServer;
const schema: StandardSchemaV1<unknown,{name:string}> = {'~standard':{version:1,vendor:'consumer',validate:(value)=>({value:value as {name:string}})}};
const rich=defineSchemaForm({id:'typed.rich',path:'/rich',fields:{name:{type:'string',required:true}},input:schema,output:schema});
const richValue: SchemaFormInput<typeof rich>={name:'Ada'};
// @ts-expect-error vendor schema output inference must remain precise
const badRich: SchemaFormInput<typeof rich>={name:2};
const richHandler=createSchemaFormHandler(rich,{allowedOrigins:['https://consumer.invalid'],authenticate:()=>({id:'p'}),csrfToken:()=>'token',authorize:({input})=>input.name.length>0,execute:({input})=>input,project:(input)=>input,success:()=>({location:'/done'})});
createFormHelpers(rich).field('name');
// @ts-expect-error undeclared wire names must fail in installed declarations
createFormHelpers(rich).field('typo');
const client=createFormTestClient(rich,richHandler);void client;void createFormRequest;
const catalog=createFormCatalog([rich]);renderFormCatalog(catalog);
createFormMessages('ko',{fields:rich.fields});resolveFormLocale({supportedLocales:['en','ko'],fallbackLocale:'en'});
toHono(richHandler);toAstro(richHandler);void richValue;
const outputTransform: StandardSchemaV1<{count:string},{count:number}>={'~standard':{version:1,vendor:'consumer',validate:(value)=>({value:{count:Number((value as {count:string}).count)}})}};
const transformed=defineSchemaForm({id:'typed.transform',path:'/transform',fields:{name:{type:'string'}},input:schema,output:outputTransform});
createSchemaFormHandler(transformed,{allowedOrigins:['https://consumer.invalid'],authenticate:()=>({}),csrfToken:()=>'token',authorize:()=>true,execute:()=>({count:'2'}),project:(value)=>value,success:({count})=>({location:'/done?count='+count.toFixed(0)})});
const form = defineForm({ id: 'typed.submit', path: '/typed', input: { type: 'object', additionalProperties: false, required: ['name', 'quantity'], properties: { name: { type: 'string' }, quantity: { type: 'integer' }, choice: { type: 'string', enum: ['yes', 'no'] } } }, output: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } } });
declare const selected: typeof form | typeof rich;
createFormHelpers(selected).name('name');
// @ts-expect-error a field absent from one possible form cannot be promised safe
createFormHelpers(selected).field('quantity');
const valid: InferInput<typeof form> = { name: 'Ada', quantity: 2, choice: 'yes' };
const fieldName:'quantity'=createFormHelpers(form).field('quantity').name;void fieldName;
// @ts-expect-error legacy declaration keys must not widen into arbitrary strings
createFormHelpers(form).name('typo');
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
