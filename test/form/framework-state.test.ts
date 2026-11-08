import { describe, expect, it } from 'bun:test';
import { createReactSubmissionHook, toReactFieldProps, type ReactStateHooks } from '../../src/integrations/react.ts';
import { connectSvelteSubmission, type HostWritableFactory } from '../../src/integrations/svelte.ts';
import type { SubmissionState } from '../../src/form/submission.ts';

/** Minimal host hooks exercise the public injection contract, effects, and Strict Mode remounts. */
function reactHost() {
  const cells: unknown[] = [];
  const effects = new Map<number, { effect: () => void | (() => void); dependencies: readonly unknown[]; cleanup?: () => void }>();
  const pending = new Set<number>();
  let cursor = 0;
  let updates = 0;
  const hooks: ReactStateHooks = {
    useState<T>(initial: () => T): [T, (value: T) => void] {
      const index = cursor++;
      if (!(index in cells)) cells[index] = initial();
      return [cells[index] as T, (value) => { cells[index] = value; updates++; }];
    },
    useRef<T>(initial: T): { current: T } {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index] as { current: T };
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = effects.get(index);
      if (previous !== undefined && dependencies.length === previous.dependencies.length && dependencies.every((value, position) => Object.is(value, previous.dependencies[position]))) return;
      effects.set(index, { effect, dependencies, cleanup: previous?.cleanup });
      pending.add(index);
    },
  };
  return {
    hooks, updates: () => updates,
    render<T>(render: () => T): T { cursor = 0; return render(); },
    flush() { for (const index of pending) { const effect = effects.get(index)!; effect.cleanup?.(); effect.cleanup = effect.effect() || undefined; } pending.clear(); },
    strictReplay() { for (const effect of effects.values()) { effect.cleanup?.(); effect.cleanup = effect.effect() || undefined; } },
    unmount() { for (const effect of effects.values()) effect.cleanup?.(); effects.clear(); },
  };
}

describe('optional host framework connections', () => {
  it('uses React state and handles Strict Mode cleanup/remount without retaining a disposed controller', async () => {
    const host = reactHost();
    const useSubmission = createReactSubmissionHook(host.hooks);
    let view = host.render(() => useSubmission<number>());
    await expect(view.run(() => 1)).rejects.toMatchObject({ name: 'InvalidStateError' });
    host.flush(); host.strictReplay();
    let finish!: (value: number) => void;
    const running = view.run(() => new Promise<number>((resolve) => { finish = resolve; }));
    view = host.render(() => useSubmission<number>());
    expect(view.state.status).toBe('submitting');
    await Promise.resolve();
    finish(42);
    await expect(running).resolves.toBe(42);
    view = host.render(() => useSubmission<number>());
    expect(view.state).toMatchObject({ status: 'complete', value: 42 });
    host.unmount();
    await expect(view.run(() => 2)).rejects.toMatchObject({ name: 'InvalidStateError' });
  });

  it('aborts on React unmount and ignores late notifications from a prior effect configuration', async () => {
    const host = reactHost();
    const useSubmission = createReactSubmissionHook(host.hooks);
    const parent = new AbortController();
    let view = host.render(() => useSubmission<string>({ signal: parent.signal }));
    host.flush();
    const old = view.run(() => new Promise<string>(() => {}));
    await Promise.resolve();
    view = host.render(() => useSubmission<string>({ timeoutMs: 1_000 }));
    host.flush();
    await expect(old).rejects.toMatchObject({ name: 'AbortError' });
    view = host.render(() => useSubmission<string>({ timeoutMs: 1_000 }));
    expect(view.state.status).toBe('idle');
    await expect(view.run(() => 'new configuration')).resolves.toBe('new configuration');
    const pending = view.run(() => new Promise<string>(() => {}));
    await Promise.resolve();
    host.unmount();
    const updates = host.updates();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.updates()).toBe(updates);
  });

  it('connects through the host Svelte writable protocol and releases the host subscription', async () => {
    let factories = 0;
    let subscribers = 0;
    const writable: HostWritableFactory = <T>(initial: T) => {
      factories++;
      let value = initial;
      const listeners = new Set<(next: T) => void>();
      return {
        subscribe(listener: (next: T) => void) { listeners.add(listener); subscribers++; listener(value); return () => { if (listeners.delete(listener)) subscribers--; }; },
        set(next: T) { value = next; for (const listener of listeners) listener(value); },
      };
    };
    const connection = connectSvelteSubmission<string>(writable);
    const states: SubmissionState<string>[] = [];
    const unsubscribe = connection.state.subscribe((state) => states.push(state));
    await expect(connection.run(() => 'saved')).resolves.toBe('saved');
    expect(states.map(({ status }) => status)).toEqual(['idle', 'submitting', 'complete']);
    const pending = connection.run(() => new Promise<string>(() => {}));
    connection.dispose();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(states.at(-1)?.status).toBe('cancelled');
    unsubscribe(); unsubscribe();
    expect(subscribers).toBe(0);
    expect(factories).toBe(1);
    expect('set' in connection.state).toBe(false);
  });

  it('maps native attributes to editable React defaults without mutating the input or accepting handlers', () => {
    const attributes = Object.freeze({ class: 'field', inputmode: 'numeric', maxlength: 10, value: '<name>', checked: false, 'aria-invalid': 'true' });
    const props = toReactFieldProps(attributes);
    expect(props).toEqual({ className: 'field', inputMode: 'numeric', maxLength: 10, defaultValue: '<name>', defaultChecked: false, 'aria-invalid': 'true' });
    expect(attributes.value).toBe('<name>');
    expect(Object.isFrozen(props)).toBe(true);
    expect(toReactFieldProps(attributes, { controlled: true })).toMatchObject({ value: '<name>', checked: false });
    expect(toReactFieldProps({ 'accept-charset': 'UTF-8', enctype: 'multipart/form-data', for: 'name' })).toEqual({ acceptCharset: 'UTF-8', encType: 'multipart/form-data', htmlFor: 'name' });
    expect(() => toReactFieldProps({ onChange: 'bad' })).toThrow('unsafe HTML attribute');
  });
});
