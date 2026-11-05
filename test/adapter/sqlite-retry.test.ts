import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { SqliteOrderStore, StoreBusyError, type OrderStoreOptions } from '../../src/adapter/sqlite/order-store.ts';
import type { OrderWriteTx } from '../../src/runtime/order-storage.ts';

type LockedStore = { store: SqliteOrderStore; blocker: Database; release: () => void };

/** Real SQLite locks, but no real sleep, wall-clock deadlines, or global mocks. */
async function withLockedStore(work: (fixture: LockedStore) => Promise<void>, options: OrderStoreOptions = {}) {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'typehtml-retry-'));
  let store: SqliteOrderStore | undefined;
  let blocker: Database | undefined;
  const release = () => { if (blocker?.inTransaction) blocker.exec('ROLLBACK'); };
  try {
    const filename = join(directory, 'orders.sqlite');
    store = new SqliteOrderStore(filename, { busyRetryBudgetMs: 5, busyMaxWaitMs: 1, ...options });
    blocker = new Database(filename, { strict: true });
    blocker.exec('PRAGMA busy_timeout = 0');
    blocker.exec('BEGIN IMMEDIATE');
    await work({ store, blocker, release });
  } finally {
    release();
    blocker?.close();
    store?.close();
    const actual = await realpath(directory);
    if (resolve(actual) !== resolve(directory) || dirname(actual) !== parent || !basename(actual).startsWith('typehtml-retry-')) {
      throw new Error('refusing cleanup outside the retry fixture');
    }
    await rm(actual, { recursive: true, force: true });
  }
}

const audit = (tx: OrderWriteTx) => {
  tx.insertAudit({ intentId: 'intent', actionId: 'action', outcome: 'SUCCESS', createdAt: 1 });
  return 42;
};
const auditCount = (database: Database) => (database.query('SELECT count(*) AS count FROM boundary_audit').get() as { count: number }).count;

