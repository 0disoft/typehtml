import { describe, expect, test } from 'bun:test';
import { makeCollector } from '../../src/doctor/collector.ts';
import type { CoverageRow, LoadedDoctorConfig } from '../../src/doctor/types.ts';

function loaded(groups: readonly CoverageRow['ruleGroup'][]): LoadedDoctorConfig {
  return {
    configPath: 'doctor.json', baseDir: '.', formChecks: new Map(), sourceIssues: new Map(),
    config: { format: 'boundary-doctor/0.5-draft', root: '.', inputs: [], documents: [],
      releaseRequiresCompleteDeclaredBoundary: true, releaseRequiredRuleGroups: groups },
  };
}

function row(target: string, ruleGroup: CoverageRow['ruleGroup'], actualStatus: CoverageRow['actualStatus'] = 'checked'): CoverageRow {
  return { target, ruleGroup, actualStatus, evidenceRef: null, note: 'original' };
}

describe('indexed Doctor coverage completion', () => {
  test('preserves activation/group insertion order, severity replacement and missing-row semantics', () => {
    const collector = makeCollector(loaded(['binding', 'target', 'supply', 'runtime-security', 'bypass']));
    collector.scope(true, 'second', 'page#f');
    collector.cover(row('page#f', 'target'));
    collector.cover(row('page#f', 'target', 'unknown'));
    collector.cover(row('page#f', 'target'));
    collector.scope(true, 'first');
    collector.cover(row('page#f', 'target'));
    collector.scope(false, 'other', 'page#other');
    collector.cover(row('page#other', 'target'));
    collector.scope(true, 'binding', 'page#f');
    collector.completeBoundary();
    collector.completeBoundary();
    expect(collector.coverage.map((item) => [item.target, item.ruleGroup, item.activation, item.actualStatus])).toEqual([
      ['page#f', 'target', 'second', 'unknown'], ['page#f', 'target', 'first', 'checked'],
      ['page#other', 'target', 'other', 'checked'], ['page#f', 'binding', 'binding', 'not-evaluated'],
      ['page#f', 'supply', 'second', 'not-evaluated'], ['page#f', 'supply', 'first', 'not-evaluated'],
      ['page#f', 'runtime-security', 'binding', 'not-evaluated'], ['page#f', 'bypass', 'binding', 'not-evaluated'],
    ]);
    expect(collector.coverage.at(-1)?.requiredBoundary).toBe(true);
    expect(collector.isIncomplete()).toBe(true);
  });

  test('does not rescan existing coverage rows when completing a thousand boundaries', () => {
    const groups = ['binding', 'target', 'supply', 'constraints'] as const;
    const collector = makeCollector(loaded(groups));
    for (let i = 0; i < 1000; i++) {
      const target = `page#f${i}`;
      for (const group of groups) {
        collector.scope(true, group === 'binding' ? 'binding' : 'submit', target);
        collector.cover(row(target, group));
      }
    }
    let reads = 0;
    for (const item of collector.coverage) {
      const target = item.target;
      Object.defineProperty(item, 'target', { get() { reads++; return target; } });
    }
    for (let i = 0; i < 1000; i++) {
      collector.scope(true, 'binding', `page#f${i}`);
      collector.completeBoundary();
    }
    expect(reads).toBe(0);
    expect(collector.coverage).toHaveLength(4000);
    expect(collector.isIncomplete()).toBe(false);
  });

  test('uses binding scope when no native activation was recorded', () => {
    const collector = makeCollector(loaded(['target', 'constraints', 'target']));
    collector.scope(false, 'binding', 'page#optional');
    collector.completeBoundary();
    expect(collector.coverage.map((item) => [item.ruleGroup, item.activation, item.requiredBoundary]))
      .toEqual([['target', 'binding', false], ['constraints', 'binding', false]]);
    expect(collector.isIncomplete()).toBe(false);
  });
});
