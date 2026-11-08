import type { InputIssue } from '../runtime/input.ts';
import { getFieldProps, getOptionProps, renderAttributes, type FieldPropsOptions, type HtmlAttributes } from './attributes.ts';
import type { RawFormValues } from './boundary.ts';
import type { FormField } from './fields.ts';
import { escapeHtml } from './html.ts';
import type { DefinedSchemaForm } from './schema-form.ts';
import { createFormState, formFieldId, renderErrorSummary, renderFieldErrors, type FormStateOptions } from './state.ts';
import { getPreparedFormTransport, resolveTransportField } from './transport.ts';

/** Props use declared transport constraints, never vendor-schema introspection. */
export function getSchemaFieldProps(form: DefinedSchemaForm, name: string, options: FieldPropsOptions = {}): HtmlAttributes {
  const normalized = resolveTransportField(getPreparedFormTransport(form.fields), name);
  if (normalized === null) throw new TypeError(`unknown form field: ${name}`);
  const field = normalized.declaration;
  const item = field.type === 'array' ? field.items : field;
  const control = options.control ?? field.control ?? (item.type === 'boolean' ? 'checkbox' : field.type === 'array' ? 'select' : 'text');
  if (field.type === 'array' && control === 'text') {
    const id = options.id ?? formFieldId(name);
    const invalid = (options.state?.fieldErrors[name]?.length ?? 0) > 0;
    return Object.freeze({ id, name, type: 'text', 'aria-invalid': invalid ? 'true' : undefined,
      'aria-describedby': [options.describedBy, invalid ? `${id}-error` : undefined].filter(Boolean).join(' ') || undefined });
  }
  if (item.type === 'boolean') {
    const raw = options.state?.rawValues[name];
    const id = options.id ?? formFieldId(name);
    const invalid = (options.state?.fieldErrors[name]?.length ?? 0) > 0;
    const describedBy = [options.describedBy, invalid ? `${id}-error` : undefined].filter(Boolean).join(' ');
    const value = options.optionValue ?? item.trueValue ?? 'on';
    return Object.freeze({ id, name, type: 'checkbox', value,
      checked: Array.isArray(raw) ? raw.includes(value) : raw === value,
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
    return visible.map((value, index) => {
      const props = getSchemaFieldProps(form, name, { state, control: 'text', id: index === 0 ? formFieldId(name) : `${formFieldId(name)}-${index}` });
      // Native text inputs sanitize newlines; textarea preserves multiline raw values.
      if (/[\r\n]/.test(value)) {
        const { type: _, ...attributes } = props;
        return `<textarea${renderAttributes(attributes)}>\n${escapeHtml(value)}</textarea>`;
      }
      return `<input${renderAttributes({ ...props, value })}>`;
    }).join('');
  }
  const raw = state.rawValues[name];
  if (item.type === 'boolean' && (item.falseValue !== undefined || typeof raw === 'string' && raw !== (item.trueValue ?? 'on'))) {
    const selected = typeof raw === 'string' ? raw : item.falseValue!;
    const { type: _, checked: __, value: ___, required: ____, ...props } = getSchemaFieldProps(form, name, { state });
    const values = [...new Set([item.trueValue ?? 'on', ...(item.falseValue === undefined ? [] : [item.falseValue]), selected])];
    return `<select${renderAttributes(props)}>${values.map((value) => `<option${renderAttributes(getOptionProps(value, selected))}>${escapeHtml(value)}</option>`).join('')}</select>`;
  }
  if (field.control === 'radio') {
    const values = 'enum' in item && item.enum !== undefined ? item.enum.map(String)
      : [String('const' in item && item.const !== undefined ? item.const : raw ?? 'on')];
    if (typeof raw === 'string' && !values.includes(raw)) values.push(raw);
    return values.map((value, index) => `<label><input${renderAttributes(getSchemaFieldProps(form, name, { state, control: 'radio', optionValue: value, id: index === 0 ? formFieldId(name) : `${formFieldId(name)}-${index}` }))}>${escapeHtml(value)}</label>`).join('');
  }
  const props = getSchemaFieldProps(form, name, { state });
  if (props.type === 'checkbox' && !(typeof raw === 'string' && raw !== props.value)) return `<input${renderAttributes(props)}>`;
  if (field.control === 'textarea' || typeof raw === 'string' && /[\r\n]/.test(raw)) {
    const { value: _, type: __, ...attributes } = props;
    // HTML strips one leading LF immediately after a textarea start tag.
    return `<textarea${renderAttributes(attributes)}>\n${escapeHtml(typeof raw === 'string' ? raw : '')}</textarea>`;
  }
  if (field.control === 'select' || props.type === 'checkbox') {
    const { value: _, type: __, checked: ___, ...attributes } = props;
    const values = 'enum' in item && item.enum !== undefined ? item.enum.map(String) : typeof raw === 'string' ? [raw] : [...raw ?? []];
    if (typeof raw === 'string' && !values.includes(raw)) values.push(raw);
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
  const controls = getPreparedFormTransport(form.fields).fields
    .filter(({ name, declaration }) => declaration.required || declaration.type === 'boolean' || declaration.type === 'array' || Object.hasOwn(raw, name) || (state.fieldErrors[name]?.length ?? 0) > 0)
    .map(({ name, declaration }) => `<p><label for="${formFieldId(name)}">${escapeHtml(name)}</label>${renderControl(form, name, declaration, state)}${renderFieldErrors(state, name)}</p>`).join('\n');
  return `<!doctype html><html lang="${escapeHtml(state.locale)}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${renderErrorSummary(state, { title: options.summaryTitle })}<form id="${escapeHtml(form.id)}" method="post" action="${escapeHtml(form.path)}"><input type="hidden" name="_bc_csrf" value="${escapeHtml(csrfToken)}">${requestKey === undefined ? '' : `<input type="hidden" name="_bc_request" value="${escapeHtml(requestKey)}">`}${controls}<button type="submit">${escapeHtml(options.submitLabel ?? 'Submit')}</button></form></main></body></html>`;
}
