import { createSubmissionTask, initialSubmissionState, type SubmissionState, type SubmissionTask, type SubmissionTaskOptions } from '../form/submission.ts';
import type { HtmlAttributes } from '../form/attributes.ts';

export { focusNativeErrorSummary } from '../form/focus.ts';

/** Pass the application's existing React hooks; React is never imported or bundled by TypeHTML. */
export interface ReactStateHooks {
  useState<T>(initial: () => T): [T, (value: T) => void];
  useRef<T>(initial: T): { current: T };
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void;
}

export type ReactSubmissionOptions<T> = Omit<SubmissionTaskOptions<T>, 'onState'>;
export type ReactSubmission<T> = Pick<SubmissionTask<T>, 'run' | 'cancel'> & Readonly<{ state: SubmissionState<T> }>;

/** A hook backed by useState/useEffect, including Strict Mode effect cleanup/remount handling. */
export function createReactSubmissionHook(hooks: ReactStateHooks) {
  return function useTypeHtmlSubmission<T>(options: ReactSubmissionOptions<T> = {}): ReactSubmission<T> {
    const [state, setState] = hooks.useState(initialSubmissionState<T>);
    const controller = hooks.useRef<SubmissionTask<T> | null>(null);
    hooks.useEffect(() => {
      const current = createSubmissionTask<T>({ ...options, onState: (next) => { if (controller.current === current) setState(next); } });
      controller.current = current;
      setState(current.getSnapshot());
      return () => {
        if (controller.current === current) controller.current = null;
        current.dispose();
      };
    }, [options.timeoutMs, options.signal, options.schedule]);
    return {
      state,
      run: (task, runOptions) => controller.current === null
        ? Promise.reject(new DOMException('submission hook is not mounted', 'InvalidStateError'))
        : controller.current.run(task, runOptions),
      cancel: (reason) => controller.current?.cancel(reason),
    };
  };
}

const REACT_ATTRIBUTE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  class: 'className', for: 'htmlFor', acceptcharset: 'acceptCharset', 'accept-charset': 'acceptCharset',
  enctype: 'encType', inputmode: 'inputMode', minlength: 'minLength', maxlength: 'maxLength',
  readonly: 'readOnly', autocomplete: 'autoComplete', autofocus: 'autoFocus', tabindex: 'tabIndex',
  formnovalidate: 'formNoValidate', novalidate: 'noValidate', formaction: 'formAction',
  formmethod: 'formMethod', formenctype: 'formEncType', formtarget: 'formTarget',
});

/** Plain React props. Uncontrolled defaults avoid read-only inputs without an onChange handler. */
export function toReactFieldProps(attributes: HtmlAttributes, options: Readonly<{ controlled?: boolean }> = {}): HtmlAttributes {
  const result: Record<string, string | number | boolean | undefined> = Object.create(null);
  for (const [name, value] of Object.entries(attributes)) {
    if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(name) || /^on/i.test(name)) throw new TypeError(`unsafe HTML attribute: ${name}`);
    const mapped = !options.controlled && name === 'value' ? 'defaultValue'
      : !options.controlled && name === 'checked' ? 'defaultChecked' : REACT_ATTRIBUTE_NAMES[name.toLowerCase()] ?? name;
    result[mapped] = value;
  }
  return Object.freeze(result);
}
