import { mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const artifact = join(root, 'artifacts', `0disoft-typehtml-${metadata.version}.tgz`);
const node = Bun.which('node');
const npmPath = Bun.which(process.platform === 'win32' ? 'npm.cmd' : 'npm');
if (!node || !npmPath) throw new Error('Node/npm required');
const npm = process.platform === 'win32' ? [node, join(dirname(npmPath), 'node_modules/npm/bin/npm-cli.js')] : [npmPath];
const parent = resolve(tmpdir());
const fixture = await mkdtemp(join(parent, 'typehtml-browser-'));
async function run(command: string[], timeoutMs = 120_000, mode = 'development'): Promise<string> {
  const child = Bun.spawn(command, { cwd: fixture, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: mode, NO_COLOR: '1' } });
  let expired = false;
  const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeoutMs);
  try {
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (expired || exit !== 0) throw new Error(`${command[0]} failed (${expired ? 'timeout' : exit})\n${(out + err).slice(-8000)}`);
    return out;
  } finally { clearTimeout(timer); }
}
async function main(): Promise<void> {
  const reports = [];
  try {
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    console.log('Installing disposable browser/hydration dependencies...');
    await run([...npm, 'install', artifact, 'react@19', 'react-dom@19', 'svelte@5', 'playwright@1', 'axe-core@4', '--ignore-scripts', '--no-audit', '--no-fund']);
    const api = await import(pathToFileURL(join(fixture, 'node_modules/@0disoft/typehtml/dist/index.js')).href);
    const identity = { '~standard': { version: 1, vendor: 'browser-fixture', validate: (value: unknown) => ({ value }) } };
    const form = api.defineSchemaForm({ id: 'edit', path: '/submit', fields: {
      name: { type: 'string', required: true, minLength: 2 }, enabled: { type: 'boolean' },
      colors: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      notes: { type: 'string', control: 'textarea' }, size: { type: 'string', control: 'select', enum: ['S', 'M'] },
      choice: { type: 'string', control: 'radio', enum: ['yes', 'no'] },
    }, input: identity, output: identity });
    const render = (invalid: boolean) => api.renderNativeForm(form, 'synthetic-csrf', {
      state: api.createFormState({ name: invalid ? 'A' : 'Ada', colors: ['red'], notes: '\nFirst\nSecond', size: 'M', choice: 'yes' }, invalid ? [{ field: 'name', code: 'MIN_LENGTH', message: 'Enter at least two characters' }] : []),
      fields: { name: { label: 'Display name', hint: 'Use at least two characters' }, enabled: { label: 'Email updates' }, colors: { label: 'Colors', control: 'checkbox', choices: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }] }, notes: { label: 'Notes' }, size: { label: 'Size' }, choice: { label: 'Confirmation' } },
      submitLabel: 'Save',
    });
    await writeFile(join(fixture, 'props.json'), JSON.stringify({ initial: render(false), invalid: render(true) }));
    await writeFile(join(fixture, 'ReactApp.mjs'), REACT_APP);
    await writeFile(join(fixture, 'react-client.mjs'), REACT_CLIENT);
    const { compile } = await import(pathToFileURL(join(fixture, 'node_modules/svelte/compiler/index.js')).href);
    await copyFile(join(root, 'scripts/probes/browser-hydration.mjs'), join(fixture, 'probe.mjs'));
    for (const mode of ['development', 'production']) {
      for (const generate of ['server', 'client'] as const) {
        const result = compile(SVELTE_APP, { generate, filename: 'App.svelte', dev: mode === 'development' });
        await writeFile(join(fixture, `SvelteComponent-${generate}.mjs`), result.js.code);
      }
      await writeFile(join(fixture, 'svelte-client.mjs'), SVELTE_CLIENT);
      for (const framework of ['react', 'svelte']) {
        const built = await Bun.build({ entrypoints: [join(fixture, `${framework}-client.mjs`)], outdir: fixture, naming: `${framework}.js`, target: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': JSON.stringify(mode) } });
        if (!built.success) throw new AggregateError(built.logs, `${framework} browser build`);
      }
      const report = JSON.parse(await run([node!, ...(mode === 'development' ? ['--conditions=development'] : []), 'probe.mjs'], 90_000, mode));
      if (report.status !== 'passed' || report.versions['@0disoft/typehtml'] !== metadata.version) throw new Error('browser probe did not verify the current package');
      reports.push({ mode, ...report });
      console.log(`${mode}: React/Svelte hydration and accessibility passed`);
    }
  } finally {
    const scope = relative(parent, resolve(fixture));
    if (scope === '' || isAbsolute(scope) || scope === '..' || scope.startsWith(`..${sep}`) || !basename(fixture).startsWith('typehtml-browser-')) throw new Error('browser fixture cleanup escaped its dedicated temporary directory');
    await rm(fixture, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
  console.log(JSON.stringify({ reports, artifact, sha256: createHash('sha256').update(await readFile(artifact)).digest('hex'), fixtureRemoved: true }));
}

const REACT_APP = String.raw`
import React from 'react';
import {createReactSubmissionHook,toReactFieldProps} from '@0disoft/typehtml/adapters/react';
const useSubmission=createReactSubmissionHook(React);
export function App({markup}) {
  const task=useSubmission();
  React.useEffect(()=>{window.qa={...task, framework:'react'};window.ready=true;return()=>{window.disposed=true;};},[task.state]);
  const start=()=>task.run(({signal})=>new Promise((resolve)=>{window.resolveTask=resolve;window.lastSignal=signal;})).catch(()=>{});
  return React.createElement('main',null,
    React.createElement('h1',null,'React native form'),
    React.createElement('label',null,'React props field',React.createElement('input',toReactFieldProps({name:'react-props',value:'Ada',maxlength:80}))),
    React.createElement('div',{dangerouslySetInnerHTML:{__html:markup},onSubmit:e=>{e.preventDefault();start();}}),
    React.createElement('button',{type:'button',onClick:start,disabled:task.state.pending,id:'start'},'Start task'),
    React.createElement('button',{type:'button',onClick:()=>task.cancel(),disabled:!task.state.pending,id:'cancel'},'Cancel task'),
    React.createElement('p',{role:'status',id:'status'},task.state.status),
    React.createElement('button',{type:'button',onClick:()=>window.unmountApp(),id:'unmount'},'Unmount'));
}
`;
const REACT_CLIENT = String.raw`
import React from 'react';
import {hydrateRoot} from 'react-dom/client';
import {focusNativeErrorSummary} from '@0disoft/typehtml/adapters/react';
import {App} from './ReactApp.mjs';
const markup=JSON.parse(document.getElementById('props').textContent).markup;
window.recovery=[];
window.focusSummary=()=>focusNativeErrorSummary(document);
const root=hydrateRoot(document.getElementById('root'),React.createElement(React.StrictMode,null,React.createElement(App,{markup})),{onRecoverableError:e=>window.recovery.push(e.message)});
window.unmountApp=()=>root.unmount();
`;
const SVELTE_APP = String.raw`
<script>
import {onMount,onDestroy} from 'svelte';
import {writable} from 'svelte/store';
import {connectSvelteSubmission} from '@0disoft/typehtml/adapters/svelte';
export let markup;
const task=connectSvelteSubmission(writable);
const status=task.state;
onMount(()=>{window.qa={...task,framework:'svelte'};window.ready=true;});
onDestroy(()=>{task.dispose();if(typeof window!=='undefined')window.disposed=true;});
function start(){task.run(({signal})=>new Promise(resolve=>{window.resolveTask=resolve;window.lastSignal=signal;})).catch(()=>{});}
</script>
<main><h1>Svelte native form</h1><div onsubmit={(e)=>{e.preventDefault();start();}}>{@html markup}</div>
<button type="button" onclick={start} disabled={$status.pending} id="start">Start task</button>
<button type="button" onclick={()=>task.cancel()} disabled={!$status.pending} id="cancel">Cancel task</button>
<p role="status" id="status">{$status.status}</p>
<button type="button" onclick={()=>window.unmountApp()} id="unmount">Unmount</button></main>
`;
const SVELTE_CLIENT = String.raw`
import {hydrate,unmount} from 'svelte';
import {focusNativeErrorSummary} from '@0disoft/typehtml/adapters/svelte';
import App from './SvelteComponent-client.mjs';
const markup=JSON.parse(document.getElementById('props').textContent).markup;
const app=hydrate(App,{target:document.getElementById('root'),props:{markup}});
window.focusSummary=()=>focusNativeErrorSummary(document);
window.unmountApp=()=>unmount(app);
`;

// Run only after fixture source constants have initialized.
await main();
