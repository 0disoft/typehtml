import { describe, expect, test } from 'bun:test';
import { AnalysisBudget, DEFAULT_ANALYSIS_LIMITS } from '../../src/doctor/budget.ts';
import type { SubmissionFact } from '../../src/doctor/types.ts';

function submission(path = 'forms/example.html'): SubmissionFact {
  const location = { path, line: 2, column: 3, offset: 4 };
  return {
    artifact: { path, sha256: 'a'.repeat(64), sourceKind: 'html' },
    intendedAction: { id: 'example.send', method: 'POST', path: '/send', encoding: 'urlencoded', parserProfile: 'strict-urlencoded-utf8/1' },
    projectionSource: {
      path: 'example.json', sha256: 'b'.repeat(64), generator: 'typehtml', projection: 'exact-for-selected-structural-fields',
      runtimeCoverage: 'not-evaluated', behaviorSha256: 'c'.repeat(64),
    },
    formId: 'example', formLocation: location,
    context: { documentUrl: 'https://example.test/', baseUrl: 'https://example.test/', executionAssumption: 'static', hasScript: false },
    activation: 'submitter@4', submitterLocation: null, rawAction: '/send', rawSubmitterAction: null,
    effectiveTarget: { url: 'https://example.test/send', method: 'POST', encoding: 'application/x-www-form-urlencoded', skipValidation: false },
    fields: [{ name: 'value', possibleCount: 2, locations: [location, location] }],
  };
}

describe('Doctor analysis budgets', () => {
  test('uses frozen defaults and snapshots caller limits', () => {
    expect(DEFAULT_ANALYSIS_LIMITS).toEqual({ maxPaths: 1000, maxControlVisits: 100_000, maxSubmissionBytes: 4 * 1024 * 1024 });
    expect(Object.isFrozen(DEFAULT_ANALYSIS_LIMITS)).toBe(true);
    const limits = { maxPaths: 1 };
    const budget = new AnalysisBudget(limits);
    limits.maxPaths = 10;
    expect(budget.beginPath(0)).toBe(true);
    expect(budget.beginPath(0)).toBe(false);
    expect(limits.maxPaths).toBe(10);
    expect(budget.reason).toBe('maxPaths');
  });

  test('validates limit boundaries and invalid control counts', () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new AnalysisBudget({ maxPaths: value })).toThrow(RangeError);
      expect(() => new AnalysisBudget({ maxControlVisits: value })).toThrow(RangeError);
    }
    expect(() => new AnalysisBudget({ maxSubmissionBytes: 1 })).toThrow(RangeError);
    expect(() => new AnalysisBudget({ maxSubmissionBytes: 2 })).not.toThrow();
    expect(() => new AnalysisBudget({ maxPaths: Number.MAX_SAFE_INTEGER })).not.toThrow();
    const budget = new AnalysisBudget();
    for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => budget.beginPath(count)).toThrow(RangeError);
    expect(budget.exhausted).toBe(false);
    expect(budget.reason).toBeNull();
  });

  test('admits exact path and control limits and stops permanently on the next visit', () => {
    const paths = new AnalysisBudget({ maxPaths: 2 });
    expect(paths.beginPath(0)).toBe(true);
    expect(paths.beginPath(0)).toBe(true);
    expect(paths.exhausted).toBe(false);
    expect(paths.beginPath(0)).toBe(false);
    expect(paths.acceptSubmission(submission())).toBe(false);
    expect(paths.reason).toBe('maxPaths');
    const controls = new AnalysisBudget({ maxControlVisits: 3 });
    expect(controls.beginPath(2)).toBe(true);
    expect(controls.beginPath(1)).toBe(true);
    expect(controls.beginPath(0)).toBe(true);
    expect(controls.beginPath(1)).toBe(false);
    expect(controls.beginPath(0)).toBe(false);
    expect(controls.reason).toBe('maxControlVisits');
  });

  test.each(['plain', '한글😀', 'quote" slash\\ newline\n lone\ud800'])('counts exact compact UTF-8 JSON bytes for %s', (path) => {
    const fact = submission(path);
    const bytes = Buffer.byteLength(JSON.stringify([fact]));
    expect(new AnalysisBudget({ maxSubmissionBytes: bytes }).acceptSubmission(fact)).toBe(true);
    const short = new AnalysisBudget({ maxSubmissionBytes: bytes - 1 });
    expect(short.acceptSubmission(fact)).toBe(false);
    expect(short.reason).toBe('maxSubmissionBytes');
    expect(short.exhausted).toBe(true);
  });

  test('charges repeated references and separating commas without deduplicating their JSON', () => {
    const fact = submission('😀\\"');
    const bytes = Buffer.byteLength(JSON.stringify([fact, fact]));
    const exact = new AnalysisBudget({ maxSubmissionBytes: bytes });
    expect(exact.acceptSubmission(fact)).toBe(true);
    expect(exact.acceptSubmission(fact)).toBe(true);
    expect(exact.exhausted).toBe(false);
    const short = new AnalysisBudget({ maxSubmissionBytes: bytes - 1 });
    expect(short.acceptSubmission(fact)).toBe(true);
    expect(short.acceptSubmission(fact)).toBe(false);
    expect(short.beginPath(0)).toBe(false);
  });

  test('does not reuse stale object sizes after a caller changes a previously accepted fact', () => {
    const fact = submission();
    const bytes = Buffer.byteLength(JSON.stringify([fact, fact]));
    const budget = new AnalysisBudget({ maxSubmissionBytes: bytes });
    expect(budget.acceptSubmission(fact)).toBe(true);
    Object.defineProperty(fact.formLocation, 'path', { value: 'x'.repeat(4096) });
    expect(budget.acceptSubmission(fact)).toBe(false);
    expect(budget.reason).toBe('maxSubmissionBytes');
  });

  test('stops before expanding repeated long locations or serializing the whole fact', () => {
    const longPath = 'x'.repeat(4096);
    const location = { path: longPath, line: 1, column: 1, offset: 0 };
    const locations = Array(5000).fill(location);
    Object.defineProperty(locations, 3, { get() { throw new Error('budget must stop before visiting this location'); } });
    const fact = { ...submission(), fields: [{ name: 'value', possibleCount: 5000, locations }] };
    const original = JSON.stringify;
    let pathSerializations = 0;
    JSON.stringify = function (value: unknown, ...args: any[]): string | undefined {
      if (value !== null && typeof value === 'object') throw new Error('whole-fact serialization is forbidden');
      if (value === longPath) pathSerializations++;
      return Reflect.apply(original, JSON, [value, ...args]);
    } as typeof JSON.stringify;
    let accepted;
    try { accepted = new AnalysisBudget({ maxSubmissionBytes: 10_000 }).acceptSubmission(fact); }
    finally { JSON.stringify = original; }
    expect(accepted).toBe(false);
    expect(pathSerializations).toBe(1);
  });
});
