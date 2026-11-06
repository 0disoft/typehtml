import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runDoctor } from './analyze.ts';
import { loadDoctorConfig } from './config.ts';
import type { DoctorReport } from './types.ts';

async function selectedPaths(configPath: string): Promise<string[]> {
  const paths = new Set([resolve(configPath)]);
  try {
    const loaded = await loadDoctorConfig(configPath);
    for (const input of loaded.config.inputs) paths.add(resolve(loaded.baseDir, input.path));
    for (const document of loaded.config.documents) paths.add(resolve(loaded.baseDir, document.path));
    for (const projection of loaded.formChecks.values()) paths.add(resolve(loaded.baseDir, projection.source.path));
  } catch { /* Invalid configurations remain watched and are reported by runDoctor. */ }
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
      const selected = await selectedPaths(configPath);
      if (JSON.stringify(paths) !== JSON.stringify(selected)) { paths = selected; previous = ''; }
    }
    try { await delay(interval, undefined, { signal: options.signal }); }
    catch (error) { if (options.signal.aborted) return; throw error; }
  }
}
