import { getFormProps, getOptionProps, renderAttributes, type FieldControl, type HtmlAttributes } from './attributes.ts';
import { escapeHtml } from './html.ts';
import type { DefinedSchemaForm } from './schema-form.ts';
import { getSchemaFieldId, getSchemaFieldProps } from './schema-html.ts';
import { createFormState, renderErrorSummary, renderFieldErrors, type FormState } from './state.ts';
import { getActiveTransportRows, getPreparedFormTransport, resolveTransportField } from './transport.ts';

export { focusNativeErrorSummary } from './focus.ts';

export interface NativeChoice { readonly value: string; readonly label?: string; readonly disabled?: boolean }
export interface NativeFieldOptions {
  readonly label?: string;
  readonly hint?: string;
  readonly id?: string;
  readonly control?: FieldControl;
  readonly choices?: readonly NativeChoice[];
}
export interface NativeFieldsOptions {
  /** Explicit concrete names may include bounded collection rows; callers own row keys. */
  readonly names?: readonly string[];
  readonly fields?: Readonly<Record<string, NativeFieldOptions>>;
  /** Invalid fallback omits optional scalar values which were never submitted. */
  readonly mode?: 'initial' | 'invalid';
}
export interface NativeFormOptions extends NativeFieldsOptions {
  readonly state?: FormState;
  readonly requestKey?: string;
  readonly submitLabel?: string;
  readonly summaryTitle?: string;
  readonly summaryId?: string;
  readonly summaryAutofocus?: boolean;
}

function textarea(props: HtmlAttributes, value: string): string {
  const { type: _type, value: _value, checked: _checked, ...attributes } = props;
  // HTML removes exactly one LF immediately after the start tag.
  return `<textarea${renderAttributes(attributes)}>\n${escapeHtml(value)}</textarea>`;
}

