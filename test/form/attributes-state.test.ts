import { describe, expect, it } from 'bun:test';
import { defineForm } from '../../src/form/definition.ts';
import { getFieldProps, getFormProps, getOptionProps, renderAttributes } from '../../src/form/attributes.ts';
import { createFormState, formFieldId, renderErrorSummary, renderFieldErrors } from '../../src/form/state.ts';

const form = defineForm({ id: 'feedback', path: '/feedback',
  input: { type: 'object', additionalProperties: false, required: ['name', 'empty', 'count'], properties: {
    name: { type: 'string', minLength: 1, maxLength: 2 }, empty: { type: 'string' },
    count: { type: 'integer', minimum: -1, maximum: 3 },
    draft: { type: 'string', pattern: '^draft_[A-Za-z0-9_-]{1,58}$' },
    optional: { type: 'string', minLength: 2 },
  } },
  output: { type: 'object', additionalProperties: false, required: [], properties: { result: { type: 'string' } } },
});

describe('native form attributes and redisplay state', () => {
  it('generates form/name/required constraints without confusing presence with nonempty', () => {
    expect(getFormProps(form)).toEqual({ id: 'feedback', action: '/feedback', method: 'post', enctype: 'application/x-www-form-urlencoded' });
    expect(getFieldProps(form, 'name')).toMatchObject({ name: 'name', required: true, minlength: 1, maxlength: 4 });
    expect(getFieldProps(form, 'empty').required).toBeUndefined();
    expect(getFieldProps(form, 'optional').required).toBeUndefined();
    expect(() => getFieldProps(form, '__proto__')).toThrow('unknown form field');
    expect(Object.isFrozen(getFieldProps(form, 'name'))).toBe(true);
  });

  it('does not exclude valid astral characters and generates v-compatible patterns', () => {
    const props = getFieldProps(form, 'name');
    const pattern = new RegExp(`^(?:${props.pattern})$`, 'v');
    expect('😀😀'.length).toBe(Number(props.maxlength));
    expect(pattern.test('😀😀')).toBe(true);
    expect(pattern.test('😀😀😀')).toBe(false);
    expect(pattern.test('')).toBe(false);
    const draft = new RegExp(`^(?:${getFieldProps(form, 'draft').pattern})$`, 'v');
    expect(draft.test('draft_a-b_9')).toBe(true);
    expect(draft.test('draft_')).toBe(false);
    expect(getFieldProps(form, 'name', { control: 'textarea' }).pattern).toBeUndefined();
  });

  it('preserves canonical integer text validation and exposes numeric bounds only on number inputs', () => {
    const text = getFieldProps(form, 'count');
    expect(text).toMatchObject({ type: 'text', inputmode: 'numeric', pattern: '(0|-?[1-9][0-9]*)', required: true });
    expect(text.min).toBeUndefined();
    const number = getFieldProps(form, 'count', { control: 'number' });
    expect(number).toMatchObject({ type: 'number', min: -1, max: 3, step: 1 });
    expect(() => getFieldProps(form, 'name', { control: 'number' })).toThrow();
  });

  it('snapshots values/errors, localizes by code, and returns escaped field and summary markup', () => {
    const values = { name: '<"&' };
    const issues = [{ field: 'name', code: 'MIN_LENGTH', message: 'too short' }, { field: null, code: 'FORM', message: '<form>' }];
    const state = createFormState(values, issues, { locale: 'ko-KR', messages: { MIN_LENGTH: (issue) => `${issue.field} 오류 <검사>` } });
    values.name = 'changed';
    issues[0]!.message = 'changed';
    expect(state.rawValues.name).toBe('<"&');
    expect(state.fieldErrors.name).toEqual(['name 오류 <검사>']);
    const props = getFieldProps(form, 'name', { state, describedBy: 'help' });
    expect(props['aria-invalid']).toBe('true');
    expect(props['aria-describedby']).toBe(`help ${props.id}-error`);
    expect(renderFieldErrors(state, 'name')).toBe(`<span id="${props.id}-error">name 오류 &lt;검사&gt;</span>`);
    expect(renderErrorSummary(state, { title: '<오류>' })).toContain('&lt;오류&gt;');
    expect(renderErrorSummary(state)).toContain('&lt;form&gt;');
    expect(renderAttributes(props)).toContain('value="&lt;&quot;&amp;"');
    expect(() => createFormState({}, [], { locale: '' })).toThrow();
    expect(renderFieldErrors(state, 'missing')).toBe('');
    expect(renderErrorSummary(createFormState({}, []))).toBe('');
  });

  it('handles checkbox/radio/select values explicitly and does not mutate input arrays', () => {
    const values = ['red', 'blue'];
    const state = createFormState({ name: values }, []);
    values.push('green');
    expect(getFieldProps(form, 'name', { state, control: 'checkbox', optionValue: 'blue' })).toMatchObject({ checked: true, value: 'blue' });
    expect(getFieldProps(form, 'name', { state, control: 'radio', optionValue: 'green' }).checked).toBe(false);
    expect(() => getFieldProps(form, 'name', { control: 'checkbox' })).toThrow('explicit optionValue');
    expect(() => getFieldProps(form, 'name', { state })).toThrow('one string');
    expect(getOptionProps('red', state.rawValues.name)).toEqual({ value: 'red', selected: true });
    expect(getOptionProps('green', state.rawValues.name)).toEqual({ value: 'green', selected: false });
    expect(formFieldId('a.b')).not.toBe(formFieldId('a-b'));
  });

  it('protects prototype-like names and rejects executable/malformed attribute names', () => {
    const raw = Object.fromEntries([['__proto__', 'raw']]);
    const state = createFormState(raw, [{ field: '__proto__', code: 'BAD', message: 'error' }]);
    expect(state.rawValues.__proto__).toBe('raw');
    expect(state.fieldErrors.__proto__).toEqual(['error']);
    expect(Object.getPrototypeOf(state.rawValues)).toBeNull();
    expect(renderAttributes({ checked: true, disabled: false, title: '"&' })).toBe(' checked title="&quot;&amp;"');
    expect(() => renderAttributes({ onclick: 'alert(1)' })).toThrow('unsafe HTML attribute');
    expect(() => renderAttributes({ 'x"bad': 'bad' })).toThrow('unsafe HTML attribute');
  });
});
