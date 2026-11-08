import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Framework dependencies exist only in this managed fixture, never in the library package.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function main(): Promise<void> {
const node = Bun.which('node');
const npmPath = Bun.which(process.platform === 'win32' ? 'npm.cmd' : 'npm');
if (node === null || npmPath === null) throw new Error('Node.js and npm are required for real framework SSR verification');
const npm = process.platform === 'win32' ? [node, join(dirname(npmPath), 'node_modules/npm/bin/npm-cli.js')] : [npmPath];
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--package')) throw new Error('usage: bun scripts/framework-smoke.ts [--package <archive.tgz>]');
const archive = args[0] === '--package' ? resolve(args[1]!) : undefined;
if (archive !== undefined) await readFile(archive);
const fixture = await mkdtemp(join(tmpdir(), 'typehtml-framework-smoke-'));

async function run(command: string[], timeoutMs: number): Promise<string> {
  const child = Bun.spawn(command, { cwd: fixture, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, CI: '1', NO_COLOR: '1', ASTRO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' } });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') {
      const killer = Bun.spawn(['taskkill', '/PID', String(child.pid), '/T', '/F'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      void killer.exited;
    } else child.kill('SIGKILL');
  }, timeoutMs);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (timedOut || exit !== 0) throw new Error(`framework fixture failed${timedOut ? ' (deadline)' : ` (${exit})`}\n${(stdout + stderr).slice(-6000)}`);
    return stdout;
  } finally { clearTimeout(timer); }
}

let report: Record<string, unknown> | undefined;
try {
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'typehtml-framework-smoke', private: true, type: 'module',
    dependencies: { astro: '^7', hono: '^4', '@sveltejs/kit': '^3', '@sveltejs/vite-plugin-svelte': '^7', svelte: '^5', vite: '^8', typescript: '^6', ...(archive === undefined ? {} : { '@0disoft/typehtml': `file:${archive.replaceAll('\\', '/')}` }) },
  }, null, 2));
  console.log('Installing isolated framework fixtures (Astro 7, SvelteKit 3, Svelte 5, Vite 8, Hono 4)...');
  await run([...npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], 180_000);
  if (archive === undefined) {
    const bundled = await Bun.build({ entrypoints: [join(root, 'src/integrations/capture.ts')], outdir: fixture,
      naming: 'capture.mjs', format: 'esm', target: 'node', minify: false });
    if (!bundled.success) throw new AggregateError(bundled.logs, 'capture fixture bundle failed');
  }
  await mkdir(join(fixture, 'astro/src/pages'), { recursive: true });
  await writeFile(join(fixture, 'astro/src/pages/edit.astro'), ASTRO_PAGE);
  await mkdir(join(fixture, 'sveltekit/src/routes/edit'), { recursive: true });
  await writeFile(join(fixture, 'sveltekit/vite.config.js'), "import { defineConfig } from 'vite';\nimport { sveltekit } from '@sveltejs/kit/vite';\nexport default defineConfig({plugins:[sveltekit()],server:{host:'127.0.0.1',port:0,strictPort:true},logLevel:'error'});\n");
  await writeFile(join(fixture, 'sveltekit/src/app.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8">%sveltekit.head%</head><body><div>%sveltekit.body%</div></body></html>');
  await writeFile(join(fixture, 'sveltekit/src/routes/edit/+page.server.js'), "export function load({url}) {const state=url.searchParams.get('state')??'initial';return {state,rows:state==='dynamic'?['first','second']:['first']};}\n");
  await writeFile(join(fixture, 'sveltekit/src/routes/edit/+page.svelte'), SVELTE_PAGE);
  await writeFile(join(fixture, 'sveltekit/src/hooks.server.js'), "export async function handle({event,resolve}) {const response=await resolve(event);return event.url.searchParams.get('state')==='invalid'&&response.status===200?new Response(response.body,{status:422,headers:response.headers}):response;}\n");
  await writeFile(join(fixture, 'runner.mjs'), archive === undefined ? RUNNER : RUNNER.replace("from './capture.mjs'", "from '@0disoft/typehtml/adapters/capture'"));
  const output = await run([node, 'runner.mjs'], 120_000);
  const line = output.split(/\r?\n/).find((item) => item.startsWith('TYPEHTML_FRAMEWORK_SMOKE '));
  if (line === undefined) throw new Error('framework runner did not return its verification report');
  report = JSON.parse(line.slice('TYPEHTML_FRAMEWORK_SMOKE '.length));
  for (const origin of report!.origins as string[]) {
    let listening = false;
    try { await fetch(origin + '/edit?state=initial', { signal: AbortSignal.timeout(1000) }); listening = true; }
    catch { /* Refused connections prove the owned dev listener has stopped. */ }
    if (listening) throw new Error('framework fixture listener remained open after cleanup');
  }
} finally {
  // mkdtemp created this exact owned directory; no caller-supplied deletion target is used.
  await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
console.log(JSON.stringify({ ...report, packageMode: archive === undefined ? 'source-bundle' : 'installed-archive', managedListenersClosed: true, temporaryFixtureRemovedAfterRun: true }));
}

const ASTRO_PAGE = String.raw`---
export const prerender = false;
const state = Astro.url.searchParams.get('state') ?? 'initial';
if (state === 'invalid') Astro.response.status = 422;
const rows = state === 'dynamic' ? ['first', 'second'] : ['first'];
---
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Astro capture fixture</title></head><body>
<main data-framework="astro" data-state={state}><form id="edit" method="post" action="/save">
<input type="hidden" name="_bc_csrf" value="csrf-secret"/><input type="hidden" name="_bc_request" value="request-secret"/>
<input name="private" value="private-secret"/>
{rows.map((key,index) => <fieldset><input type="hidden" name={'items['+index+'].rowId'} value={key}/><label>Quantity<input name={'items['+index+'].quantity'} type="number" required min="1" max="5" value={state==='invalid'?9:1}/></label></fieldset>)}
{state === 'invalid' && <p role="alert">Quantity is invalid</p>}<button>Save</button>
</form></main></body></html>`;

