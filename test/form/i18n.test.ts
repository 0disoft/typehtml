import { describe, expect, it } from 'bun:test';
import { createFormMessages, resolveFormLocale } from '../../src/form/i18n.ts';
import { createFormState, renderFieldErrors } from '../../src/form/state.ts';
import { defineForm } from '../../src/form/definition.ts';
import { decodeFormFields, type FormFields } from '../../src/form/fields.ts';
import { validateBusinessInput, type InputIssue } from '../../src/runtime/input.ts';

const issue = (field: string | null, code: string, message = 'original vendor text'): InputIssue => ({ field, code, message });
const options = { supportedLocales: ['en', 'ko-KR'], fallbackLocale: 'en' } as const;

describe('explicit form locale negotiation', () => {
  it('uses quality then header order and canonicalizes configured locales', () => {
    expect(resolveFormLocale({ ...options, acceptLanguage: 'en;q=0.500,ko-kr;q=0.501' })).toBe('ko-KR');
    expect(resolveFormLocale({ ...options, acceptLanguage: 'en;q=0.501,ko-KR;q=0.500' })).toBe('en');
    expect(resolveFormLocale({ ...options, acceptLanguage: 'ko-KR;q=0.5,en;q=0.5' })).toBe('ko-KR');
    expect(resolveFormLocale({ supportedLocales: ['en-US', 'KO-kr'], fallbackLocale: 'ko-KR', acceptLanguage: 'en' })).toBe('en-US');
    expect(resolveFormLocale({ ...options, acceptLanguage: 'ko;q=1.000,en;q=0.999' })).toBe('ko-KR');
  });

  it('uses explicit session preferences before the header and performs subtag lookup', () => {
    expect(resolveFormLocale({ ...options, preferredLocales: ['de-DE', 'ko-KR'], acceptLanguage: 'en;q=1,ko-KR;q=0' })).toBe('ko-KR');
    expect(resolveFormLocale({ ...options, preferredLocales: ['en-GB-u-ca-gregory'], acceptLanguage: 'ko' })).toBe('en');
    expect(resolveFormLocale({ ...options, acceptLanguage: 'ko-KR-x-demo' })).toBe('ko-KR');
    expect(resolveFormLocale({ ...options, acceptLanguage: 'de-DE' })).toBe('en');
    expect(resolveFormLocale(options)).toBe('en');
  });

  it('handles wildcard and zero-quality exclusions without blocking a more specific choice', () => {
    expect(resolveFormLocale({ ...options, acceptLanguage: 'en;q=0,*;q=0.5' })).toBe('ko-KR');
    expect(resolveFormLocale({ ...options, acceptLanguage: 'ko;q=0,ko-KR;q=1' })).toBe('ko-KR');
    expect(resolveFormLocale({ ...options, acceptLanguage: '*;q=0,ko;q=1' })).toBe('ko-KR');
    expect(resolveFormLocale({ supportedLocales: ['en-US', 'en-GB', 'ko'], fallbackLocale: 'ko', acceptLanguage: 'en-US;q=0,en;q=1' })).toBe('en-GB');
    // Negotiation failure always uses the explicit application fallback.
    expect(resolveFormLocale({ ...options, acceptLanguage: '*;q=0' })).toBe('en');
  });

  it('uses the most specific matching weight before comparing available languages', () => {
    const regional = { supportedLocales: ['en-US', 'ko'], fallbackLocale: 'en-US' } as const;
    expect(resolveFormLocale({ ...regional, acceptLanguage: 'en;q=0.9,en-US;q=0.1,ko;q=0.5' })).toBe('ko');
    expect(resolveFormLocale({ ...regional, acceptLanguage: 'en;q=0.1,en-US;q=0.9,ko;q=0.5' })).toBe('en-US');
    expect(resolveFormLocale({ ...regional, acceptLanguage: 'en;q=1,en-US;q=0,ko;q=0.001' })).toBe('ko');
    expect(resolveFormLocale({ ...regional, acceptLanguage: 'en;q=0,en-US;q=1,ko;q=0.5' })).toBe('en-US');
    expect(resolveFormLocale({ ...options, acceptLanguage: 'en-US;q=1,en;q=0,ko;q=0.5' })).toBe('ko-KR');
  });

  it('ignores malformed weights/ranges and uses the first duplicate', () => {
    for (const malformed of ['ko;q=1.001', 'ko;q=-1', 'ko;q=.5', 'ko;q=0.0001', 'ko;q=NaN', 'ko;q=1;q=0', 'ko;other=1', 'ko_kr', 'ko-💥']) {
      expect(resolveFormLocale({ ...options, acceptLanguage: `${malformed},en;q=0.1` })).toBe('en');
    }
    expect(resolveFormLocale({ ...options, acceptLanguage: 'ko;q=0,ko;q=1,en;q=0.5' })).toBe('en');
    expect(resolveFormLocale({ ...options, acceptLanguage: '  ko-KR ; Q=0.900 , en ; q=0.800 ' })).toBe('ko-KR');
  });

  it('validates allowlists, bounded inputs, and fallback membership', () => {
    expect(() => resolveFormLocale({ ...options, supportedLocales: [] })).toThrow();
    expect(() => resolveFormLocale({ ...options, supportedLocales: Array.from({ length: 33 }, () => 'en') })).toThrow();
    expect(() => resolveFormLocale({ ...options, preferredLocales: Array.from({ length: 33 }, () => 'de') })).toThrow();
    expect(() => resolveFormLocale({ ...options, fallbackLocale: 'de' })).toThrow('fallback');
    expect(() => resolveFormLocale({ ...options, supportedLocales: [''] })).toThrow();
    expect(() => resolveFormLocale({ ...options, preferredLocales: ['bad_locale'] })).toThrow();
    expect(resolveFormLocale({ ...options, acceptLanguage: ' '.repeat(8_192) })).toBe('en');
    expect(() => resolveFormLocale({ ...options, acceptLanguage: ' '.repeat(8_193) })).toThrow('8192');
  });
});

