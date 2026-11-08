import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createRequire } from 'node:module';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { writable } from 'svelte/store';
import { SubmissionPendingError, defineSchemaForm, createFormState, renderNativeField, createSubmissionTask } from '@0disoft/typehtml';
import { createReactSubmissionHook, toReactFieldProps } from '@0disoft/typehtml/adapters/react';
import { connectSvelteSubmission } from '@0disoft/typehtml/adapters/svelte';

assert(Number(process.versions.node.split('.')[0]) >= 24, 'this jsdom framework check requires Node.js 24+');
const require = createRequire(import.meta.url);
const versions = Object.fromEntries(['@0disoft/typehtml', 'react', 'react-dom', 'svelte', 'jsdom'].map((name) => [name, require(`${name}/package.json`).version]));
assert.equal(versions['@0disoft/typehtml'], process.env.TYPEHTML_SMOKE_EXPECTED_VERSION);
const checks = [];
const timers = new Set();
const schedule = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  timers.add(timer);
  return () => { clearTimeout(timer); timers.delete(timer); };
};
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// DOM globals are installed only in this disposable Node child, never in the runner/workspace process.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://typehtml.test/' });
const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const originals = Object.fromEntries(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
const originalError = console.error;
const reactErrors = [];
console.error = (...args) => { reactErrors.push(args.map(String).join(' ')); };
let root;
try {
  const identity = { '~standard': { version: 1, vendor: 'native-dom-probe', validate: (value) => ({ value }) } };
  const nativeForm = defineSchemaForm({ id: 'native.regression', path: '/save', fields: { color: { type: 'string' }, enabled: { type: 'boolean' } }, input: identity, output: identity });
  for (const control of ['select', 'radio']) {
    const host = document.createElement('form');
    host.innerHTML = renderNativeField(nativeForm, 'color', createFormState({ color: 'blue' }, []), {
      control, choices: [{ value: 'red' }, { value: 'blue', disabled: true }],
    });
    assert.deepEqual([...new dom.window.FormData(host)], [['color', 'blue']]);
  }
  assert.throws(() => renderNativeField(nativeForm, 'enabled', undefined, { control: 'textarea' }), /boolean/);
  const schedulingFailure = new Error('host scheduler failed after expiry');
  const faulty = createSubmissionTask({ schedule: (expire) => { expire(); throw schedulingFailure; } });
  await assert.rejects(faulty.run(() => { throw new Error('must not execute'); }), (error) => error === schedulingFailure);
  await new Promise((resolve) => setTimeout(resolve, 0)); // An orphaned abort rejection fails this Node child.
  checks.push('native DOM disabled-choice raw-value preservation and boolean control guard', 'synchronous scheduler abort/error has no unhandled rejection');
  const { createRoot } = await import('react-dom/client');
  const useSubmission = createReactSubmissionHook(React);
  const parent = new AbortController();
  let latest;
  let renders = 0;
  let setups = 0;
  let cleanups = 0;
  function Probe() {
    latest = useSubmission({ signal: parent.signal, schedule, timeoutMs: 5_000 });
    renders++;
    React.useEffect(() => { setups++; return () => { cleanups++; }; }, []);
    return React.createElement('main', null,
      React.createElement('output', { id: 'state' }, `${latest.state.status}:${latest.state.value ?? ''}`),
      React.createElement('input', toReactFieldProps({ name: 'name', value: 'Ada', maxlength: 80 })),
    );
  }
  root = createRoot(document.getElementById('root'));
  await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(Probe))); });
  assert(setups >= 2 && cleanups >= 1, 'React StrictMode must actually replay mount effects');
  const input = document.querySelector('input');
  assert.equal(input.value, 'Ada');
  assert.equal(input.getAttribute('maxlength'), '80');
  input.value = 'Edited';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  const first = deferred();
  let attempts = 0;
  let firstSignal;
  let running;
  await act(async () => {
    running = latest.run(({ signal }) => { attempts++; firstSignal = signal; return first.promise; });
    await Promise.resolve();
  });
  assert.equal(latest.state.status, 'submitting');
  assert.equal(document.getElementById('state').textContent, 'submitting:');
  assert.equal(input.value, 'Edited', 'uncontrolled React props must preserve edits across state updates');
  assert.equal(timers.size, 1);
  await assert.rejects(latest.run(() => { attempts++; return 'duplicate'; }), SubmissionPendingError);
  const cancelled = new Error('React user cancelled');
  await act(async () => { latest.cancel(cancelled); await assert.rejects(running, (error) => error === cancelled); });
  assert.equal(firstSignal.aborted, true);
  assert.equal(latest.state.status, 'cancelled');
  assert.equal(timers.size, 0);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  await act(async () => { assert.equal(await latest.run(() => { attempts++; return 'new result'; }), 'new result'); });
  await act(async () => { first.resolve('stale result'); await Promise.resolve(); });
  assert.equal(document.getElementById('state').textContent, 'complete:new result');
  assert.equal(attempts, 2, 'cancelled and completed work must each run once, with no duplicate or retry');

  const abandoned = deferred();
  let abandonedSignal;
  let pending;
  await act(async () => { pending = latest.run(({ signal }) => { abandonedSignal = signal; return abandoned.promise; }); await Promise.resolve(); });
  const rejection = assert.rejects(pending, { name: 'AbortError', message: 'submission disposed' });
  await act(async () => { root.unmount(); root = undefined; await rejection; });
  const rendersAfterUnmount = renders;
  await act(async () => { abandoned.resolve('after unmount'); await Promise.resolve(); });
  assert.equal(renders, rendersAfterUnmount, 'a disposed controller must not update the unmounted component');
  assert.equal(abandonedSignal.aborted, true);
  assert.equal(timers.size, 0);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  assert.equal(setups, cleanups, 'React effect cleanup must balance actual StrictMode mount effects');
  assert.deepEqual(reactErrors, [], 'React must not emit controlled-input, act, or unmounted-update warnings');
  checks.push('React 19 createRoot + actual StrictMode effect replay', 'React useState pending/cancel/complete DOM states', 'React duplicate guard + no retry + stale-result suppression', 'React uncontrolled field props preserve edits', 'React unmount abort + timer/listener/effect cleanup');

  let subscriptions = 0;
  const hostWritable = (initial) => writable(initial, () => { subscriptions++; return () => { subscriptions--; }; });
  const svelte = connectSvelteSubmission(hostWritable, { schedule, timeoutMs: 5_000 });
  const states = [];
  const unsubscribe = svelte.state.subscribe((state) => states.push(state.status));
  assert.equal(await svelte.run(() => 'saved'), 'saved');
  const hold = deferred();
  const waiting = svelte.run(() => hold.promise);
  await Promise.resolve();
  const reason = new Error('Svelte user cancelled');
  svelte.cancel(reason);
  await assert.rejects(waiting, (error) => error === reason);
  const disposal = svelte.run(() => new Promise(() => {}));
  svelte.dispose();
  await assert.rejects(disposal, { name: 'AbortError' });
  hold.reject(new Error('late cancelled Svelte work'));
  await Promise.resolve();
  assert.deepEqual(states, ['idle', 'submitting', 'complete', 'submitting', 'cancelled', 'submitting', 'cancelled']);
  unsubscribe();
  assert.equal(subscriptions, 0, 'the actual Svelte store stop callback must run after unsubscribe');
  assert.equal(timers.size, 0);
  await assert.rejects(svelte.run(() => 'after dispose'), { name: 'InvalidStateError' });
  checks.push('Svelte 5 real writable subscribe/set state sequence', 'Svelte cancel/dispose + unsubscribe/timer cleanup');
  console.log(JSON.stringify({ status: 'passed', runtime: `Node.js ${process.versions.node}`, dom: 'jsdom simulated DOM; not a real browser', versions, checks }));
} finally {
  if (root !== undefined) await act(async () => { root.unmount(); });
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  console.error = originalError;
  dom.window.close();
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
}