/** Shared initial/422 field markup. Text, labels, hints, attributes, and choice labels are escaped. */
export function renderNativeField(
  form: DefinedSchemaForm, name: string, state: FormState = createFormState({}, []), options: NativeFieldOptions = {},
): string {
  const normalized = resolveTransportField(getPreparedFormTransport(form.fields, form.collections), name);
  const upload = Object.hasOwn(form.uploads, name);
  if (normalized === null && !upload) throw new TypeError(`unknown form field: ${name}`);
  const id = options.id ?? getSchemaFieldId(form, name, state);
  const label = options.label ?? name;
  const raw = state.rawValues[name];
  const hasErrors = (state.fieldErrors[name]?.length ?? 0) > 0;
  const describedBy = [options.hint === undefined ? undefined : `${id}-hint`, hasErrors ? `${id}-error` : undefined].filter(Boolean).join(' ') || undefined;
  const hint = options.hint === undefined ? '' : `<span id="${escapeHtml(id)}-hint">${escapeHtml(options.hint)}</span>`;
  const errors = renderFieldErrors(state, name, `${id}-error`);
  const wrap = (markup: string) => `<p><label for="${escapeHtml(id)}">${escapeHtml(label)}</label>${markup}${hint}${errors}</p>`;
  const group = (markup: string, empty = false) => `<fieldset${renderAttributes({ id: empty ? id : `${id}-group`, tabindex: empty ? -1 : undefined, 'aria-describedby': describedBy })}><legend>${escapeHtml(label)}</legend>${markup}${hint}${errors}</fieldset>`;

  if (upload) {
    if (options.choices !== undefined) throw new TypeError('file controls cannot have choices');
    return wrap(`<input${renderAttributes({ ...getSchemaFieldProps(form, name, { state, id, control: options.control, describedBy }), 'aria-describedby': describedBy })}>`);
  }
  const field = normalized!.declaration;
  const item = field.type === 'array' ? field.items : field;
  const control = options.control ?? field.control ?? (item.type === 'boolean' ? 'checkbox' : 'text');
  if (!['text', 'number', 'textarea', 'select', 'checkbox', 'radio'].includes(control)) throw new TypeError('unsupported field control');
  if (field.type !== 'array' && item.type === 'boolean' && !['checkbox', 'select'].includes(control)) throw new TypeError('scalar boolean controls require checkbox or an explicit falseValue select');
  if (field.type !== 'array' && item.type === 'boolean' && control === 'select' && item.falseValue === undefined) throw new TypeError('boolean select controls require an explicit falseValue');
  const props = (kind = control, controlId = id, optionValue?: string, fieldState = state): HtmlAttributes => Object.freeze({
    ...getSchemaFieldProps(form, name, { state: fieldState, control: kind, id: controlId, optionValue }), 'aria-describedby': describedBy,
  });
  const choices: NativeChoice[] = options.choices === undefined
    ? 'enum' in item && item.enum !== undefined ? [...new Set(item.enum.map(String))].map((value) => ({ value })) : []
    : options.choices.map((choice) => ({ ...choice }));
  const choiceValues = new Set<string>();
  for (const choice of choices) {
    if (typeof choice.value !== 'string' || choice.label !== undefined && typeof choice.label !== 'string') throw new TypeError('choice values and labels must be strings');
    if (choiceValues.has(choice.value)) throw new TypeError('choice values must be unique');
    choiceValues.add(choice.value);
  }

  if (field.type === 'array') {
    const values = typeof raw === 'string' ? [raw] : raw ?? [];
    const selected = new Set(values);
    const successfulChoices = choices.filter((choice) => !choice.disabled && selected.has(choice.value));
    // Native choice controls submit in document order and cannot repeat an equal value.
    const representable = values.length === selected.size && successfulChoices.length === values.length && successfulChoices.every((choice, index) => choice.value === values[index]);
    if (choices.length > 0 && representable && control === 'select') {
      const { value: _value, type: _type, checked: _checked, ...attributes } = props('select');
      return wrap(`<select${renderAttributes({ ...attributes, multiple: true })}>${choices.map((choice) => `<option${renderAttributes({ value: choice.value, selected: selected.has(choice.value), disabled: choice.disabled })}>${escapeHtml(choice.label ?? choice.value)}</option>`).join('')}</select>`);
    }
    if (choices.length > 0 && representable && control === 'checkbox') {
      const choiceState = { ...state, rawValues: {} };
      return group(choices.map((choice, index) => {
        const controlId = index === 0 ? id : `${id}-${index}`;
        return `<label for="${escapeHtml(controlId)}"><input${renderAttributes({ ...props('checkbox', controlId, choice.value, choiceState), checked: selected.has(choice.value), disabled: choice.disabled })}>${escapeHtml(choice.label ?? choice.value)}</label>`;
      }).join(''));
    }
    // Fall back to ordered controls whenever a choice set would discard/reorder submitted values.
    const visible = values.length === 0 && (field.required || (field.minItems ?? 0) > 0) ? [''] : values;
    return group(visible.map((value, index) => {
      const controlId = index === 0 ? id : `${id}-${index}`;
      const attributes = { ...props('text', controlId), value };
      const input = /[\r\n]/.test(value) ? textarea(attributes, value) : `<input${renderAttributes(attributes)}>`;
      return `<label for="${escapeHtml(controlId)}">${escapeHtml(label)} ${index + 1}</label>${input}`;
    }).join(''), visible.length === 0);
  }

  // A selected disabled option/radio is omitted by native submission. Preserve the rejected
  // scalar in an editable text control, as the repeated-field fallback already does.
  const selectedScalar = typeof raw === 'string' ? raw : item.type === 'boolean' ? item.falseValue : item.const === undefined ? undefined : String(item.const);
  if ((['select', 'radio'].includes(control) || item.type === 'boolean' && item.falseValue !== undefined) && choices.some((choice) => choice.disabled && choice.value === selectedScalar)) {
    const { checked: _checked, ...original } = props('text');
    const attributes = item.type === 'boolean' ? { ...original, type: 'text', value: selectedScalar, required: undefined } : original;
    return wrap(typeof selectedScalar === 'string' && /[\r\n]/.test(selectedScalar)
      ? textarea(attributes, selectedScalar) : `<input${renderAttributes(attributes)}>`);
  }

  if ('const' in item && item.const !== undefined && !choiceValues.has(String(item.const))) { choices.push({ value: String(item.const) }); choiceValues.add(String(item.const)); }
  if (typeof raw === 'string' && !choiceValues.has(raw)) { choices.push({ value: raw }); choiceValues.add(raw); }
  if (control === 'radio') {
    if (choices.length === 0) choices.push({ value: String('const' in item && item.const !== undefined ? item.const : 'on') });
    return group(choices.map((choice, index) => {
      const controlId = index === 0 ? id : `${id}-${index}`;
      return `<label for="${escapeHtml(controlId)}"><input${renderAttributes({ ...props('radio', controlId, choice.value), disabled: choice.disabled })}>${escapeHtml(choice.label ?? choice.value)}</label>`;
    }).join(''));
  }

  // A number input sanitizes malformed text to empty; preserve rejected wire text for correction.
  const attributes = props(control === 'number' && typeof raw === 'string' && !/^(0|-?[1-9][0-9]*)$/.test(raw) ? 'text' : control);
  const explicitFalse = item.type === 'boolean' && item.falseValue !== undefined;
  const unknownCheckbox = attributes.type === 'checkbox' && typeof raw === 'string' && raw !== attributes.value;
  if (control === 'select' || explicitFalse || unknownCheckbox) {
    if (item.type === 'boolean') {
      for (const value of [item.trueValue ?? 'on', item.falseValue]) if (value !== undefined && !choiceValues.has(value)) { choices.push({ value }); choiceValues.add(value); }
    }
    const selected = typeof raw === 'string' ? raw : item.type === 'boolean' ? item.falseValue : item.const === undefined ? undefined : String(item.const);
    const { value: _value, type: _type, checked: _checked, required: required, ...rest } = attributes;
    const select = { ...rest, required: item.type === 'boolean' ? undefined : required };
    const blank = choiceValues.has('') || item.type === 'boolean' ? '' : '<option value=""></option>';
    return wrap(`<select${renderAttributes(select)}>${blank}${choices.map((choice) => `<option${renderAttributes({ ...getOptionProps(choice.value, selected), disabled: choice.disabled })}>${escapeHtml(choice.label ?? choice.value)}</option>`).join('')}</select>`);
  }
  if (control === 'textarea' || typeof raw === 'string' && /[\r\n]/.test(raw)) return wrap(textarea(attributes, typeof raw === 'string' ? raw : String(attributes.value ?? '')));
  return wrap(`<input${renderAttributes(attributes)}>`);
}

