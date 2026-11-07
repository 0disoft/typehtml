import type { DefinedForm } from '../form/definition.ts';
import type { DefinedSchemaForm } from '../form/schema-form.ts';
import type { FormField } from '../form/fields.ts';
import type { FormReadLimits } from '../runtime/wire.ts';

export const CATALOG_FORMAT = 'typehtml-catalog/1';
export const CATALOG_LIMITS = Object.freeze({ maxForms: 256, maxFields: 8_192, maxTitleLength: 200, maxBytes: 8 * 1_024 * 1_024 });
export type CatalogForm = DefinedForm | DefinedSchemaForm;
export interface CatalogField {
  readonly name: string;
  readonly required: boolean;
  readonly schema: FormField;
}
export interface CatalogEntry {
  readonly id: string;
  readonly method: 'POST';
  readonly path: string;
  readonly encoding: 'application/x-www-form-urlencoded';
  readonly fields: readonly CatalogField[];
  readonly protocolFields: readonly string[];
  readonly limits: Required<FormReadLimits>;
  readonly validation: 'static-json-profile' | 'standard-schema-not-statically-analyzed';
}
export interface FormCatalog {
  readonly format: typeof CATALOG_FORMAT;
  readonly title: string;
  readonly forms: readonly CatalogEntry[];
  readonly applicationCompleteness: 'not-evaluated';
}

/** Explicit definitions only: never discover routes or introspect/execute vendor validators. */
export function createFormCatalog(forms: readonly CatalogForm[], options: Readonly<{ title?: string }> = {}): FormCatalog {
  if (!Array.isArray(forms) || forms.length === 0 || forms.length > CATALOG_LIMITS.maxForms) throw new TypeError('invalid catalog form count');
  const title = options.title ?? 'TypeHTML form catalog';
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > CATALOG_LIMITS.maxTitleLength) throw new TypeError('invalid catalog title');
  const ids = new Set<string>();
  const routes = new Set<string>();
  let fieldCount = 0;
  const entries = forms.map((form): CatalogEntry => {
    if (ids.has(form.id) || routes.has(form.path)) throw new TypeError('duplicate catalog form ID or route');
    ids.add(form.id); routes.add(form.path);
    const rich = 'kind' in form;
    const required = new Set(rich ? [] : form.input.schema.required);
    const declarations: Readonly<Record<string, FormField>> = rich ? form.fields : form.input.schema.properties;
    const fields = Object.entries(declarations).map(([name, schema]) => ({
      name, required: rich ? (schema as FormField).required === true : required.has(name),
      schema: structuredClone(schema),
    }));
    fieldCount += fields.length;
    if (fieldCount > CATALOG_LIMITS.maxFields) throw new TypeError('catalog field limit exceeded');
    const protocol = rich ? form.protocol : form.definition.protocol;
    return {
      id: form.id, method: 'POST', path: form.path, encoding: 'application/x-www-form-urlencoded', fields,
      protocolFields: protocol?.requestKey === 'required' ? ['_bc_csrf', '_bc_request'] : ['_bc_csrf'],
      limits: { ...form.limits }, validation: rich ? 'standard-schema-not-statically-analyzed' : 'static-json-profile',
    };
  });
  const catalog: FormCatalog = { format: CATALOG_FORMAT, title, forms: entries, applicationCompleteness: 'not-evaluated' };
  // Bound export size before rendering; callbacks, tokens, and validator internals are never copied.
  serializeFormCatalog(catalog);
  return freeze(catalog);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function serializeFormCatalog(catalog: FormCatalog): string {
  const json = `${JSON.stringify(catalog, null, 2)}\n`;
  if (new TextEncoder().encode(json).byteLength > CATALOG_LIMITS.maxBytes) throw new TypeError('catalog byte limit exceeded');
  return json;
}

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Read-only HTML, with no scripts, active forms, remote assets, or hidden sections. */
export function renderFormCatalog(catalog: FormCatalog): string {
  serializeFormCatalog(catalog);
  const sections = catalog.forms.map((form) => {
    const rows = form.fields.map((field) => `<tr><th scope="row"><code>${escape(field.name)}</code></th><td>${field.required ? 'Required key' : 'Optional key'}</td><td><pre>${escape(JSON.stringify(field.schema, null, 2))}</pre></td></tr>`).join('\n');
    return `<section><h2>${escape(form.id)}</h2><p><code>${form.method} ${escape(form.path)}</code></p>
<p>Encoding: <code>${form.encoding}</code>. Validation: <code>${form.validation}</code>.</p>
<p>Protocol fields: ${form.protocolFields.map((name) => `<code>${escape(name)}</code>`).join(', ')}. No token values are included.</p>
<table><caption>Declared wire fields</caption><thead><tr><th scope="col">Name</th><th scope="col">Presence</th><th scope="col">Codec and constraints</th></tr></thead><tbody>${rows}</tbody></table>
<h3>Transport limits</h3><pre>${escape(JSON.stringify(form.limits, null, 2))}</pre></section>`;
  }).join('\n');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escape(catalog.title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#182434;background:#fff}section{margin:2rem 0;padding-top:1rem;border-top:2px solid #ccd6df}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd6df;padding:.7rem;text-align:left;vertical-align:top}caption{text-align:left;font-weight:600;margin:.5rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}code{overflow-wrap:anywhere}h1,h2,h3{line-height:1.25}</style></head>
<body><h1>${escape(catalog.title)}</h1><p>${catalog.forms.length} explicitly registered forms. This catalog documents declarations; it does not execute application code or prove application completeness.</p>
<p>The native boundary normally returns HTML 422 for invalid input and a 303 redirect after success. Authentication, authorization, CSRF tokens, persistence, and redirected GET pages belong to the host application. Required keys, empty values, and browser selection constraints have distinct semantics; consult each codec. Standard Schema refinements, transforms, and output types are not inferred here.</p>
${sections}</body></html>\n`;
  if (new TextEncoder().encode(html).byteLength > CATALOG_LIMITS.maxBytes) throw new TypeError('catalog HTML byte limit exceeded');
  return html;
}
