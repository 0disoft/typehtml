import { lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { sourceSha256 } from '../contract/behavior.ts';
import type { DoctorBindingConfig, DoctorConfig, DoctorDocumentConfig, DoctorInputConfig } from './types.ts';

export interface RenderedSnapshotSelection {
  /** Stable route/state identifier; each selected state must be declared separately. */
  readonly id: string;
  readonly url: string;
  readonly bindings: readonly DoctorBindingConfig[];
}

export interface RenderedSnapshot {
  readonly id: string;
  readonly html: string;
  readonly sha256: string;
  readonly document: DoctorDocumentConfig;
}

export interface RenderedCollection {
  readonly format: 'typehtml-rendered-snapshots/1';
  readonly applicationCompleteness: 'not-evaluated';
  readonly snapshots: readonly RenderedSnapshot[];
}

export interface CollectRenderedHtmlOptions {
  readonly selections: readonly RenderedSnapshotSelection[];
  readonly allowedOrigins: readonly string[];
  /** Render a selected state inside the host framework. TypeHTML never imports or executes app modules. */
  readonly render?: (selection: RenderedSnapshotSelection, context: Readonly<{ signal: AbortSignal }>) => string | Response | Promise<string | Response>;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
  readonly maxBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxSnapshots?: number;
}

type CaptureLimits = { timeoutMs: number; concurrency: number; maxBytes: number; maxTotalBytes: number; maxSnapshots: number };
type CaptureCallbacks = Readonly<{
  render: CollectRenderedHtmlOptions['render'];
  fetch: typeof globalThis.fetch;
  receiver: CollectRenderedHtmlOptions;
}>;
const DEFAULTS: Readonly<CaptureLimits> = Object.freeze({ timeoutMs: 30_000, concurrency: 4, maxBytes: 2 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024, maxSnapshots: 100 });

function positive(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`invalid capture ${name}`);
  return value;
}

function validateOrigins(origins: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const origin of origins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new TypeError('capture origins must be serialized HTTP(S) origins');
    result.add(origin);
  }
  if (result.size === 0) throw new TypeError('capture requires an explicit allowed origin');
  return result;
}