/** Render only declared fields and activated collection rows; never invent an identity or row. */
export function renderNativeFields(form: DefinedSchemaForm, state: FormState, options: NativeFieldsOptions = {}): string {
  const transport = getPreparedFormTransport(form.fields, form.collections);
  const active = getActiveTransportRows(transport, Object.keys(state.rawValues));
  const indexes = Object.fromEntries(Object.entries(active).map(([name, values]) => [name, new Set(values)]));
  const names = options.names ?? [...transport.fields.filter(({ row, name, declaration }) =>
    (row === undefined || indexes[row.collection]!.has(row.index)) &&
    (options.mode !== 'invalid' || declaration.required || declaration.type === 'boolean' || declaration.type === 'array' || Object.hasOwn(state.rawValues, name) || (state.fieldErrors[name]?.length ?? 0) > 0),
  ).map(({ name }) => name), ...Object.keys(form.uploads)];
  if (new Set(names).size !== names.length) throw new TypeError('rendered field names must be unique');
  return names.map((name) => renderNativeField(form, name, state, options.fields !== undefined && Object.hasOwn(options.fields, name) ? options.fields[name] : undefined)).join('\n');
}

/** Host-owned native form fragment for both GET and invalid responses; no JavaScript is required. */
export function renderNativeForm(form: DefinedSchemaForm, csrfToken: string, options: NativeFormOptions = {}): string {
  const state = options.state ?? createFormState({}, []);
  const summary = renderNativeErrorSummary(state, { title: options.summaryTitle, id: options.summaryId, autofocus: options.summaryAutofocus, fieldId: (name) => options.fields?.[name]?.id ?? getSchemaFieldId(form, name, state) });
  return `${summary}<form${renderAttributes(getFormProps(form))}><input type="hidden" name="_bc_csrf" value="${escapeHtml(csrfToken)}">${options.requestKey === undefined ? '' : `<input type="hidden" name="_bc_request" value="${escapeHtml(options.requestKey)}">`}${renderNativeFields(form, state, options)}<button type="submit">${escapeHtml(options.submitLabel ?? 'Submit')}</button></form>`;
}

/** Focusable native summary; autofocus is opt-in and no submit handler is installed. */
export function renderNativeErrorSummary(state: FormState, options: Readonly<{ title?: string; id?: string; autofocus?: boolean; fieldId?: (name: string) => string }> = {}): string {
  if (state.issues.length === 0) return '';
  const id = options.id ?? 'typehtml-errors';
  const summary = renderErrorSummary(state, { title: options.title, id: `${id}-title`, fieldId: options.fieldId });
  return summary.replace('<section', `<section${renderAttributes({ id, tabindex: -1, autofocus: options.autofocus, 'data-typehtml-error-summary': true })}`);
}
