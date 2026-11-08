import { createSubmissionTask, initialSubmissionState, type SubmissionState, type SubmissionTask, type SubmissionTaskOptions } from '../form/submission.ts';

export interface HostWritable<T> {
  subscribe(run: (value: T) => void): () => void;
  set(value: T): void;
}
export type HostWritableFactory = <T>(initial: T) => HostWritable<T>;

/** Uses the host's existing svelte/store writable; dispose from onDestroy. No action protocol is assumed. */
export function connectSvelteSubmission<T>(
  writable: HostWritableFactory, options: Omit<SubmissionTaskOptions<T>, 'onState'> = {},
): Pick<SubmissionTask<T>, 'run' | 'cancel' | 'dispose'> & Readonly<{ state: Pick<HostWritable<SubmissionState<T>>, 'subscribe'> }> {
  const state = writable(initialSubmissionState<T>());
  const task = createSubmissionTask<T>({ ...options, onState: (next) => state.set(next) });
  return Object.freeze({
    state: Object.freeze({ subscribe: (run: (value: SubmissionState<T>) => void) => state.subscribe(run) }),
    run: task.run, cancel: task.cancel, dispose: task.dispose,
  });
}
