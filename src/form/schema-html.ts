import type { InputIssue } from '../runtime/input.ts';
import { getFieldProps, type FieldPropsOptions, type HtmlAttributes } from './attributes.ts';
import type { RawFormValues } from './boundary.ts';
import { escapeHtml } from './html.ts';
import type { DefinedSchemaForm } from './schema-form.ts';
import { getUploadFieldProps } from './upload-html.ts';
import { createFormState, formFieldId, type FormStateOptions } from './state.ts';
import { getPreparedFormTransport, resolveTransportField, type PreparedFormTransport } from './transport.ts';
import { collectionFieldId, collectionFieldName, COLLECTION_LIMITS } from './collections.ts';
import { renderNativeForm } from './native-render.ts';

const rowKeysByRaw = new WeakMap<RawFormValues, WeakMap<PreparedFormTransport, Readonly<Record<string, string>>>>();
function stableRowKeys(transport: PreparedFormTransport, raw: RawFormValues): Readonly<Record<string, string>> {
  const cached = rowKeysByRaw.get(raw)?.get(transport);
  if (cached !== undefined) return cached;
  const counts = new Map<string, number>();
  const candidates: { name: string; key: string; identity: string }[] = [];
  for (const field of transport.fields) {
    const row = field.row;
    if (row === undefined || row.member !== transport.collections[row.collection]!.rowKey) continue;
    const key = raw[field.name];
    if (typeof key !== 'string' || Array.from(key).length < 1 || Array.from(key).length > COLLECTION_LIMITS.maxRowKeyLength) continue;
    const identity = JSON.stringify([row.collection, key]);
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
    candidates.push({ name: field.name, key, identity });
  }
  const result: Record<string, string> = Object.create(null);
  for (const { name, key, identity } of candidates) if (counts.get(identity) === 1) result[name] = key;
  Object.freeze(result);
  if (Object.isFrozen(raw)) {
    let byTransport = rowKeysByRaw.get(raw);
    if (byTransport === undefined) { byTransport = new WeakMap(); rowKeysByRaw.set(raw, byTransport); }
    byTransport.set(transport, result);
  }
  return result;
}

/** Submitted stable keys keep labels/error links attached to the same row after reorder. */
export function getSchemaFieldId(form: DefinedSchemaForm, name: string, state?: FieldPropsOptions['state']): string {
  const transport = getPreparedFormTransport(form.fields, form.collections);
  const row = resolveTransportField(transport, name)?.row;
  if (row !== undefined) {
    const group = transport.collections[row.collection]!;
    const key = state === undefined ? undefined : stableRowKeys(transport, state.rawValues)[collectionFieldName(row.collection, row.index, group.rowKey)];
    if (key !== undefined) return collectionFieldId(row.collection, key, row.member);
  }
  return formFieldId(name);
}

/** Props use declared transport constraints, never vendor-schema introspection. */
export function getSchemaFieldProps(form: DefinedSchemaForm, name: string, options: FieldPropsOptions = {}): HtmlAttributes {
  if (Object.hasOwn(form.uploads, name)) return getUploadFieldProps(form, name, options);
  const normalized = resolveTransportField(getPreparedFormTransport(form.fields, form.collections), name);
  if (normalized === null) throw new TypeError(`unknown form field: ${name}`);
  const field = normalized.declaration;
  const id = options.id ?? getSchemaFieldId(form, name, options.state);
  const item = field.type === 'array' ? field.items : field;
  const control = options.control ?? field.control ?? (item.type === 'boolean' ? 'checkbox' : field.type === 'array' ? 'select' : 'text');
  if (field.type === 'array' && control === 'text') {
    const invalid = (options.state?.fieldErrors[name]?.length ?? 0) > 0;
    return Object.freeze({ id, name, type: 'text', 'aria-invalid': invalid ? 'true' : undefined,
      'aria-describedby': [options.describedBy, invalid ? `${id}-error` : undefined].filter(Boolean).join(' ') || undefined });
  }
  if (item.type === 'boolean') {
    const raw = options.state?.rawValues[name];
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
  const props = getFieldProps({ type: 'object', additionalProperties: false, required: field.required ? [name] : [], properties: { [name]: item } }, name, { ...options, id, state, control, optionValue });
  return Object.freeze({ ...props, ...(field.type === 'array' && control === 'select' ? { multiple: true } : {}) });
}

export function renderSchemaFormErrors(
  form: DefinedSchemaForm, raw: RawFormValues, issues: readonly InputIssue[], csrfToken: string,
  options: FormStateOptions & Readonly<{ title?: string; summaryTitle?: string; submitLabel?: string }> = {},
  requestKey?: string,
): string {
  const state = createFormState(raw, issues, options);
  const title = options.title ?? 'Check your form';
  const markup = renderNativeForm(form, csrfToken, { state, mode: 'invalid', requestKey,
    summaryTitle: options.summaryTitle, submitLabel: options.submitLabel,
  });
  return `<!doctype html><html lang="${escapeHtml(state.locale)}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${markup}</main></body></html>`;
}
