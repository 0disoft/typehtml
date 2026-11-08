import type { DefinedSchemaForm } from './schema-form.ts';
import type { FieldPropsOptions, HtmlAttributes } from './attributes.ts';
import { formFieldId } from './state.ts';

/** File values are never redisplayed. The browser must ask the user to select them again. */
export function getUploadFieldProps(form: DefinedSchemaForm, name: string, options: FieldPropsOptions = {}): HtmlAttributes {
  if (!Object.hasOwn(form.uploads, name)) throw new TypeError(`unknown upload field: ${name}`);
  if (options.control !== undefined && options.control !== 'file') throw new TypeError('uploads require file controls');
  const field = form.uploads[name]!;
  const id = options.id ?? formFieldId(name);
  const invalid = (options.state?.fieldErrors[name]?.length ?? 0) > 0;
  const describedBy = [options.describedBy, invalid ? `${id}-error` : undefined].filter(Boolean).join(' ');
  return Object.freeze({ id, name, type: 'file', multiple: field.multiple || undefined,
    accept: field.accept?.join(','), required: field.required || (field.minFiles ?? 0) > 0 || undefined,
    'aria-invalid': invalid ? 'true' : undefined, 'aria-describedby': describedBy || undefined,
  });
}
