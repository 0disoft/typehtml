import type { DefinedForm } from '../form/definition.ts';
import type { DefinedSchemaForm } from '../form/schema-form.ts';
import type { FormField } from '../form/fields.ts';
import type { FormReadLimits } from '../runtime/wire.ts';

export const CATALOG_FORMAT = 'typehtml-catalog/1';
export const CATALOG_LIMITS = Object.freeze({ maxForms: 256, maxFields: 8_192, maxTitleLength: 200,
  maxBytes: 8 * 1_024 * 1_024, maxSourceBytes: 8 * 1_024 * 1_024 });
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
  const catalog: FormCatalog = { format: CATALOG_FORMAT, title, forms: [], applicationCompleteness: 'not-evaluated' };
  let bytes = new TextEncoder().encode(serializeFormCatalog(catalog)).byteLength;
  const entries: CatalogEntry[] = [];
  for (const form of forms) {
    if (ids.has(form.id) || routes.has(form.path)) throw new TypeError('duplicate catalog form ID or route');
    ids.add(form.id); routes.add(form.path);
    const rich = 'kind' in form;
    const required = new Set(rich ? [] : form.input.schema.required);
    const declarations: Readonly<Record<string, FormField>> = rich ? form.fields : form.input.schema.properties;
    const names = Object.keys(declarations);
    fieldCount += names.length;
    if (fieldCount > CATALOG_LIMITS.maxFields) throw new TypeError('catalog field limit exceeded');
    const fields = names.map((name) => ({
      name, required: rich ? declarations[name]!.required === true : required.has(name),
      schema: declarations[name]!,
    }));
    const protocol = rich ? form.protocol : form.definition.protocol;
    const entry: CatalogEntry = {
      id: form.id, method: 'POST', path: form.path, encoding: 'application/x-www-form-urlencoded', fields,
      protocolFields: protocol?.requestKey === 'required' ? ['_bc_csrf', '_bc_request'] : ['_bc_csrf'],
      limits: { ...form.limits }, validation: rich ? 'standard-schema-not-statically-analyzed' : 'static-json-profile',
    };
    // Count the exact pretty-JSON contribution before cloning this entry or visiting later forms.
    // Entries are indented four spaces; the first replaces [] with [\n...\n  ], later ones add ,\n.
    const json = JSON.stringify(entry, null, 2);
    let lines = 1;
    for (let index = 0; index < json.length; index++) if (json[index] === '\n') lines++;
    bytes += new TextEncoder().encode(json).byteLength + 4 * lines + (entries.length === 0 ? 4 : 2);
    if (bytes > CATALOG_LIMITS.maxBytes) throw new TypeError('catalog byte limit exceeded');
    entries.push(structuredClone(entry));
  }
  return freeze({ ...catalog, forms: entries });
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

class CatalogHtml {
  private readonly parts: string[] = [];
  private readonly encoder = new TextEncoder();
  private bytes = 0;

  append(value: string): void {
    this.bytes += this.encoder.encode(value).byteLength;
    if (this.bytes > CATALOG_LIMITS.maxBytes) throw new TypeError('catalog HTML byte limit exceeded');
    this.parts.push(value);
  }

  text(value: string): void {
    // Bound escaped temporary strings as well as the retained output. Keep UTF-16 pairs together
    // so counting each chunk has exactly the same UTF-8 size as counting the joined document.
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 1_024, value.length);
      const last = value.charCodeAt(end - 1);
      const next = value.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
      this.append(value.slice(start, end).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'));
      start = end;
    }
  }

  finish(): string { return this.parts.join(''); }
}

function presence(field: CatalogField): string {
  if (field.required) return 'Required key';
  if (field.schema.type === 'array' && (field.schema.minItems ?? 0) > 0) return 'Required by minItems';
  if (field.schema.type === 'array') return 'Optional key (missing decodes to [])';
  if (field.schema.type === 'boolean') return 'Optional key (missing decodes to false)';
  return 'Optional key';
}

/** Read-only HTML, with no scripts, active forms, remote assets, or hidden sections. */
export function renderFormCatalog(catalog: FormCatalog): string {
  serializeFormCatalog(catalog);
  const html = new CatalogHtml();
  html.append(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>`);
  html.text(catalog.title);
  html.append(`</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#182434;background:#fff}section{margin:2rem 0;padding-top:1rem;border-top:2px solid #ccd6df}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd6df;padding:.7rem;text-align:left;vertical-align:top}caption{text-align:left;font-weight:600;margin:.5rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}code{overflow-wrap:anywhere}h1,h2,h3{line-height:1.25}</style></head>
<body><h1>`);
  html.text(catalog.title);
  html.append(`</h1><p>${catalog.forms.length} explicitly registered forms. This catalog documents declarations; it does not execute application code or prove application completeness.</p>
<p>The native boundary normally returns HTML 422 for invalid input and a 303 redirect after success. Authentication, authorization, CSRF tokens, persistence, and redirected GET pages belong to the host application. Required keys, empty values, and browser selection constraints have distinct semantics; consult each codec. Standard Schema refinements, transforms, and output types are not inferred here.</p>
`);
  for (const [index, form] of catalog.forms.entries()) {
    if (index > 0) html.append('\n');
    html.append('<section><h2>'); html.text(form.id); html.append('</h2><p><code>');
    html.text(form.method); html.append(' '); html.text(form.path);
    html.append('</code></p>\n<p>Encoding: <code>'); html.text(form.encoding);
    html.append('</code>. Validation: <code>'); html.text(form.validation);
    html.append('</code>.</p>\n<p>Protocol fields: ');
    for (const [protocolIndex, name] of form.protocolFields.entries()) {
      if (protocolIndex > 0) html.append(', ');
      html.append('<code>'); html.text(name); html.append('</code>');
    }
    html.append('. No token values are included.</p>\n<table><caption>Declared wire fields</caption><thead><tr><th scope="col">Name</th><th scope="col">Presence</th><th scope="col">Codec and constraints</th></tr></thead><tbody>');
    for (const [fieldIndex, field] of form.fields.entries()) {
      if (fieldIndex > 0) html.append('\n');
      html.append('<tr><th scope="row"><code>'); html.text(field.name);
      html.append('</code></th><td>'); html.text(presence(field));
      html.append('</td><td><pre>'); html.text(JSON.stringify(field.schema, null, 2));
      html.append('</pre></td></tr>');
    }
    html.append('</tbody></table>\n<h3>Transport limits</h3><pre>');
    html.text(JSON.stringify(form.limits, null, 2)); html.append('</pre></section>');
  }
  html.append('</body></html>\n');
  return html.finish();
}
