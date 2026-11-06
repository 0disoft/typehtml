import type { InputIssue } from '../runtime/input.ts';
import { getFieldProps, getOptionProps, renderAttributes, type FieldPropsOptions, type HtmlAttributes } from './attributes.ts';
import type { RawFormValues } from './boundary.ts';
import type { FormField } from './fields.ts';
import { escapeHtml } from './html.ts';
import type { DefinedSchemaForm } from './schema-form.ts';
import { createFormState, formFieldId, renderErrorSummary, renderFieldErrors, type FormStateOptions } from './state.ts';

/** Props use declared transport constraints, never vendor-schema introspection. */
export function getSchemaFieldProps(form: DefinedSchemaForm, name: string, options: FieldPropsOptions = {}): HtmlAttributes {
  if (!Object.hasOwn(form.fields, name)) throw new TypeError(`unknown form field: ${name}`);
  const field = form.fields[name]!;
  const item = field.type === 'array' ? field.items : field;
  const control = options.control ?? field.control ?? (item.type === 'boolean' ? 'checkbox' : field.type === 'array' ? 'select' : 'text');
  if (field.type === 'array' && control === 'text') {
    const id = options.id ?? formFieldId(name);
    const invalid = (options.state?.fieldErrors[name]?.length ?? 0) > 0;
    return Object.freeze({ id, name, type: 'text', 'aria-invalid': invalid ? 'true' : undefined,
      'aria-describedby': [options.describedBy, invalid ? `${formFieldId(name)}-error` : undefined].filter(Boolean).join(' ') || undefined });
  }
  if (item.type === 'boolean') {
    const raw = options.state?.rawValues[name];
    const id = options.id ?? formFieldId(name);
    const invalid = (options.state?.fieldErrors[name]?.length ?? 0) > 0;
    const describedBy = [options.describedBy, invalid ? `${id}-error` : undefined].filter(Boolean).join(' ');
    return Object.freeze({ id, name, type: 'checkbox', value: options.optionValue ?? item.trueValue ?? 'on',
      checked: Array.isArray(raw) ? raw.includes(options.optionValue ?? item.trueValue ?? 'on') : raw === (item.trueValue ?? 'on'),
      required: field.required === true && field.type !== 'array' || undefined,
      'aria-invalid': invalid ? 'true' : undefined, 'aria-describedby': describedBy || undefined });
  }
  const state = field.type === 'array' && options.state !== undefined && !['checkbox', 'radio'].includes(control)
    ? { ...options.state, rawValues: {} } : options.state;
  const optionValue = options.optionValue ?? (control === 'checkbox' || control === 'radio' ? String(item.const ?? item.enum?.[0] ?? 'on') : undefined);
  const props = getFieldProps({ type: 'object', additionalProperties: false, required: field.required ? [name] : [], properties: { [name]: item } }, name, { ...options, state, control, optionValue });
  return Object.freeze({ ...props, ...(field.type === 'array' && control === 'select' ? { multiple: true } : {}) });
}

function renderControl(form: DefinedSchemaForm, name: string, field: FormField, state: ReturnType<typeof createFormState>): string {
  const item = field.type === 'array' ? field.items : field;
  if (field.type === 'array') {
    const raw = state.rawValues[name];
    const values = typeof raw === 'string' ? [raw] : raw ?? [];
    const visible = values.length === 0 && (field.required || (field.minItems ?? 0) > 0) ? [''] : values;
    return visible.map((value, index) => `<input${renderAttributes({ ...getSchemaFieldProps(form, name, { state, control: 'text', id: index === 0 ? formFieldId(name) : `${formFieldId(name)}-${index}` }), value })}>`).join('');
  }
  if (item.type === 'boolean' && item.falseValue !== undefined) {
    const raw = state.rawValues[name];
    const selected = typeof raw === 'string' ? raw : item.falseValue;
    const { type: _, checked: __, value: ___, required: ____, ...props } = getSchemaFieldProps(form, name, { state });
    const values = [...new Set([item.trueValue ?? 'on', item.falseValue, selected])];
    return `<select${renderAttributes(props)}>${values.map((value) => `<option${renderAttributes(getOptionProps(value, selected))}>${escapeHtml(value)}</option>`).join('')}</select>`;
  }
  if (field.control === 'radio' && 'enum' in item && item.enum !== undefined) {
    return item.enum.map((value, index) => `<label><input${renderAttributes(getSchemaFieldProps(form, name, { state, control: 'radio', optionValue: String(value), id: index === 0 ? formFieldId(name) : `${formFieldId(name)}-${index}` }))}>${escapeHtml(String(value))}</label>`).join('');
  }
  const props = getSchemaFieldProps(form, name, { state });
  if (props.type === 'checkbox') return `<input${renderAttributes(props)}>`;
  const raw = state.rawValues[name];
  if (field.control === 'textarea') {
    const { value: _, ...attributes } = props;
    return `<textarea${renderAttributes(attributes)}>${escapeHtml(typeof raw === 'string' ? raw : '')}</textarea>`;
  }
  if (field.control === 'select') {
    const { value: _, ...attributes } = props;
    const values = 'enum' in item && item.enum !== undefined ? item.enum.map(String) : typeof raw === 'string' ? [raw] : raw ?? [];
    return `<select${renderAttributes(attributes)}><option value=""></option>${values.map((value) => `<option${renderAttributes(getOptionProps(value, raw))}>${escapeHtml(value)}</option>`).join('')}</select>`;
  }
  return `<input${renderAttributes(props)}>`;
}

export function renderSchemaFormErrors(
  form: DefinedSchemaForm, raw: RawFormValues, issues: readonly InputIssue[], csrfToken: string,
  options: FormStateOptions & Readonly<{ title?: string; summaryTitle?: string; submitLabel?: string }> = {},
  requestKey?: string,
): string {
  const state = createFormState(raw, issues, options);
  const title = options.title ?? 'Check your form';
  const controls = Object.entries(form.fields)
    .filter(([name, field]) => field.required || field.type === 'boolean' || field.type === 'array' || Object.hasOwn(raw, name) || (state.fieldErrors[name]?.length ?? 0) > 0)
    .map(([name, field]) => `<p><label for="${formFieldId(name)}">${escapeHtml(name)}</label>${renderControl(form, name, field, state)}${renderFieldErrors(state, name)}</p>`).join('\n');
  return `<!doctype html><html lang="${escapeHtml(state.locale)}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${renderErrorSummary(state, { title: options.summaryTitle })}<form id="${escapeHtml(form.id)}" method="post" action="${escapeHtml(form.path)}"><input type="hidden" name="_bc_csrf" value="${escapeHtml(csrfToken)}">${requestKey === undefined ? '' : `<input type="hidden" name="_bc_request" value="${escapeHtml(requestKey)}">`}${controls}<button type="submit">${escapeHtml(options.submitLabel ?? 'Submit')}</button></form></main></body></html>`;
}