describe('SQLite retry deadline and cancellation', () => {
  test.each([4.999, 5, 5.001])('a lock released at %dms obeys the exclusive 5ms retry deadline', async (releasedAt) => {
    await withLockedStore(async ({ store, blocker, release }) => {
      let time = 0;
      let executions = 0;
      const waits: number[] = [];
      const operation = store.immediate((tx) => { executions++; return audit(tx); }, {
        now: () => time,
        async sleep(ms) { waits.push(ms); time = releasedAt; release(); },
      });
      if (releasedAt < 5) await expect(operation).resolves.toBe(42);
      else await expect(operation).rejects.toMatchObject({ name: 'StoreBusyError', retryAfterSeconds: 1 });
      expect(waits).toEqual([1]);
      expect(executions).toBe(releasedAt < 5 ? 1 : 0);
      expect(auditCount(blocker)).toBe(releasedAt < 5 ? 1 : 0);
      await expect(store.immediate(() => 'usable')).resolves.toBe('usable');
    });
  });

  test.each([false, true])('zero retry budget permits one immediate attempt (locked=%s)', async (locked) => {
    await withLockedStore(async ({ store, release }) => {
      if (!locked) release();
      let waits = 0;
      let executions = 0;
      const operation = store.immediate(() => ++executions, {
        now: () => 0, async sleep() { waits++; },
      });
      if (locked) await expect(operation).rejects.toBeInstanceOf(StoreBusyError);
      else await expect(operation).resolves.toBe(1);
      expect(waits).toBe(0);
      expect(executions).toBe(locked ? 0 : 1);
    }, { busyRetryBudgetMs: 0 });
  });

  test('waits only for the remaining fractional budget and never retries at its deadline', async () => {
    await withLockedStore(async ({ store, blocker, release }) => {
      let time = 0;
      const waits: number[] = [];
      await expect(store.immediate(audit, {
        now: () => time,
        async sleep(ms) {
          waits.push(ms);
          if (waits.length === 1) time = 4.75;
          else { time = 5; release(); }
        },
      })).rejects.toBeInstanceOf(StoreBusyError);
      expect(waits).toEqual([5, 0.25]);
      expect(auditCount(blocker)).toBe(0);
    }, { busyMaxWaitMs: 50 });
  });

  test.each(['expired', 'invalid'] as const)('a clock becoming %s after acquisition rolls back before work', async (mode) => {
    await withLockedStore(async ({ store, blocker, release }) => {
      let time = 0;
      let observeAcquisition = false;
      await expect(store.immediate(audit, {
        now() {
          if (observeAcquisition) {
            // Observe the actual lock rather than assuming how often the clock is called.
            try { blocker.exec('BEGIN IMMEDIATE'); blocker.exec('ROLLBACK'); }
            catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'SQLITE_BUSY')) throw error;
              return mode === 'expired' ? 5 : NaN;
            }
          }
          return time;
        },
        async sleep() { time = 4; release(); observeAcquisition = true; },
      })).rejects.toThrow(mode === 'expired' ? 'SQLITE_BUSY' : 'INVALID_SQLITE_RETRY_CLOCK');
      expect(auditCount(blocker)).toBe(0);
      // This succeeds only if the newly acquired transaction was rolled back.
      await expect(store.immediate(audit)).resolves.toBe(42);
      expect(auditCount(blocker)).toBe(1);
    });
  });

  test('caps a single wait at the platform timer limit', async () => {
    await withLockedStore(async ({ store, release }) => {
      let time = 0;
      const waits: number[] = [];
      await expect(store.immediate(() => 'late', {
        now: () => time,
        async sleep(ms) { waits.push(ms); time = 2_147_483_648; release(); },
      })).rejects.toBeInstanceOf(StoreBusyError);
      expect(waits).toEqual([2_147_483_647]);
    }, { busyRetryBudgetMs: 2_147_483_648, busyMaxWaitMs: 2_147_483_648 });
  });

  test('pre-aborted calls do not invoke work or poison the connection', async () => {
    const store = new SqliteOrderStore(':memory:');
    const controller = new AbortController();
    const reason = new Error('cancelled before acquisition');
    controller.abort(reason);
    let executions = 0;
    try {
      await expect(store.immediate(() => ++executions, { signal: controller.signal })).rejects.toBe(reason);
      expect(executions).toBe(0);
      await expect(store.immediate(() => 42)).resolves.toBe(42);
    } finally { store.close(); }
  });

  test('cancellation ends an uncooperative pending I/O wait without another write attempt', async () => {
    await withLockedStore(async ({ store, blocker, release }) => {
      const controller = new AbortController();
      const reason = new Error('request disconnected');
      let entered!: () => void;
      const waiting = new Promise<void>((resolveWaiting) => { entered = resolveWaiting; });
      let receivedSignal: AbortSignal | undefined;
      const operation = store.immediate(audit, {
        now: () => 0, signal: controller.signal,
        sleep(_ms, signal) { receivedSignal = signal; entered(); return new Promise(() => {}); },
      });
      await waiting;
      controller.abort(reason);
      await expect(operation).rejects.toBe(reason);
      expect(receivedSignal).toBe(controller.signal);
      expect(auditCount(blocker)).toBe(0);
      release();
      await expect(store.immediate(() => 42)).resolves.toBe(42);
    });
  });

  test('the default I/O wait also honors cancellation', async () => {
    await withLockedStore(async ({ store, release }) => {
      const controller = new AbortController();
      const reason = new Error('stop default timer');
      const operation = store.immediate(audit, { signal: controller.signal });
      // Let the default timer start, without waiting for real time to elapse.
      await Promise.resolve();
      controller.abort(reason);
      await expect(operation).rejects.toBe(reason);
      release();
      await expect(store.immediate(() => 42)).resolves.toBe(42);
    }, { busyRetryBudgetMs: 60_000, busyMaxWaitMs: 60_000 });
  });

  test('a cancelled callback rolls back its writes before commit', async () => {
    await withLockedStore(async ({ store, blocker, release }) => {
      release();
      const controller = new AbortController();
      const reason = new Error('cancel before commit');
      await expect(store.immediate((tx) => {
        audit(tx);
        controller.abort(reason);
        return 42;
      }, { signal: controller.signal })).rejects.toBe(reason);
      expect(auditCount(blocker)).toBe(0);
      await expect(store.immediate(audit)).resolves.toBe(42);
      expect(auditCount(blocker)).toBe(1);
    });
  });

  test.each(['throw', 'reject'] as const)('a %s from the wait preserves its error and leaves no transaction open', async (mode) => {
    await withLockedStore(async ({ store, blocker, release }) => {
      const failure = new Error('wait unavailable');
      await expect(store.immediate(audit, {
        now: () => 0,
        sleep() { if (mode === 'throw') throw failure; return Promise.reject(failure); },
      })).rejects.toBe(failure);
      expect(auditCount(blocker)).toBe(0);
      release();
      await expect(store.immediate(audit)).resolves.toBe(42);
    });
  });

  test.each([NaN, Infinity, -1])('invalid monotonic clock %s fails before work', async (time) => {
    const store = new SqliteOrderStore(':memory:');
    let executions = 0;
    try {
      await expect(store.immediate(() => ++executions, { now: () => time })).rejects.toThrow('INVALID_SQLITE_RETRY_CLOCK');
      expect(executions).toBe(0);
      await expect(store.immediate(() => 42)).resolves.toBe(42);
    } finally { store.close(); }
  });

  test('a clock moving backwards during I/O fails closed', async () => {
    await withLockedStore(async ({ store, blocker, release }) => {
      let time = 10;
      await expect(store.immediate(audit, {
        now: () => time, async sleep() { time = 9; release(); },
      })).rejects.toThrow('INVALID_SQLITE_RETRY_CLOCK');
      expect(auditCount(blocker)).toBe(0);
      await expect(store.immediate(() => 42)).resolves.toBe(42);
    });
  });

  test('non-busy acquisition errors are not retried or replaced', async () => {
    const store = new SqliteOrderStore(':memory:');
    store.close();
    let waits = 0;
    await expect(store.immediate(() => 42, { async sleep() { waits++; } })).rejects.not.toBeInstanceOf(StoreBusyError);
    expect(waits).toBe(0);
  });
});