async function boundedHtml(response: Response, maxBytes: number, signal: AbortSignal, assertActive: () => void): Promise<string> {
  try {
    if (!response.ok) throw new Error(`capture HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^text\/html(?:\s*;|$)/i.test(contentType)) throw new TypeError('capture response must be text/html');
    for (const charset of contentType.matchAll(/;\s*charset\s*=\s*"?([^";\s]+)/gi)) {
      if (charset[1]!.toLowerCase() !== 'utf-8') throw new TypeError('capture response must use UTF-8');
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^[0-9]+$/.test(declared) || BigInt(declared) > BigInt(maxBytes))) throw new RangeError('capture response exceeds maxBytes');
  } catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    assertActive();
    for (;;) {
      const result = await reader.read();
      assertActive();
      if (result.done) { done = true; break; }
      size += result.value.byteLength;
      if (size > maxBytes) throw new RangeError('capture response exceeds maxBytes');
      chunks.push(result.value.slice());
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!done) { try { void reader.cancel().catch(() => undefined); } catch { /* Preserve the capture failure. */ } }
    reader.releaseLock();
  }
}

async function captureOne(selection: RenderedSnapshotSelection, callbacks: CaptureCallbacks, limits: CaptureLimits, parent: AbortSignal): Promise<RenderedSnapshot> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const deadline = performance.now() + limits.timeoutMs;
  const timeoutError = new DOMException('rendered HTML capture timed out', 'TimeoutError');
  const assertActive = () => {
    signal.throwIfAborted();
    // Ready promises and synchronous rendering can prevent the timeout callback from running.
    if (performance.now() >= deadline) controller.abort(timeoutError);
    signal.throwIfAborted();
  };
  let rejectAbort: ((error: unknown) => void) | undefined;
  const abort = () => rejectAbort?.(signal.reason);
  const timeout = setTimeout(() => controller.abort(timeoutError), limits.timeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  try {
    assertActive();
    const work = async () => {
      const rendered = callbacks.render
        ? await Reflect.apply(callbacks.render, callbacks.receiver, [selection, { signal }])
        : await Reflect.apply(callbacks.fetch, undefined, [selection.url, { signal, redirect: 'manual', headers: { Accept: 'text/html' } }]);
      try {
        assertActive();
        if (rendered instanceof Response && rendered.url !== '' && new URL(rendered.url).origin !== new URL(selection.url).origin) throw new TypeError('capture response origin changed');
        const html = typeof rendered === 'string' ? rendered : await boundedHtml(rendered, limits.maxBytes, signal, assertActive);
        assertActive();
        if (Buffer.byteLength(html) > limits.maxBytes) throw new RangeError('capture HTML exceeds maxBytes');
        if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(html)) !== html) throw new TypeError('capture HTML contains invalid Unicode');
        const snapshot = Object.freeze({ id: selection.id, html, sha256: sourceSha256(Buffer.from(html)), document: Object.freeze({
          path: `${selection.id}.html`, documentUrl: selection.url, sourceKind: 'rendered-html',
          executionAssumption: 'selected-rendered-state-only; no-script-execution; other-routes-and-states-not-evaluated', bindings: selection.bindings,
        }) });
        assertActive();
        return snapshot;
      } catch (error) {
        // A timed-out host callback may still return a response later; do not leave its body open.
        if (rendered instanceof Response && !rendered.body?.locked) void rendered.body?.cancel().catch(() => undefined);
        throw error;
      }
    };
    return await Promise.race([work(), new Promise<never>((_, reject) => { rejectAbort = reject; if (signal.aborted) reject(signal.reason); })]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

/** Collect explicit rendered states with bounded fan-out; never discovers routes or executes scripts. */
export async function collectRenderedHtml(options: CollectRenderedHtmlOptions): Promise<RenderedCollection> {
  const callbacks: CaptureCallbacks = Object.freeze({ render: options.render, fetch: options.fetch ?? globalThis.fetch, receiver: options });
  const limits = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
    limits[key] = positive(options[key] ?? DEFAULTS[key], key, key === 'timeoutMs' ? 2_147_483_647 : Number.MAX_SAFE_INTEGER);
  }
  const origins = validateOrigins(options.allowedOrigins);
  if (options.selections.length === 0 || options.selections.length > limits.maxSnapshots) throw new RangeError('capture selection count exceeds bounds');
  const ids = new Set<string>();
  const selections = options.selections.map((item) => {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(item.id) || ids.has(item.id.toLowerCase())) throw new TypeError('capture ids must be unique safe filenames');
    ids.add(item.id.toLowerCase());
    const url = new URL(item.url);
    if (!origins.has(url.origin) || url.username || url.password || url.hash) throw new TypeError('capture URL is outside the allowed origin profile');
    if (item.bindings.length === 0) throw new TypeError('capture requires explicit form bindings for every state');
    return Object.freeze({ id: item.id, url: url.href, bindings: Object.freeze(item.bindings.map((binding) => Object.freeze({ ...binding }))) });
  });
  const controller = new AbortController();
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
  const snapshots: RenderedSnapshot[] = new Array(selections.length);
  let next = 0;
  let totalBytes = 0;
  const worker = async () => {
    for (;;) {
      signal.throwIfAborted();
      const index = next++;
      const selection = selections[index];
      if (!selection) return;
      const snapshot = await captureOne(selection, callbacks, limits, signal);
      totalBytes += Buffer.byteLength(snapshot.html);
      if (totalBytes > limits.maxTotalBytes) throw new RangeError('capture HTML exceeds maxTotalBytes');
      snapshots[index] = snapshot;
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(limits.concurrency, selections.length) }, worker)); }
  catch (error) { controller.abort(error); throw error; }
  return Object.freeze({ format: 'typehtml-rendered-snapshots/1', applicationCompleteness: 'not-evaluated', snapshots: Object.freeze(snapshots) });
}

/** Write only to a new directory, staged atomically; never overwrites application or source files. */
export async function writeRenderedCollection(collection: RenderedCollection, options: Readonly<{
  directory: string; root: string; inputs: readonly DoctorInputConfig[];
}>): Promise<Readonly<{ configPath: string; config: DoctorConfig }>> {
  const root = resolve(options.root);
  const directory = resolve(options.directory);
  const rel = relative(root, directory);
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new TypeError('capture directory must stay inside Doctor root');
  if (options.inputs.length === 0) throw new TypeError('capture requires form projection inputs');
  const realParent = await realpath(dirname(directory));
  const realRoot = await realpath(root);
  const realRel = relative(realRoot, realParent);
  if (realRel === '..' || realRel.startsWith('..\\') || realRel.startsWith('../') || isAbsolute(realRel)) throw new TypeError('capture directory resolves outside Doctor root');
  for (const snapshot of collection.snapshots) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(snapshot.id) || snapshot.document.path !== `${snapshot.id}.html`) throw new TypeError('invalid captured snapshot filename');
  }
  const config: DoctorConfig = {
    format: 'boundary-doctor/0.5-draft', root, inputs: options.inputs.map((input) => ({ ...input })),
    documents: collection.snapshots.map((snapshot) => ({ ...snapshot.document, path: join(rel, snapshot.document.path) })),
    releaseRequiresCompleteDeclaredBoundary: true, releaseRequiredRuleGroups: ['binding', 'target', 'supply', 'cardinality'],
  };
  const stage = join(dirname(directory), `.typehtml-capture-${crypto.randomUUID()}`);
  await mkdir(stage);
  try {
    for (const snapshot of collection.snapshots) await writeFile(join(stage, snapshot.document.path), snapshot.html, { flag: 'wx' });
    await writeFile(join(stage, 'doctor.config.json'), JSON.stringify({ ...config, audit: {
      releaseRequiresCompleteDeclaredBoundary: config.releaseRequiresCompleteDeclaredBoundary,
      releaseRequiredRuleGroups: config.releaseRequiredRuleGroups,
    } }, null, 2), { flag: 'wx' });
    // rename cannot replace a nonempty directory. Refuse even an existing empty target explicitly.
    try { await lstat(directory); throw new Error('capture output directory already exists'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    await rename(stage, directory);
    return Object.freeze({ configPath: join(directory, 'doctor.config.json'), config });
  } finally { await rm(stage, { recursive: true, force: true }); }
}
