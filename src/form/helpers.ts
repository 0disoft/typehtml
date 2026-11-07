import { getFieldProps, getFormProps, type FieldPropsOptions, type HtmlAttributes } from './attributes.ts';
import type { DefinedForm } from './definition.ts';
import type { DefinedSchemaForm } from './schema-form.ts';
import { getSchemaFieldProps } from './schema-html.ts';

export type FormWithFields = DefinedForm | DefinedSchemaForm;

/** Transport names come from explicit fields, before any Standard Schema transforms. */
export type FormFieldName<Form extends FormWithFields> = Form extends DefinedSchemaForm
  ? Extract<keyof Form['fields'], string>
  : Form extends DefinedForm ? Extract<keyof Form['definition']['input']['properties'], string> : never;

export interface FormHelpers<Form extends FormWithFields> {
  readonly form: () => HtmlAttributes;
  readonly field: <Name extends FormFieldName<Form>>(name: Name, options?: FieldPropsOptions) => HtmlAttributes & Readonly<{ name: Name }>;
  readonly name: <Name extends FormFieldName<Form>>(name: Name) => Name;
}

/** Opt-in checked names for host-owned HTML/JSX; existing props helpers stay permissive. */
export function createFormHelpers<const Form extends FormWithFields>(form: Form): FormHelpers<Form> {
  const schemaForm = 'kind' in form;
  const names = schemaForm ? form.fields : form.input.schema.properties;
  const name = <Name extends FormFieldName<Form>>(value: Name): Name => {
    if (!Object.hasOwn(names, value)) throw new TypeError(`unknown form field: ${value}`);
    return value;
  };
  return Object.freeze({
    form: () => getFormProps(form), name,
    field: <Name extends FormFieldName<Form>>(value: Name, options: FieldPropsOptions = {}) => {
      name(value);
      const props = schemaForm ? getSchemaFieldProps(form, value, options) : getFieldProps(form, value, options);
      return props as HtmlAttributes & Readonly<{ name: Name }>;
    },
  });
}
