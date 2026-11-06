import type { SubmissionFact } from './types.ts';

export type AnalysisLimits = Readonly<{
  maxPaths: number;
  maxControlVisits: number;
  maxSubmissionBytes: number;
}>;

export const DEFAULT_ANALYSIS_LIMITS: AnalysisLimits = Object.freeze({
  maxPaths: 1000, maxControlVisits: 100_000, maxSubmissionBytes: 4 * 1024 * 1024,
});

/** Measures owned plain JSON without building the expanded report string. */
function jsonBytes(value: unknown, available: number, sizes: WeakMap<object, number>, active: WeakSet<object>): number {
  if (available < 0) return Infinity;
  if (value === null || typeof value !== 'object') {
    const size = Buffer.byteLength(JSON.stringify(value) ?? 'null');
    return size <= available ? size : Infinity;
  }
  const cached = sizes.get(value);
  if (cached !== undefined) return cached <= available ? cached : Infinity;
  if (active.has(value)) throw new TypeError('Cyclic submission facts are unsupported');
  active.add(value);
  let size = 2;
  let count = 0;
  try {
    if (size > available) return Infinity;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (index > 0) size++;
        size += jsonBytes(value[index], available - size, sizes, active);
        if (size > available) return Infinity;
      }
    } else {
      for (const key of Object.keys(value)) {
        const child = (value as Record<string, unknown>)[key];
        if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
        if (count++ > 0) size++;
        size += Buffer.byteLength(JSON.stringify(key)) + 1;
        size += jsonBytes(child, available - size, sizes, active);
        if (size > available) return Infinity;
      }
    }
    sizes.set(value, size);
    return size;
  } finally {
    active.delete(value);
  }
}

/** A per-run budget; exceeding any limit permanently prevents further work. */
export class AnalysisBudget {
  private readonly limits: AnalysisLimits;
  private paths = 0;
  private controlVisits = 0;
  private submissionBytes = 2; // The compact submissions array's enclosing brackets.
  private submissions = 0;
  private stoppedBy: keyof AnalysisLimits | null = null;

  constructor(limits: Partial<AnalysisLimits> = {}) {
    const merged = { ...DEFAULT_ANALYSIS_LIMITS };
    for (const key of Object.keys(limits)) {
      if (!Object.hasOwn(DEFAULT_ANALYSIS_LIMITS, key)) throw new RangeError(`Unknown analysis limit: ${key}`);
      const name = key as keyof AnalysisLimits;
      const value = limits[name];
      if (value !== undefined) merged[name] = value;
    }
    for (const [key, value] of Object.entries(merged)) {
      if (!Number.isSafeInteger(value) || value < (key === 'maxSubmissionBytes' ? 2 : 1)) {
        throw new RangeError(`Invalid analysis limit: ${key}`);
      }
    }
    this.limits = Object.freeze(merged);
  }

  get exhausted(): boolean { return this.stoppedBy !== null; }
  get reason(): keyof AnalysisLimits | null { return this.stoppedBy; }

  private stop(reason: keyof AnalysisLimits): false {
    this.stoppedBy = reason;
    return false;
  }

  beginPath(controlCount: number): boolean {
    if (this.exhausted) return false;
    if (!Number.isSafeInteger(controlCount) || controlCount < 0) throw new RangeError('Invalid control count');
    if (this.paths >= this.limits.maxPaths) return this.stop('maxPaths');
    if (controlCount > this.limits.maxControlVisits - this.controlVisits) return this.stop('maxControlVisits');
    this.paths++;
    this.controlVisits += controlCount;
    return true;
  }

  acceptSubmission(fact: SubmissionFact): boolean {
    if (this.exhausted) return false;
    const comma = this.submissions > 0 ? 1 : 0;
    // Cache only within this measurement so later caller mutations cannot reuse a stale size.
    const size = jsonBytes(fact, this.limits.maxSubmissionBytes - this.submissionBytes - comma, new WeakMap(), new WeakSet());
    if (!Number.isFinite(size)) return this.stop('maxSubmissionBytes');
    this.submissionBytes += size + comma;
    this.submissions++;
    return true;
  }
}
