import { describe, expect, it } from 'bun:test';
import type { ObjectSchema } from '../../src/contract/types.ts';
import { renderFormErrors } from '../../src/form/html.ts';
import type { InputIssue } from '../../src/runtime/input.ts';

describe('form error rendering', () => {
  it('preserves exact markup, schema order, duplicate errors, and escaping', () => {
    const schema: ObjectSchema = Object.freeze({
      type: 'object', additionalProperties: false,
      required: Object.freeze(['title', 'amount', 'label']),
      properties: Object.freeze({
        unused: Object.freeze({ type: 'string' }),
        amount: Object.freeze({ type: 'integer' }),
        note: Object.freeze({ type: 'string' }),
        label: Object.freeze({ type: 'string', minLength: 0 }),
        title: Object.freeze({ type: 'string', minLength: 1 }),
      }),
    });
    const raw = Object.freeze({ note: '<say & "hi"\'>', amount: '-0', title: '', unknown: 'hidden' });
    const issues: readonly InputIssue[] = Object.freeze([
      Object.freeze({ field: 'note', code: 'FIRST', message: '<first> & "quoted"' }),
      Object.freeze({ field: null, code: 'FORM', message: "Form's problem" }),
      Object.freeze({ field: 'amount', code: 'INTEGER', message: 'Invalid amount' }),
      Object.freeze({ field: 'note', code: 'SECOND', message: 'Second problem' }),
      Object.freeze({ field: 'note', code: 'FIRST', message: '<first> & "quoted"' }),
      Object.freeze({ field: 'unknown', code: 'UNKNOWN', message: 'Unknown field' }),
      Object.freeze({ field: 'unused', code: 'UNUSED', message: 'Absent optional field' }),
    ]);

    expect(renderFormErrors('/submit?x="&', schema, raw, issues, '<token>')).toBe(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Check your form</title></head><body><main><h1>Check your form</h1><section aria-labelledby="errors-title" role="alert"><h2 id="errors-title">Fields to correct</h2><ul><li><a href="#field-note">&lt;first&gt; &amp; &quot;quoted&quot;</a></li><li>Form&#39;s problem</li><li><a href="#field-amount">Invalid amount</a></li><li><a href="#field-note">Second problem</a></li><li><a href="#field-note">&lt;first&gt; &amp; &quot;quoted&quot;</a></li><li><a href="#field-unknown">Unknown field</a></li><li><a href="#field-unused">Absent optional field</a></li></ul></section><form method="post" action="/submit?x=&quot;&amp;"><input type="hidden" name="_bc_csrf" value="&lt;token&gt;"><p><label for="field-amount">amount</label>
<input id="field-amount" name="amount" type="text" inputmode="numeric" pattern="(0|-?[1-9][0-9]*)" required value="-0" aria-invalid="true" aria-describedby="field-amount-error">
<span id="field-amount-error">Invalid amount</span></p>
<p><label for="field-note">note</label>
<input id="field-note" name="note" type="text" value="&lt;say &amp; &quot;hi&quot;&#39;&gt;" aria-invalid="true" aria-describedby="field-note-error">
<span id="field-note-error">&lt;first&gt; &amp; &quot;quoted&quot;, Second problem, &lt;first&gt; &amp; &quot;quoted&quot;</span></p>
<p><label for="field-label">label</label>
<input id="field-label" name="label" type="text" value="">
</p>
<p><label for="field-title">title</label>
<input id="field-title" name="title" type="text" required value="">
</p><button type="submit">Submit</button></form></main></body></html>`);
  });

  it('renders empty errors and prototype-like field names without inventing errors', () => {
    const schema: ObjectSchema = {
      type: 'object', additionalProperties: false, required: [],
      properties: Object.fromEntries(['constructor', '__proto__', 'toString'].map((name) => [name, { type: 'string' }])),
    };
    const raw = Object.freeze({ constructor: 'present' });
    const html = renderFormErrors('/submit', schema, raw, [], 'token');
    expect(html).toContain('<ul></ul>');
    expect(html).toContain('name="constructor" type="text" value="present"');
    expect(html).not.toContain('name="__proto__"');
    expect(html).not.toContain('name="toString"');
    expect(html).not.toContain('aria-invalid');
  });

  it('visits required entries and issues only linearly for a wide, entirely missing form', () => {
    const count = 256;
    const names = Array.from({ length: count }, (_, index) => `field${index}`);
    let requiredReads = 0;
    let issueReads = 0;
    const required = new Proxy(Object.freeze(names), {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) requiredReads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const schema: ObjectSchema = {
      type: 'object', additionalProperties: false, required,
      properties: Object.fromEntries(names.map((name) => [name, { type: 'string', minLength: 1 }])),
    };
    const issues: InputIssue[] = names.map((name) => Object.freeze({
      get field() { issueReads++; return name; }, code: 'REQUIRED', message: `${name} is required`,
    }));

    const html = renderFormErrors('/submit', schema, Object.freeze({}), Object.freeze(issues), 'token');
    expect(html.match(/ aria-invalid="true"/g)?.length).toBe(count);
    expect(html.match(/<li>/g)?.length).toBe(count);
    expect(requiredReads).toBeLessThanOrEqual(count * 2);
    expect(issueReads).toBeLessThanOrEqual(count * 3);
  });
});
