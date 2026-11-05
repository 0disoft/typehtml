import type { ObjectSchema } from '../contract/types.ts';
import type { InputIssue } from '../runtime/input.ts';

/** Encodes plain text for HTML text and quoted attribute contexts. */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function renderFormErrors(path: string, schema: ObjectSchema, raw: Readonly<Record<string, string>>, issues: readonly InputIssue[], csrfToken: string): string {
  const required = new Set(schema.required);
  const errorsByField = new Map<string, InputIssue[]>();
  for (const issue of issues) {
    const field = issue.field;
    if (field === null) continue;
    const errors = errorsByField.get(field);
    if (errors) errors.push(issue);
    else errorsByField.set(field, [issue]);
  }
  const summary = issues.map((issue) => `<li>${issue.field === null ? escapeHtml(issue.message) : `<a href="#field-${escapeHtml(issue.field)}">${escapeHtml(issue.message)}</a>`}</li>`).join('');
  const fields = Object.entries(schema.properties).filter(([name]) => required.has(name) || Object.hasOwn(raw, name)).map(([name, field]) => {
    const errors = errorsByField.get(name) ?? [];
    const id = `field-${name}`;
    return `<p><label for="${id}">${escapeHtml(name)}</label>
<input id="${id}" name="${name}" type="text"${field.type === 'integer' ? ' inputmode="numeric" pattern="(0|-?[1-9][0-9]*)"' : ''}${required.has(name) && (field.type === 'integer' || (field.minLength ?? 0) > 0) ? ' required' : ''} value="${escapeHtml(raw[name] ?? '')}"${errors.length > 0 ? ` aria-invalid="true" aria-describedby="${id}-error"` : ''}>
${errors.length === 0 ? '' : `<span id="${id}-error">${errors.map((issue) => escapeHtml(issue.message)).join(', ')}</span>`}</p>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Check your form</title></head><body><main><h1>Check your form</h1><section aria-labelledby="errors-title" role="alert"><h2 id="errors-title">Fields to correct</h2><ul>${summary}</ul></section><form method="post" action="${escapeHtml(path)}"><input type="hidden" name="_bc_csrf" value="${escapeHtml(csrfToken)}">${fields}<button type="submit">Submit</button></form></main></body></html>`;
}

export function renderFailure(status: number, code: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Request failed</title></head><body><main><h1>Request failed</h1><p>Status: ${status}</p><p>${escapeHtml(code)}</p></main></body></html>`;
}
