import { describe, expect, test } from 'bun:test';
import { defineWireForm, projectWireForm } from '../../src/form/wire-manifest.ts';
import type { FormFields } from '../../src/form/fields.ts';
import { parseHtmlDocument } from '../../src/doctor/html.ts';
import { collectRichFormControls } from '../../src/doctor/rich-controls.ts';
import { analyzeRichForm } from '../../src/doctor/rich-analyze.ts';

function analyze(fields: FormFields, html: string, skipValidation = false) {
  const check = projectWireForm(defineWireForm({ id: 'rich.send', path: '/send', fields }), { sourcePath: 'source.json', sourceSha256: 'a'.repeat(64) });
  const form = parseHtmlDocument(`<form id="rich" action="/send" method="post"><input type="hidden" name="_bc_csrf" value="token">${html}</form>`, 'https://example.test').forms[0]!;
  return analyzeRichForm({ form, check, submitter: null, skipValidation });
}
const codes = (result: ReturnType<typeof analyze>) => result.findings.map((finding) => finding.subcode);

describe('rich structural Doctor analysis', () => {
  test('allows repeated values in order while preserving scalar duplicate rejection', () => {
    const fields = { tags: { type: 'array', items: { type: 'string' } }, title: { type: 'string' } } as const;
    const valid = analyze(fields, '<input name="tags" value="a"><input name="tags" value="a"><input name="title">');
    expect(codes(valid)).toEqual([]);
    expect(valid.collection.fields.get('tags')?.maximum).toBe(2);
    expect(codes(analyze(fields, '<input name="title"><input name="title">'))).toContain('duplicate-scalar');
  });

  test('checks array boundaries immediately below, at and above maxItems', () => {
    const fields = { tags: { type: 'array', items: { type: 'string' }, maxItems: 2 } } as const;
    for (const count of [1, 2, 3]) {
      const result = analyze(fields, '<input name="tags">'.repeat(count));
      expect(codes(result).includes('max-occurrences')).toBe(count === 3);
    }
    expect(codes(analyze({ tags: { ...fields.tags, minItems: 2 } }, '<input name="tags">'))).toContain('missing-wire-field');
  });

  test('models optional boolean absence and finite checkbox tokens', () => {
    expect(codes(analyze({ accepted: { type: 'boolean' } }, ''))).toEqual([]);
    const optional = analyze({ accepted: { type: 'boolean' } }, '<input type="checkbox" name="accepted">');
    expect(optional.collection.fields.get('accepted')).toMatchObject({ minimum: 0, maximum: 1 });
    expect(codes(optional)).toEqual([]);
    expect(codes(analyze({ accepted: { type: 'boolean', trueValue: 'yes' } }, '<input type="checkbox" name="accepted">'))).toContain('native-choice-rejected');
    const required = { accepted: { type: 'boolean' as const, required: true } };
    expect(codes(analyze(required, '<input type="checkbox" name="accepted" required>'))).toEqual([]);
    expect(codes(analyze(required, '<input type="checkbox" name="accepted" required>', true))).toContain('conditional-wire-supply');
  });

  test('resolves only declared canonical nested names', () => {
    const fields = { 'person.name': { type: 'string', required: true }, 'items[0].title': { type: 'string' } } as const;
    expect(codes(analyze(fields, '<input name="person.name"><input name="items[0].title">'))).toEqual([]);
    const invalid = analyze(fields, '<input name="person.name"><input name="items[00].title">');
    expect(codes(invalid)).toContain('unknown-wire-field');
    expect(invalid.findings.find((finding) => finding.subcode === 'unknown-wire-field')?.remediation).toContain('canonical');
  });

  test('groups radios once and sums independent controls without state enumeration', () => {
    const form = parseHtmlDocument('<form><input type="radio" name="channel" required value="a"><input type="radio" name="channel" value="b"><input type="checkbox" name="tag" required><input type="checkbox" name="tag"></form>', 'https://example.test').forms[0]!;
    const result = collectRichFormControls(form, null);
    expect(result.fields.get('channel')).toMatchObject({ minimum: 1, maximum: 1 });
    expect(result.fields.get('channel')?.choices.map((choice) => choice.value)).toEqual(['a', 'b']);
    expect(result.fields.get('tag')).toMatchObject({ minimum: 1, maximum: 2 });
    const large = parseHtmlDocument(`<form>${'<input type="checkbox" name="tags">'.repeat(2_000)}</form>`, 'https://example.test').forms[0]!;
    const aggregated = collectRichFormControls(large, null);
    expect(aggregated.fields.size).toBe(1);
    expect(aggregated.fields.get('tags')).toMatchObject({ minimum: 0, maximum: 2_000 });
  });

  test('filters disabled options, associates external controls and selects one submitter', () => {
    const parsed = parseHtmlDocument('<form id="f"><select multiple name="tags" required><option>a</option><option disabled>b</option><option>c</option></select><button name="intent" value="a">A</button><button name="intent" value="b">B</button></form><input form="f" name="outside">', 'https://example.test');
    const form = parsed.forms[0]!;
    const button = form.controls.find((control) => control.tagName === 'button')!;
    const result = collectRichFormControls(form, button);
    expect(result.fields.get('tags')).toMatchObject({ minimum: 1, maximum: 2 });
    expect(result.fields.get('intent')).toMatchObject({ minimum: 1, maximum: 1 });
    expect(result.fields.get('outside')).toMatchObject({ minimum: 1, maximum: 1 });
    expect(result.fields.get('intent')?.choices.map(({ value }) => value)).toEqual(['a']);
    expect(codes(analyze({ title: { type: 'string' } }, '<select name="undeclared"><option disabled>x</option></select>'))).toEqual([]);
    expect(codes(analyze({ title: { type: 'string', minLength: 1 } }, '<textarea name="title" readonly>Saved value</textarea>'))).toEqual([]);
    const redactedSelect = parseHtmlDocument('<form><select name="choice" required><option value="[REDACTED]">[REDACTED]</option></select></form>', 'https://example.test').forms[0]!;
    expect(collectRichFormControls(redactedSelect, null, false, true).fields.get('choice')).toMatchObject({ minimum: 0, maximum: 1 });
  });

  test('does not claim file content or editable refinements are statically established', () => {
    const file = analyze({ attachment: { type: 'string' } }, '<input type="file" name="attachment" multiple>');
    expect(codes(file)).toContain('wire-kind-mismatch');
    expect(file.collection.fields.get('attachment')).toMatchObject({ minimum: 0, maximum: null, kind: 'file' });
    const opaque = analyze({ age: { type: 'integer', minimum: 18 } }, '<input name="age">');
    expect(opaque.constraintsStatus).toBe('unknown');
    expect(codes(opaque)).toContain('editable-wire-constraints');
    const mismatch = analyze({ 'person.age': { type: 'integer', minimum: 18, maximum: 40 } }, '<input type="number" name="person.age" min="18" max="41">');
    expect(mismatch.findings.find((finding) => finding.subcode === 'max-witness')).toMatchObject({ ruleId: 'BC013', schemaPath: '/transport/declarations/person.age/maximum' });
    expect(codes(analyze({ age: { type: 'integer', maximum: 40 } }, '<input type="number" name="age" max="40">'))).not.toContain('max-witness');
  });

  test('validates only active collection rows and detects gaps and duplicate stable identities', () => {
    const check = projectWireForm(defineWireForm({ id: 'rows', path: '/rows', fields: {}, collections: { items: {
      minItems: 0, maxItems: 3, rowKey: 'rowId', fields: {
        rowId: { type: 'string', required: true, minLength: 1, maxLength: 64 },
        quantity: { type: 'integer', required: true }, tags: { type: 'array', items: { type: 'string' } },
      },
    } } }), { sourcePath: 'rows.json', sourceSha256: 'a'.repeat(64) });
    const inspect = (html: string) => analyzeRichForm({ check, submitter: null,
      form: parseHtmlDocument(`<form><input type="hidden" name="_bc_csrf">${html}</form>`, 'https://example.test').forms[0]!,
    });
    expect(inspect('').findings).toEqual([]); // Declared future rows must not appear missing.
    const row = (index: number, key: string) => `<input type="hidden" name="items[${index}].rowId" value="${key}"><input type="hidden" name="items[${index}].quantity" value="1">`;
    expect(inspect(row(0, 'a')).findings).toEqual([]);
    expect(inspect(row(0, 'a') + row(1, 'b')).findings).toEqual([]);
    expect(inspect(row(1, 'b')).findings.map((finding) => finding.subcode)).toContain('sparse-collection-rows');
    expect(inspect(row(0, 'a') + row(1, 'a')).findings.map((finding) => finding.subcode)).toContain('duplicate-row-identity');
    expect(inspect(row(3, 'd')).findings.map((finding) => finding.subcode)).toContain('unknown-wire-field');
  });

  test('checks upload control kind and cardinality, preserving unknown selected content and bypassed presence', () => {
    const check = projectWireForm(defineWireForm({ id: 'upload.form', path: '/upload', fields: { title: { type: 'string' } },
      uploads: { file: { required: true } }, multipart: {},
    }), { sourcePath: 'upload.json', sourceSha256: 'a'.repeat(64) });
    const inspect = (html: string, skipValidation = false) => analyzeRichForm({ check, submitter: null, skipValidation,
      form: parseHtmlDocument(`<form><input type="hidden" name="_bc_csrf">${html}</form>`, 'https://example.test').forms[0]!,
    });
    const valid = inspect('<input type="file" name="file" required>');
    expect(valid.findings.map((finding) => finding.subcode)).toEqual(['file-content-not-analyzed']);
    expect(valid.findings.every((finding) => finding.outcome !== 'defect')).toBe(true);
    expect(inspect('<input type="file" name="file" required multiple>').findings.map((finding) => finding.subcode)).toContain('upload-cardinality-mismatch');
    expect(inspect('<input name="file">').findings.map((finding) => finding.subcode)).toContain('wire-kind-mismatch');
    expect(inspect('<input type="file" name="file" required>', true).findings.map((finding) => finding.subcode)).toContain('conditional-upload-supply');
  });
});
