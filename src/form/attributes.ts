import type { ObjectSchema } from '../contract/types.ts';
import type { DefinedForm } from './definition.ts';
import { escapeHtml } from './html.ts';
import { formFieldId, type FormState } from './state.ts';

export type HtmlAttributes = Readonly<Record<string, string | number | boolean | undefined>>;
export type FieldControl = 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'file';
export interface FieldPropsOptions {
  readonly state?: FormState;
  readonly id?: string;
  readonly control?: FieldControl;
  /** A checkbox/radio's submitted value, rather than its checked state. */
  readonly optionValue?: string;
  readonly describedBy?: string;
}

export function getFormProps(form: Pick<DefinedForm, 'id' | 'path'> & Readonly<{ multipart?: unknown }>): HtmlAttributes {
  return Object.freeze({ id: form.id, action: form.path, method: 'post', enctype: form.multipart === undefined ? 'application/x-www-form-urlencoded' : 'multipart/form-data' });
}

/**
 * Native attributes for the statically analyzable profile. Server validation remains authoritative.
 * Length attributes are conservative: server lengths count code points, browsers count UTF-16.
 * The generated length pattern narrows that gap for nonempty browser-validated text controls.
 * Integer text controls preserve canonical decimal syntax; opt-in number controls also expose bounds.
 */
export function getFieldProps(
  formOrSchema: DefinedForm | ObjectSchema, name: string, options: FieldPropsOptions = {},
): HtmlAttributes {
  const schema = 'input' in formOrSchema ? formOrSchema.input.schema : formOrSchema;
  if (!Object.hasOwn(schema.properties, name)) throw new TypeError(`unknown form field: ${name}`);
  const field = schema.properties[name]!;
  const control = options.control ?? 'text';
  if (!['text', 'number', 'textarea', 'select', 'checkbox', 'radio'].includes(control)) throw new TypeError('unsupported field control');
  if (control === 'number' && field.type !== 'integer') throw new TypeError('number controls require an integer field');
  const id = options.id ?? formFieldId(name);
  const raw = options.state !== undefined && Object.hasOwn(options.state.rawValues, name) ? options.state.rawValues[name] : undefined;
  const errors = options.state !== undefined && Object.hasOwn(options.state.fieldErrors, name) ? options.state.fieldErrors[name]! : [];
  const props: Record<string, string | number | boolean | undefined> = { id, name };
  if (!['textarea', 'select'].includes(control)) props.type = control;
  const nonempty = field.type === 'integer' || (field.minLength ?? 0) > 0;
  // HTML required means nonempty/checked, while the contract's required means key presence.
  // A radio group's required check tests selection, so an empty-valued selected option is valid.
  if (schema.required.includes(name) && (control === 'radio' || nonempty && control !== 'checkbox')) props.required = true;
  if (control === 'checkbox' || control === 'radio') {
    if (options.optionValue === undefined) throw new TypeError('checkbox/radio props require an explicit optionValue');
    props.value = options.optionValue;
    props.checked = Array.isArray(raw) ? raw.includes(options.optionValue) : raw === options.optionValue;
  } else if (raw !== undefined) {
    if (typeof raw !== 'string') throw new TypeError('scalar field state must contain one string');
    props.value = raw;
  } else if (field.const !== undefined) props.value = String(field.const);
  if (field.type === 'integer' && control === 'text') {
    props.inputmode = 'numeric';
    props.pattern = '(0|-?[1-9][0-9]*)';
    if (field.minimum !== undefined) props['data-typehtml-min'] = field.minimum;
    if (field.maximum !== undefined) props['data-typehtml-max'] = field.maximum;
  } else if (field.type === 'integer' && control === 'number') {
    props.step = 1;
    props.min = field.minimum;
    props.max = field.maximum;
  } else if (field.type === 'string' && ['text', 'textarea'].includes(control)) {
    props.minlength = field.minLength;
    if (field.maxLength !== undefined && field.maxLength <= Number.MAX_SAFE_INTEGER / 2) props.maxlength = field.maxLength * 2;
    if (field.minLength !== undefined || field.maxLength !== undefined) props['data-typehtml-length'] = 'unicode-code-points';
    // Textarea has no native pattern attribute; conservative length hints still apply.
    if (control === 'text') {
      const length = field.minLength !== undefined || field.maxLength !== undefined
        ? `(?:[\\s\\S]){${field.minLength ?? 0},${field.maxLength ?? ''}}` : undefined;
      // The contract profile's allowlisted expression needs escaped '-' in HTML's v syntax.
      const pattern = field.pattern === '^draft_[A-Za-z0-9_-]{1,58}$' ? 'draft_[A-Za-z0-9_\\-]{1,58}' : undefined;
      props.pattern = pattern !== undefined && length !== undefined ? `(?=${length}$)(?:${pattern})`
        : pattern ?? length;
    }
  }
  if (errors.length > 0) props['aria-invalid'] = 'true';
  const describedBy = [options.describedBy, errors.length > 0 ? `${id}-error` : undefined].filter(Boolean).join(' ');
  if (describedBy !== '') props['aria-describedby'] = describedBy;
  return Object.freeze(props);
}

/** Option selection for a host-owned select, including repeated-value state. */
export function getOptionProps(value: string, selected: string | readonly string[] | undefined): HtmlAttributes {
  return Object.freeze({ value, selected: Array.isArray(selected) ? selected.includes(value) : selected === value });
}

/** Serialize attribute objects for native HTML. Values remain plain strings in the props APIs. */
export function renderAttributes(attributes: HtmlAttributes): string {
  return Object.entries(attributes).map(([name, value]) => {
    if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(name) || /^on/i.test(name)) throw new TypeError(`unsafe HTML attribute: ${name}`);
    if (value === undefined || value === false) return '';
    return value === true ? ` ${name}` : ` ${name}="${escapeHtml(String(value))}"`;
  }).join('');
}
