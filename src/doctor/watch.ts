import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readStrictJson } from '../contract/strict-json.ts';
import { runDoctor } from './analyze.ts';
import { loadDoctorConfig } from './config.ts';
import type { DoctorReport } from './types.ts';

async function selectedPaths(configPath: string, previous: readonly string[] = []): Promise<string[]> {
  const paths = new Set([resolve(configPath)]);
  try {
    const loaded = await loadDoctorConfig(configPath);
    for (const input of loaded.config.inputs) paths.add(resolve(loaded.baseDir, input.path));
    for (const document of loaded.config.documents) paths.add(resolve(loaded.baseDir, document.path));
    for (const projection of loaded.formChecks.values()) paths.add(resolve(loaded.baseDir, projection.source.path));
  } catch {
    // Keep known dependencies while a projection is broken, so fixing that file can recover the watch.
    for (const path of previous) paths.add(path);
    try {
      const config = await readStrictJson(configPath);
      if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
        const root = resolve(typeof config.root === 'string' ? config.root : '.');
        for (const list of [config.inputs, config.documents]) {
          if (!Array.isArray(list)) continue;
          for (const item of list) {
            if (item === null || typeof item !== 'object' || Array.isArray(item) || typeof item.path !== 'string') continue;
            const absolute = resolve(root, item.path);
            const rel = relative(root, absolute);
            if (rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel)) paths.add(absolute);
          }
        }
      }
    } catch { /* runDoctor owns configuration error diagnostics. */ }
  }
  return [...paths];
}

async function fingerprint(paths: readonly string[]): Promise<string> {
  return JSON.stringify(await Promise.all(paths.map(async (path) => {
    try { const info = await stat(path, { bigint: true }); return [path, String(info.mtimeNs), String(info.size), String(info.ino)]; }
    catch { return [path, 'unreadable']; }
  })));
}

/** Explicit, host-owned polling watch; one analysis at a time and no recursive directory watchers. */
export async function watchDoctor(configPath: string, options: Readonly<{
  signal: AbortSignal;
  onReport: (report: DoctorReport) => void | Promise<void>;
  intervalMs?: number;
  /** Useful for bounded integrations and tests. Omit for an explicitly managed watch lifetime. */
  maxRuns?: number;
}>): Promise<void> {
  const interval = options.intervalMs ?? 500;
  if (!Number.isSafeInteger(interval) || interval < 10 || interval > 2_147_483_647) throw new RangeError('invalid Doctor watch interval');
  if (options.maxRuns !== undefined && (!Number.isSafeInteger(options.maxRuns) || options.maxRuns < 1)) throw new RangeError('invalid Doctor watch run count');
  let paths = await selectedPaths(configPath);
  let previous = '';
  let runs = 0;
  while (!options.signal.aborted) {
    const current = await fingerprint(paths);
    if (current !== previous) {
      // Record before analysis so edits made during analysis trigger the next run.
      previous = current;
      await options.onReport(await runDoctor(configPath));
      if (++runs === options.maxRuns) return;
      const selected = await selectedPaths(configPath, paths);
      if (JSON.stringify(paths) !== JSON.stringify(selected)) { paths = selected; previous = ''; }
    }
    try { await delay(interval, undefined, { signal: options.signal }); }
    catch (error) { if (options.signal.aborted) return; throw error; }
  }
}