const SVELTE_PAGE = String.raw`<script>let { data } = $props();</script>
<svelte:head><title>SvelteKit capture fixture</title></svelte:head>
<main data-framework="sveltekit" data-state={data.state}><form id="edit" method="post" action="/save">
<input type="hidden" name="_bc_csrf" value="csrf-secret"/><input type="hidden" name="_bc_request" value="request-secret"/>
<input name="private" value="private-secret"/>
{#each data.rows as key,index (key)}<fieldset><input type="hidden" name={'items['+index+'].rowId'} value={key}/><label>Quantity<input name={'items['+index+'].quantity'} type="number" required min="1" max="5" value={data.state==='invalid'?9:1}/></label></fieldset>{/each}
{#if data.state === 'invalid'}<p role="alert">Quantity is invalid</p>{/if}<button>Save</button>
</form></main>`;

const RUNNER = String.raw`import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { dev } from 'astro';
import { createServer } from 'vite';
import { collectHonoHtml, collectAstroHtml, collectSvelteKitHtml } from './capture.mjs';
const root = fileURLToPath(new URL('.',import.meta.url));
const deadline = AbortSignal.timeout(90000);
const closers = [];
const origins = [];
const reports = [];
const assert = (value,message) => { if(!value) throw new Error(message); };
const bindings = [{formId:'edit',actionId:'edit.save',required:true,submitterPolicy:'enumerate-native',constraintMismatchSeverity:'warning'}];
function selections(origin) { return ['initial','invalid','dynamic'].map(id=>({id,url:origin+'/edit?state='+id,expectedStatus:id==='invalid'?422:200,bindings})); }
function verify(collection,name) {
  assert(collection.snapshots.length===3,name+': selected states missing');
  for(const snapshot of collection.snapshots) {
    assert(snapshot.html.includes('data-framework="'+name+'"'),name+': real framework marker missing');
    assert(snapshot.html.includes('data-state="'+snapshot.id+'"'),name+': state mismatch');
    assert(snapshot.document.sourceKind==='redacted-snapshot',name+': redaction metadata missing');
    for(const secret of ['csrf-secret','request-secret','private-secret']) assert(!snapshot.html.includes(secret),name+': captured secret retained');
    const rows=(snapshot.html.match(/name="items[[0-9]+].rowId"/g)||[]).length;
    assert(rows===(snapshot.id==='dynamic'?2:1),name+': dynamic SSR row count differs');
    if(snapshot.id==='invalid') assert(snapshot.html.includes('role="alert"'),name+': invalid state missing');
  }
  reports.push({name,states:['initial','invalid','dynamic'],redacted:true});
}
const options = origin => ({selections:selections(origin),allowedOrigins:[origin],redactFields:['private'],signal:deadline,timeoutMs:30000,concurrency:1});
try {
  const app = new Hono();
  app.get('/edit',c=>{
    const state=c.req.query('state')??'initial';
    const keys=state==='dynamic'?['first','second']:['first'];
    const rows=keys.map((key,index)=>'<input type="hidden" name="items['+index+'].rowId" value="'+key+'"><input type="number" name="items['+index+'].quantity" value="1">').join('');
    return c.html('<main data-framework="hono" data-state="'+state+'"><form id="edit" method="post" action="/save"><input name="_bc_csrf" value="csrf-secret"><input name="_bc_request" value="request-secret"><input name="private" value="private-secret">'+rows+(state==='invalid'?'<p role="alert">Invalid</p>':'')+'<button>Save</button></form></main>',state==='invalid'?422:200);
  });
  verify(await collectHonoHtml({...options('https://hono.test'),request:request=>app.request(request)}),'hono');
  const astro = await dev({root:join(root,'astro'),configFile:false,output:'server',logLevel:'silent',server:{host:'127.0.0.1',port:0}});
  closers.push(()=>astro.stop());
  const astroOrigin='http://127.0.0.1:'+astro.address.port; origins.push(astroOrigin);
  verify(await collectAstroHtml({...options(astroOrigin),render:(_state,{request,signal})=>fetch(request,{signal,redirect:'manual'})}),'astro');
  const previousDirectory=process.cwd();
  process.chdir(join(root,'sveltekit'));
  const kit = await createServer({root:join(root,'sveltekit'),logLevel:'error'});
  closers.push(async()=>{try{await kit.close();}finally{process.chdir(previousDirectory);}}); await kit.listen();
  const address=kit.httpServer.address(); assert(address&&typeof address==='object','SvelteKit did not listen');
  const kitOrigin='http://127.0.0.1:'+address.port; origins.push(kitOrigin);
  verify(await collectSvelteKitHtml({...options(kitOrigin),respond:(request,_state,{signal})=>fetch(request,{signal,redirect:'manual'})}),'sveltekit');
  const versions={};
  for(const name of ['hono','astro','@sveltejs/kit','svelte','vite']) versions[name]=JSON.parse(await readFile(join(root,'node_modules',name,'package.json'),'utf8')).version;
  console.log('TYPEHTML_FRAMEWORK_SMOKE '+JSON.stringify({status:'passed',node:process.version,versions,frameworks:reports,origins}));
} finally {
  const cleanup = await Promise.allSettled(closers.reverse().map(close=>close()));
  const failures=cleanup.filter(result=>result.status==='rejected');
  if(failures.length) throw new AggregateError(failures.map(result=>result.reason),'framework listener cleanup failed');
}`;

await main();
