export type SubmissionStatus = 'idle' | 'submitting' | 'complete' | 'error' | 'cancelled';

export interface SubmissionState<T> {
  readonly status: SubmissionStatus;
  readonly pending: boolean;
  readonly sequence: number;
  readonly value?: T;
  readonly error?: unknown;
}

export interface SubmissionTaskOptions<T> {
  /** A task is attempted exactly once. Cancellation cannot undo a server-side write. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onState?: (state: SubmissionState<T>) => void;
  /** Returns a cleanup function; useful for host schedulers and deterministic tests. */
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
}

export interface SubmissionTask<T> {
  readonly run: (task: (context: Readonly<{ signal: AbortSignal }>) => T | PromiseLike<T>, options?: Readonly<{ signal?: AbortSignal }>) => Promise<T>;
  readonly cancel: (reason?: unknown) => void;
  readonly dispose: () => void;
  readonly getSnapshot: () => SubmissionState<T>;
}

export class SubmissionPendingError extends Error {
  constructor() { super('a submission is already pending'); this.name = 'SubmissionPendingError'; }
}

export function initialSubmissionState<T>(): SubmissionState<T> {
  return Object.freeze({ status: 'idle', pending: false, sequence: 0 });
}

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

/**
 * Coordinate a host-owned task, without intercepting forms, serializing bodies, or retrying I/O.
 * Host React/Svelte state remains authoritative; this utility has no subscription/reactivity API.
 */
export function createSubmissionTask<T>(options: SubmissionTaskOptions<T> = {}): SubmissionTask<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError('submission timeout must be an integer from 1 through 2147483647ms');
  }
  const parentSignal = options.signal;
  const onState = options.onState;
  const schedule = options.schedule ?? scheduleTimeout;
  let snapshot = initialSubmissionState<T>();
  let active: AbortController | undefined;
  let disposed = false;
  let sequence = 0;
  function publish(state: SubmissionState<T>): void {
    snapshot = Object.freeze(state);
    onState?.(snapshot);
  }
  function cancel(reason: unknown = new DOMException('submission cancelled', 'AbortError')): void {
    active?.abort(reason);
  }
  return Object.freeze({
    getSnapshot: () => snapshot,
    cancel,
    dispose() { disposed = true; cancel(new DOMException('submission disposed', 'AbortError')); },
    async run(task: (context: Readonly<{ signal: AbortSignal }>) => T | PromiseLike<T>, runOptions: Readonly<{ signal?: AbortSignal }> = {}) {
      if (disposed) throw new DOMException('submission disposed', 'InvalidStateError');
      if (active !== undefined) throw new SubmissionPendingError();
      if (typeof task !== 'function') throw new TypeError('submission task must be a function');
      const controller = new AbortController();
      const current = ++sequence;
      active = controller;
      const signal = controller.signal;
      const sources = [...new Set([parentSignal, runOptions.signal].filter((source): source is AbortSignal => source !== undefined))];
      const cleanups: (() => void)[] = [];
      let failed = false;
      let failure: unknown;
      try {
        for (const source of sources) {
          const abort = () => controller.abort(source.reason);
          source.addEventListener('abort', abort, { once: true });
          cleanups.push(() => source.removeEventListener('abort', abort));
          if (source.aborted) abort();
        }
        signal.throwIfAborted();
        publish({ status: 'submitting', pending: true, sequence: current });
        // A host scheduler may expire synchronously and then throw. Do not create an abort
        // rejection until scheduling succeeds; the listener below also observes prior aborts.
        cleanups.push(schedule(() => controller.abort(new DOMException('submission timed out', 'TimeoutError')), timeoutMs));
        const stopped = new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          cleanups.push(() => signal.removeEventListener('abort', abort));
          if (signal.aborted) abort();
        });
        const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return task({ signal }); });
        const value = await Promise.race([pending, stopped]);
        signal.throwIfAborted();
        if (active === controller) publish({ status: 'complete', pending: false, sequence: current, value });
        return value;
      } catch (error) {
        failed = true;
        failure = error;
        if (active === controller) {
          try { publish({ status: signal.aborted ? 'cancelled' : 'error', pending: false, sequence: current, error }); }
          catch (notification) {
            if (notification !== error) failure = new AggregateError([error, notification], 'submission and state notification failed', { cause: error });
          }
        }
        throw failure;
      } finally {
        const cleanupErrors: unknown[] = [];
        for (let index = cleanups.length - 1; index >= 0; index--) {
          try { cleanups[index]!(); } catch (error) { cleanupErrors.push(error); }
        }
        if (active === controller) active = undefined;
        if (cleanupErrors.length > 0) throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors,
          failed ? 'submission and cleanup failed' : 'submission cleanup failed', { cause: failed ? failure : cleanupErrors[0] });
      }
    },
  });
}
