import { describe, expect, it } from 'bun:test';
import { getEventListeners } from 'node:events';
import { createSubmissionTask, SubmissionPendingError, type SubmissionState } from '../../src/form/submission.ts';

function clock() {
  const pending = new Set<() => void>();
  return {
    pending,
    schedule(callback: () => void, _delay: number) { pending.add(callback); return () => { pending.delete(callback); }; },
    expire() { for (const callback of [...pending]) callback(); },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('host-owned submission tasks', () => {
  it('executes one attempt and releases its timer and parent/per-run listeners on success or failure', async () => {
    for (const fail of [false, true]) {
      const timers = clock();
      const parent = new AbortController();
      const request = new AbortController();
      const states: SubmissionState<number>[] = [];
      const failure = new Error('original task failure');
      let attempts = 0;
      const task = createSubmissionTask<number>({ signal: parent.signal, schedule: timers.schedule, onState: (state) => states.push(state) });
      const result = task.run(({ signal }) => { attempts++; expect(signal.aborted).toBe(false); if (fail) throw failure; return 42; }, { signal: request.signal });
      if (fail) await expect(result).rejects.toBe(failure);
      else await expect(result).resolves.toBe(42);
      expect(attempts).toBe(1);
      expect(states.map(({ status }) => status)).toEqual(['submitting', fail ? 'error' : 'complete']);
      expect(states.every(Object.isFrozen)).toBe(true);
      expect(task.getSnapshot().pending).toBe(false);
      expect(timers.pending.size).toBe(0);
      expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
      expect(getEventListeners(request.signal, 'abort')).toHaveLength(0);
    }
  });

  it('rejects concurrent duplicates and ignores a cancelled task that settles after a later submission', async () => {
    const timers = clock();
    const first = deferred<string>();
    const states: SubmissionState<string>[] = [];
    const task = createSubmissionTask<string>({ schedule: timers.schedule, onState: (state) => states.push(state) });
    let attempts = 0;
    const running = task.run(() => { attempts++; return first.promise; });
    await Promise.resolve();
    await expect(task.run(() => { attempts++; return 'duplicate'; })).rejects.toBeInstanceOf(SubmissionPendingError);
    const reason = new Error('user cancelled');
    task.cancel(reason);
    await expect(running).rejects.toBe(reason);
    await expect(task.run(() => { attempts++; return 'new result'; })).resolves.toBe('new result');
    first.resolve('stale result');
    await Promise.resolve();
    expect(task.getSnapshot()).toMatchObject({ status: 'complete', sequence: 2, value: 'new result' });
    expect(states.map(({ status }) => status)).toEqual(['submitting', 'cancelled', 'submitting', 'complete']);
    expect(attempts).toBe(2);
    expect(timers.pending.size).toBe(0);
  });

  it('propagates exact parent/per-run abort reasons and never invokes an already cancelled task', async () => {
    for (const mode of ['parent-before', 'parent-during', 'request-before', 'request-during'] as const) {
      const parent = new AbortController();
      const request = new AbortController();
      const source = mode.startsWith('parent') ? parent : request;
      const before = mode.endsWith('before');
      const reason = new Error(mode);
      if (before) source.abort(reason);
      const timers = clock();
      let attempts = 0;
      const task = createSubmissionTask<string>({ signal: parent.signal, schedule: timers.schedule });
      const running = task.run(() => { attempts++; return new Promise<string>(() => {}); }, { signal: request.signal });
      if (!before) { await Promise.resolve(); source.abort(reason); }
      await expect(running).rejects.toBe(reason);
      expect(attempts).toBe(before ? 0 : 1);
      expect(task.getSnapshot()).toMatchObject({ status: 'cancelled', error: reason, pending: false });
      expect(timers.pending.size).toBe(0);
      expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
      expect(getEventListeners(request.signal, 'abort')).toHaveLength(0);
    }
  });

  it('times out uncooperative work without retries and handles its late rejection', async () => {
    const timers = clock();
    const late = deferred<number>();
    let attempts = 0;
    let received!: AbortSignal;
    const task = createSubmissionTask<number>({ schedule: timers.schedule, timeoutMs: 1 });
    const running = task.run(({ signal }) => { attempts++; received = signal; return late.promise; });
    await Promise.resolve();
    timers.expire();
    await expect(running).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(received.aborted).toBe(true);
    expect(task.getSnapshot().status).toBe('cancelled');
    expect(timers.pending.size).toBe(0);
    late.reject(new Error('late I/O failure'));
    await Promise.resolve();
    expect(attempts).toBe(1);
    expect(task.getSnapshot().error).toBe(received.reason);
  });

  it('disposes idempotently, aborts active work, and prevents all subsequent execution', async () => {
    const timers = clock();
    const parent = new AbortController();
    let attempts = 0;
    const task = createSubmissionTask<number>({ schedule: timers.schedule, signal: parent.signal });
    const running = task.run(() => { attempts++; return new Promise<number>(() => {}); });
    await Promise.resolve();
    task.dispose(); task.dispose();
    await expect(running).rejects.toMatchObject({ name: 'AbortError', message: 'submission disposed' });
    await expect(task.run(() => { attempts++; return 2; })).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(attempts).toBe(1);
    expect(timers.pending.size).toBe(0);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
  });

  it('bounds timeout configuration and cleans up a failed host scheduler or state callback', async () => {
    for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) expect(() => createSubmissionTask({ timeoutMs })).toThrow(TypeError);
    for (const timeoutMs of [1, 2_147_483_647]) expect(createSubmissionTask({ timeoutMs }).getSnapshot().status).toBe('idle');
    for (const stage of ['schedule', 'state'] as const) {
      const parent = new AbortController();
      const failure = new Error(stage);
      let attempts = 0;
      const task = createSubmissionTask({
        signal: parent.signal,
        ...(stage === 'schedule' ? { schedule: () => { throw failure; } } : { onState: () => { throw failure; } }),
      });
      await expect(task.run(() => { attempts++; })).rejects.toBe(failure);
      expect(attempts).toBe(0);
      expect(task.getSnapshot().pending).toBe(false);
      expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
    }
  });

  it('attempts every cleanup and releases the duplicate guard when a host scheduler cleanup throws', async () => {
    for (const fail of [false, true]) {
      const parent = new AbortController();
      const request = new AbortController();
      const original = new Error('original operation failed');
      const cleanup = new Error('host timer cleanup failed');
      let attempts = 0;
      let cleanupCalls = 0;
      const task = createSubmissionTask<number>({ signal: parent.signal, schedule: () => () => { cleanupCalls++; throw cleanup; } });
      let observed: unknown;
      try { await task.run(() => { attempts++; if (fail) throw original; return 42; }, { signal: request.signal }); }
      catch (error) { observed = error; }
      expect(observed).toBeInstanceOf(AggregateError);
      expect((observed as AggregateError).cause).toBe(fail ? original : cleanup);
      expect((observed as AggregateError).errors).toEqual(fail ? [original, cleanup] : [cleanup]);
      expect(cleanupCalls).toBe(1);
      expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
      expect(getEventListeners(request.signal, 'abort')).toHaveLength(0);
      expect(task.getSnapshot().pending).toBe(false);
      await expect(task.run(() => { attempts++; return 7; })).rejects.toMatchObject({ message: 'submission cleanup failed', cause: cleanup });
      expect(task.getSnapshot()).toMatchObject({ status: 'complete', value: 7 });
      expect(attempts).toBe(2);
      expect(cleanupCalls).toBe(2);
      expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
    }
  });

  it('keeps the operation error as cause when an error-state notification also fails', async () => {
    const original = new Error('operation failed');
    const notification = new Error('state consumer failed');
    const task = createSubmissionTask({ onState: (state) => { if (state.status === 'error') throw notification; } });
    let observed: unknown;
    try { await task.run(() => { throw original; }); } catch (error) { observed = error; }
    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).cause).toBe(original);
    expect((observed as AggregateError).errors).toEqual([original, notification]);
    await expect(task.run(() => 'next')).resolves.toBe('next');
  });

  it('does not leave an orphaned abort rejection when a host scheduler aborts and throws synchronously', async () => {
    const parent = new AbortController();
    const scheduling = new Error('scheduler failed after expiration');
    let attempts = 0;
    const task = createSubmissionTask({ signal: parent.signal, schedule: (expire) => { expire(); throw scheduling; } });
    await expect(task.run(() => { attempts++; return 1; })).rejects.toBe(scheduling);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(attempts).toBe(0);
    expect(task.getSnapshot().pending).toBe(false);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
  });
});
