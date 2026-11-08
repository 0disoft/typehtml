import { getFieldProps, getFormProps, type FieldPropsOptions, type HtmlAttributes } from './attributes.ts';
import type { DefinedForm } from './definition.ts';
import type { DefinedSchemaForm } from './schema-form.ts';
import { getSchemaFieldProps } from './schema-html.ts';
import { collectionFieldId, collectionFieldName } from './collections.ts';
import { getPreparedFormTransport } from './transport.ts';

export type FormWithFields = DefinedForm | DefinedSchemaForm;

type FieldDeclarations<Form extends FormWithFields> = Form extends DefinedSchemaForm
  ? Form['fields'] : Form extends DefinedForm ? Form['definition']['input']['properties'] : never;

/** Wire names precede transforms; an unnarrowed union permits only names shared by every form. */
export type FormFieldName<Form extends FormWithFields> = [Form] extends [never] ? never : Extract<keyof FieldDeclarations<Form>, string>;
type CollectionDeclarations<Form extends FormWithFields> = Form extends DefinedSchemaForm ? Form['collections'] : Readonly<Record<never, never>>;
export type FormCollectionName<Form extends FormWithFields> = [Form] extends [never] ? never : Extract<keyof CollectionDeclarations<Form>, string>;
type CollectionMember<Form extends FormWithFields, Name extends FormCollectionName<Form>> = CollectionDeclarations<Form>[Name] extends { fields: infer Fields } ? Extract<keyof Fields, string> : never;
export interface CollectionRowHelpers<Name extends string, Member extends string> {
  readonly key: string;
  readonly index: number;
  readonly name: <Field extends Member>(member: Field) => `${Name}[${number}].${Field}`;
  readonly field: <Field extends Member>(member: Field, options?: FieldPropsOptions) => HtmlAttributes & Readonly<{ name: `${Name}[${number}].${Field}` }>;
  readonly rowKey: () => HtmlAttributes;
}

export interface FormHelpers<Form extends FormWithFields> {
  readonly form: () => HtmlAttributes;
  readonly field: <Name extends FormFieldName<Form>>(name: Name, options?: FieldPropsOptions) => HtmlAttributes & Readonly<{ name: Name }>;
  readonly name: <Name extends FormFieldName<Form>>(name: Name) => Name;
  readonly row: <Name extends FormCollectionName<Form>>(collection: Name, index: number, key: string) => CollectionRowHelpers<Name, CollectionMember<Form, Name>>;
}

/** Opt-in checked names for host-owned HTML/JSX; existing props helpers stay permissive. */
export function createFormHelpers<const Form extends FormWithFields>(form: Form): FormHelpers<Form> {
  const schemaForm = 'kind' in form;
  const names = schemaForm ? form.fields : form.input.schema.properties;
  const name = <Name extends FormFieldName<Form>>(value: Name): Name => {
    if (!Object.hasOwn(names, value)) throw new TypeError(`unknown form field: ${value}`);
    return value;
  };
  const row = <Name extends FormCollectionName<Form>>(collection: Name, index: number, key: string): CollectionRowHelpers<Name, CollectionMember<Form, Name>> => {
    if (!schemaForm) throw new TypeError('collections require a schema form');
    const transport = getPreparedFormTransport(form.fields, form.collections);
    const group = Object.hasOwn(transport.collections, collection) ? transport.collections[collection] : undefined;
    if (group === undefined) throw new TypeError(`unknown form collection: ${collection}`);
    if (!Number.isSafeInteger(index) || index < 0 || index >= group.maxItems) throw new RangeError('invalid collection row index');
    collectionFieldId(collection, key, group.rowKey);
    const memberName = <Member extends CollectionMember<Form, Name>>(member: Member): `${Name}[${number}].${Member}` => {
      if (!Object.hasOwn(group.fields, member)) throw new TypeError(`unknown collection member: ${member}`);
      return collectionFieldName(collection, index, member) as `${Name}[${number}].${Member}`;
    };
    return Object.freeze({ key, index, name: memberName,
      field: <Member extends CollectionMember<Form, Name>>(member: Member, options: FieldPropsOptions = {}) => Object.freeze({
        ...getSchemaFieldProps(form, memberName(member), { ...options, id: options.id ?? collectionFieldId(collection, key, member) }),
        name: memberName(member),
      }),
      rowKey: () => Object.freeze({ type: 'hidden', name: collectionFieldName(collection, index, group.rowKey), value: key, id: collectionFieldId(collection, key, group.rowKey) }),
    });
  };
  return Object.freeze({
    form: () => getFormProps(form), name, row,
    field: <Name extends FormFieldName<Form>>(value: Name, options: FieldPropsOptions = {}) => {
      name(value);
      const props = schemaForm ? getSchemaFieldProps(form, value, options) : getFieldProps(form, value, options);
      return props as HtmlAttributes & Readonly<{ name: Name }>;
    },
  });
}
