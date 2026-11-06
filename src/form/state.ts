import type { InputIssue } from '../runtime/input.ts';
import { escapeHtml } from './html.ts';

export type FormRawValue = string | readonly string[];
export type FormMessages = Readonly<Record<string, string | ((issue: InputIssue) => string)>>;

export interface FormStateOptions {
  /** BCP 47 language used by a host renderer; no locale is guessed from request data. */
  readonly locale?: string;
  readonly messages?: FormMessages;
  readonly message?: (issue: InputIssue) => string;
}

export interface FormState {
  readonly locale: string;
  readonly rawValues: Readonly<Record<string, FormRawValue>>;
  readonly issues: readonly InputIssue[];
  readonly fieldErrors: Readonly<Record<string, readonly string[]>>;
  readonly formErrors: readonly string[];
}

/** Snapshot raw values and localized messages for a custom UI without mutating host state. */
export function createFormState(
  rawValues: Readonly<Record<string, FormRawValue>>, issues: readonly InputIssue[], options: FormStateOptions = {},
): FormState {
  const locale = options.locale ?? 'en';
  // Intl validation prevents invalid lang metadata; the original tag is retained for markup.
  if (Intl.getCanonicalLocales(locale).length !== 1) throw new TypeError('expected one form locale');
  const values: Record<string, FormRawValue> = Object.create(null);
  for (const [name, value] of Object.entries(rawValues)) {
    if (typeof value !== 'string' && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) {
      throw new TypeError('raw form values must be strings or string arrays');
    }
    values[name] = typeof value === 'string' ? value : Object.freeze([...value]);
  }
  const fieldErrors: Record<string, string[]> = Object.create(null);
  const formErrors: string[] = [];
  const translated = issues.map((issue) => {
    const template = options.messages !== undefined && Object.hasOwn(options.messages, issue.code) ? options.messages[issue.code] : undefined;
    const message = options.message?.(issue) ?? (typeof template === 'function' ? template(issue) : template) ?? issue.message;
    if (typeof message !== 'string') throw new TypeError('form messages must resolve to strings');
    if (issue.field === null) formErrors.push(message);
    else (fieldErrors[issue.field] ??= []).push(message);
    return Object.freeze({ field: issue.field, code: issue.code, message });
  });
  for (const errors of Object.values(fieldErrors)) Object.freeze(errors);
  return Object.freeze({
    locale, rawValues: Object.freeze(values), issues: Object.freeze(translated),
    fieldErrors: Object.freeze(fieldErrors), formErrors: Object.freeze(formErrors),
  });
}

/** Stable IDs contain no whitespace or CSS-significant field-name punctuation. */
export function formFieldId(name: string, prefix = 'field'): string {
  return `${prefix}-${Array.from(name, (character) => character.codePointAt(0)!.toString(16)).join('-')}`;
}

/** Escaped per-field text, ready to join to the aria-describedby ID from getFieldProps. */
export function renderFieldErrors(state: FormState, name: string, id = `${formFieldId(name)}-error`): string {
  const errors = Object.hasOwn(state.fieldErrors, name) ? state.fieldErrors[name]! : [];
  return errors.length === 0 ? '' : `<span id="${escapeHtml(id)}">${errors.map(escapeHtml).join(', ')}</span>`;
}

/** Escaped accessible summary for a host-owned form; no framework or reactive state is required. */
export function renderErrorSummary(state: FormState, options: Readonly<{ title?: string; id?: string; fieldId?: (name: string) => string }> = {}): string {
  if (state.issues.length === 0) return '';
  const id = options.id ?? 'form-errors';
  const items = state.issues.map((issue) => issue.field === null
    ? `<li>${escapeHtml(issue.message)}</li>`
    : `<li><a href="#${escapeHtml(options.fieldId?.(issue.field) ?? formFieldId(issue.field))}">${escapeHtml(issue.message)}</a></li>`).join('');
  return `<section role="alert" aria-labelledby="${escapeHtml(id)}"><h2 id="${escapeHtml(id)}">${escapeHtml(options.title ?? 'Fields to correct')}</h2><ul>${items}</ul></section>`;
}