describe('opt-in built-in form messages', () => {
  it('uses declared legacy bounds at each failing boundary without changing default state', () => {
    const form = defineForm({ id: 'profile', path: '/profile', input: { type: 'object', additionalProperties: false,
      required: ['name', 'age'], properties: { name: { type: 'string', minLength: 2, maxLength: 3 }, age: { type: 'integer', minimum: 0, maximum: 1 } } },
      output: { type: 'object', additionalProperties: false, required: [], properties: { result: { type: 'string' } } } });
    const messages = createFormMessages('ko-KR', { fields: form.input.schema.properties, labels: { name: '이름', age: '나이' } });
    for (const [raw, expected] of [
      [{ name: 'a', age: '-1' }, ['나이 항목은 0 이상이어야 합니다.', '이름 항목은 2자 이상 입력해 주세요.']],
      [{ name: 'abcd', age: '2' }, ['나이 항목은 1 이하여야 합니다.', '이름 항목은 3자 이하로 입력해 주세요.']],
    ] as const) {
      const result = validateBusinessInput(form.input, raw);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected invalid input');
      expect(createFormState(raw, result.issues, { locale: 'ko-KR', messages }).issues.map((item) => item.message)).toEqual([...expected]);
      expect(createFormState(raw, result.issues, { messages }).issues.map(({ field, code }) => ({ field, code }))).toEqual(result.issues.map(({ field, code }) => ({ field, code })));
      expect(createFormState(raw, result.issues).issues).toEqual(result.issues);
      expect(Object.keys(result.issues[0]!)).toEqual(['field', 'code', 'message']);
    }
    expect(validateBusinessInput(form.input, { name: '😀😀', age: '0' }).ok).toBe(true);
    expect(validateBusinessInput(form.input, { name: 'abc', age: '1' }).ok).toBe(true);
  });

  it('formats rich array/item constraints from data rather than from English text', () => {
    const fields: FormFields = { tags: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string', minLength: 2, maxLength: 4 } } };
    const messages = createFormMessages('ko', { fields, labels: { tags: '태그' } });
    const result = decodeFormFields(fields, [{ key: 'tags', value: 'x' }]);
    if (result.validation.ok) throw new Error('expected invalid input');
    expect(createFormState(result.raw, result.validation.issues, { messages }).fieldErrors.tags).toEqual([
      '태그 항목은 2자 이상 입력해 주세요.', '태그 항목은 2개 이상 선택해 주세요.',
    ]);
    const upper = createFormState({}, [issue('tags', 'MAX_ITEMS', 'This deliberately says no numeric bound')], { messages });
    expect(upper.fieldErrors.tags).toEqual(['태그 항목은 3개 이하로 선택해 주세요.']);
    expect(createFormState({}, [issue('tags', 'MAX_LENGTH', 'not parsed')], { messages }).fieldErrors.tags).toEqual(['태그 항목은 4자 이하로 입력해 주세요.']);
  });

  it('preserves opaque vendor/unknown messages and explicit host override precedence', () => {
    const messages = createFormMessages('ko');
    const issues = [issue('name', 'SCHEMA', 'vendor-localized message'), issue(null, 'CUSTOM', 'application error'), issue('name', 'REQUIRED')];
    const state = createFormState({}, issues, { messages: { ...messages, REQUIRED: '호스트 문구' } });
    expect(state.issues.map((item) => item.message)).toEqual(['vendor-localized message', 'application error', '호스트 문구']);
    expect(createFormState({}, [issue('name', 'REQUIRED')], { messages, message: () => '최종 재정의' }).fieldErrors.name).toEqual(['최종 재정의']);
    expect(Object.hasOwn(messages, 'SCHEMA')).toBe(false);
    expect(createFormState({}, [issue('name', 'MIN_LENGTH', 'bounds 9999')], { messages }).fieldErrors.name).toEqual(['name 입력값이 너무 짧습니다.']);
    // Setting metadata alone does not automatically translate any validation response.
    expect(createFormState({}, issues, { locale: 'ko' }).issues).toEqual(issues);
  });

  it('snapshots labels/constraints, handles prototype-like names, and leaves escaping to the renderer', () => {
    const fields = { name: { type: 'string' as const, minLength: 0, maxLength: 2 } };
    const labels = { name: '<이름>' };
    const messages = createFormMessages('ko', { fields, labels });
    fields.name.maxLength = 999;
    labels.name = 'changed';
    const state = createFormState({}, [issue('name', 'MAX_LENGTH')], { messages });
    expect(state.fieldErrors.name).toEqual(['<이름> 항목은 2자 이하로 입력해 주세요.']);
    expect(renderFieldErrors(state, 'name')).toContain('&lt;이름&gt;');
    expect(Object.isFrozen(messages)).toBe(true);
    const prototypeLabels = Object.fromEntries([['__proto__', '특수 필드']]);
    expect(createFormState({}, [issue('__proto__', 'REQUIRED')], { messages: createFormMessages('ko', { labels: prototypeLabels }) }).fieldErrors.__proto__).toEqual(['특수 필드 항목을 입력해 주세요.']);
    expect(() => createFormMessages('fr')).toThrow('unsupported');
    expect(() => createFormMessages('')).toThrow();
    expect(() => createFormMessages('ko', { labels: { name: 1 as unknown as string } })).toThrow('labels');
  });

  it('provides all built-in code messages in both languages, including zero bounds and literals', () => {
    const fields: FormFields = {
      value: { type: 'string', minLength: 0, maxLength: 0, const: '"x"' },
      count: { type: 'integer', minimum: 0, maximum: 0, const: 0 },
      list: { type: 'array', minItems: 0, maxItems: 0, items: { type: 'integer', minimum: 0, maximum: 0 } },
    };
    for (const locale of ['en', 'ko']) {
      const messages = createFormMessages(locale, { fields });
      for (const code of Object.keys(messages)) {
        const field = ['MINIMUM', 'MAXIMUM'].includes(code) ? 'count' : ['MIN_ITEMS', 'MAX_ITEMS'].includes(code) ? 'list' : 'value';
        const text = createFormState({}, [issue(field, code)], { messages }).fieldErrors[field]![0]!;
        expect(text).not.toBe('original vendor text');
        expect(text.length).toBeGreaterThan(0);
      }
      expect(createFormState({}, [issue('count', 'CONST')], { messages }).fieldErrors.count![0]).toContain('0');
      expect(createFormState({}, [issue('value', 'CONST')], { messages }).fieldErrors.value![0]).toContain(JSON.stringify('"x"'));
      expect(createFormState({}, [issue('list', 'MIN_ITEMS')], { messages }).fieldErrors.list![0]).toContain('0');
      expect(createFormState({}, [issue('value', 'MIN_LENGTH')], { messages }).fieldErrors.value![0]).toContain('0');
    }
  });
});
