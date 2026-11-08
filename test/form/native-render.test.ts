import { describe, expect, it } from 'bun:test';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { z } from 'zod';
import { defineSchemaForm } from '../../src/form/schema-form.ts';
import { createFormState } from '../../src/form/state.ts';
import { getSchemaFieldId } from '../../src/form/schema-html.ts';
import { focusNativeErrorSummary, renderNativeErrorSummary, renderNativeField, renderNativeFields, renderNativeForm } from '../../src/form/native-render.ts';

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;
const attr = (element: Element, name: string) => element.attrs.find((item) => item.name === name)?.value;
const text = (node: Node): string => 'value' in node ? node.value : 'childNodes' in node ? node.childNodes.map(text).join('') : '';
function elements(html: string): Element[] {
  const result: Element[] = [];
  function visit(node: Node): void { if ('tagName' in node) result.push(node); if ('childNodes' in node) node.childNodes.forEach(visit); }
  visit(parse(html));
  return result;
}
function successful(html: string): readonly (readonly [string, string])[] {
  const result: [string, string][] = [];
  for (const element of elements(html)) {
    const name = attr(element, 'name');
    if (name === undefined || attr(element, 'disabled') !== undefined) continue;
    if (element.tagName === 'input') {
      const type = attr(element, 'type') ?? 'text';
      if (['submit', 'button', 'reset', 'file'].includes(type) || ['checkbox', 'radio'].includes(type) && attr(element, 'checked') === undefined) continue;
      const value = attr(element, 'value') ?? (['checkbox', 'radio'].includes(type) ? 'on' : '');
      result.push([name, type === 'text' ? value.replace(/[\r\n]/g, '') : value]);
    } else if (element.tagName === 'textarea') result.push([name, text(element)]);
    else if (element.tagName === 'select') {
      const options = element.childNodes.filter((node): node is Element => 'tagName' in node && node.tagName === 'option');
      const selected = options.filter((option) => attr(option, 'selected') !== undefined);
      for (const option of selected.length === 0 && attr(element, 'multiple') === undefined ? options.slice(0, 1) : selected) if (attr(option, 'disabled') === undefined) result.push([name, attr(option, 'value') ?? text(option)]);
    }
  }
  return result;
}

const form = defineSchemaForm({
  id: 'native.edit', path: '/edit', fields: {
    name: { type: 'string', required: true, minLength: 1 },
    optional: { type: 'string', minLength: 1 },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    accepted: { type: 'boolean', trueValue: 'yes', falseValue: 'no' },
    channel: { type: 'string', enum: ['email', 'paper'], control: 'radio' },
    color: { type: 'string', enum: ['red', 'blue'], control: 'select' },
    note: { type: 'string', control: 'textarea' },
  }, input: z.unknown(), output: z.unknown(),
});

describe('shared native initial/invalid rendering', () => {
  it('round-trips repeated order, duplicates, multiline text, false tokens, invalid choices, and protocol keys', () => {
    const raw = {
      name: '<Ada "&">', tags: ['b', 'a', 'b', '\nfirst\nlast'], accepted: 'no',
      channel: 'unknown<script>', color: 'green', note: '\n</textarea><script>x</script>',
    };
    const state = createFormState(raw, [{ field: 'name', code: 'BAD', message: '<fix name>' }]);
    const html = renderNativeForm(form, '<csrf>', { state, mode: 'invalid', requestKey: '<request>', fields: {
      name: { label: '<Name>', hint: 'Use <full> name' },
      color: { choices: [{ value: 'red', label: '<Red>' }, { value: 'blue', label: 'Blue' }] },
    } });
    const entries = successful(html);
    for (const [name, value] of Object.entries(raw)) expect(entries.filter(([key]) => key === name).map(([, item]) => item)).toEqual(typeof value === 'string' ? [value] : value);
    expect(entries).toContainEqual(['_bc_csrf', '<csrf>']);
    expect(entries).toContainEqual(['_bc_request', '<request>']);
    expect(entries.some(([name]) => name === 'optional')).toBe(false);
    expect(elements(html).some(({ tagName }) => tagName === 'script')).toBe(false);
    expect(html).toContain('&lt;Name&gt;');
    expect(html).toContain('&lt;Red&gt;');
    const input = elements(html).find((element) => attr(element, 'name') === 'name')!;
    const described = attr(input, 'aria-describedby')!.split(' ');
    expect(described).toEqual([`${attr(input, 'id')}-hint`, `${attr(input, 'id')}-error`]);
    expect(described.every((id) => elements(html).some((element) => attr(element, 'id') === id))).toBe(true);
    expect(raw.tags).toEqual(['b', 'a', 'b', '\nfirst\nlast']);
  });

  it('shares labels/control markup between initial and invalid states while omitting never-submitted optional scalars', () => {
    const fields = { name: { label: 'Your name', hint: 'Full name', id: 'custom-name' } };
    const initial = renderNativeForm(form, 'token', { fields });
    expect(elements(initial).find((element) => attr(element, 'name') === 'optional')).toBeDefined();
    expect(initial).toContain('<label for="custom-name">Your name</label>');
    const invalid = renderNativeForm(form, 'token', { fields, mode: 'invalid', state: createFormState({ name: '' }, [{ field: 'name', code: 'REQUIRED', message: 'Enter name' }]) });
    expect(invalid).toContain('<label for="custom-name">Your name</label>');
    expect(invalid).toContain('href="#custom-name"');
    expect(invalid).toContain('id="custom-name-error"');
    expect(elements(invalid).find((element) => attr(element, 'name') === 'optional')).toBeUndefined();
    expect(elements(initial).filter((element) => attr(element, 'name') === 'tags')).toHaveLength(0);
  });

  it('uses stable collection identities across row reorder and never renders absent rows up to maxItems', () => {
    const rows = defineSchemaForm({ id: 'rows.edit', path: '/rows', fields: {}, collections: {
      items: { rowKey: 'key', maxItems: 3, fields: { key: { type: 'string', required: true, minLength: 1, maxLength: 32 }, label: { type: 'string', required: true } } },
    }, input: z.unknown(), output: z.unknown() });
    const first = createFormState({ 'items[0].key': 'alpha', 'items[0].label': 'A', 'items[1].key': 'beta', 'items[1].label': 'B' }, []);
    const reordered = createFormState({ 'items[0].key': 'beta', 'items[0].label': 'B', 'items[1].key': 'alpha', 'items[1].label': 'A' }, [{ field: 'items[1].label', code: 'BAD', message: 'Fix A' }]);
    const id = getSchemaFieldId(rows, 'items[0].label', first);
    expect(getSchemaFieldId(rows, 'items[1].label', reordered)).toBe(id);
    const html = renderNativeForm(rows, 'token', { state: reordered, mode: 'invalid' });
    expect(html).toContain(`href="#${id}"`);
    expect(html).toContain(`id="${id}-error"`);
    expect(successful(html).filter(([name]) => name.startsWith('items'))).toEqual([
      ['items[0].key', 'beta'], ['items[0].label', 'B'], ['items[1].key', 'alpha'], ['items[1].label', 'A'],
    ]);
    expect(html).not.toContain('items[2]');
    expect(renderNativeFields(rows, createFormState({}, []))).toBe('');
    expect(() => renderNativeField(rows, 'items[3].key', first)).toThrow('unknown form field');
    const duplicate = createFormState({ 'items[0].key': 'same', 'items[0].label': 'A', 'items[1].key': 'same', 'items[1].label': 'B' }, [
      { field: 'items[1].key', code: 'DUPLICATE_ROW_KEY', message: 'Use a different identity' },
    ]);
    const duplicateHtml = renderNativeForm(rows, 'token', { state: duplicate, mode: 'invalid' });
    const ids = elements(duplicateHtml).flatMap((element) => attr(element, 'id') === undefined ? [] : [attr(element, 'id')!]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getSchemaFieldId(rows, 'items[0].key', duplicate)).not.toBe(getSchemaFieldId(rows, 'items[1].key', duplicate));
  });

  it('links every repeated/radio control to one real error element and rejects ambiguous choices/names', () => {
    const state = createFormState({ tags: ['x', 'x'], channel: 'paper' }, [
      { field: 'tags', code: 'BAD', message: 'Fix tags' }, { field: 'channel', code: 'BAD', message: 'Fix channel' },
    ]);
    const html = renderNativeForm(form, 'token', { state, mode: 'invalid' });
    const nodes = elements(html);
    for (const element of nodes.filter((node) => ['input', 'select', 'textarea'].includes(node.tagName))) {
      for (const id of attr(element, 'aria-describedby')?.split(' ') ?? []) expect(nodes.filter((node) => attr(node, 'id') === id)).toHaveLength(1);
    }
    expect(() => renderNativeField(form, 'color', state, { choices: [{ value: 'a' }, { value: 'a' }] })).toThrow('unique');
    expect(() => renderNativeFields(form, state, { names: ['name', 'name'] })).toThrow('unique');
    expect(() => renderNativeField(form, '__proto__', state)).toThrow('unknown form field');
  });

  it('keeps constant selections and does not turn an absent unchecked boolean into a selected true token', () => {
    const constants = defineSchemaForm({ id: 'constant.edit', path: '/constant', fields: {
      fixed: { type: 'string', const: 'keep', required: true, control: 'select' },
      enabled: { type: 'boolean' },
      count: { type: 'integer' },
      aliases: { type: 'string', enum: ['a', 'a'], control: 'select' },
    }, input: z.unknown(), output: z.unknown() });
    expect(successful(renderNativeForm(constants, 'token'))).toContainEqual(['fixed', 'keep']);
    expect(successful(renderNativeForm(constants, 'token'))).not.toContainEqual(['enabled', 'on']);
    expect(() => renderNativeField(constants, 'enabled', undefined, { control: 'select' })).toThrow('falseValue');
    const rejected = renderNativeField(constants, 'count', createFormState({ count: '-0not-a-number' }, []), { control: 'number' });
    expect(rejected).toContain('type="text"');
    expect(successful(rejected)).toEqual([['count', '-0not-a-number']]);
    const aliases = renderNativeField(constants, 'aliases', createFormState({ aliases: 'a' }, []));
    expect(successful(aliases)).toEqual([['aliases', 'a']]);
    expect(elements(aliases).filter((element) => element.tagName === 'option' && attr(element, 'value') === 'a')).toHaveLength(1);
  });

  it('renders declared file props with multipart encoding and never redisplays a submitted file value', () => {
    const uploads = defineSchemaForm({ id: 'files.edit', path: '/files', fields: {}, uploads: {
      documents: { required: true, multiple: true, accept: ['.txt', 'text/plain'], maxFiles: 3 },
    }, multipart: {}, input: z.unknown(), output: z.unknown() });
    const html = renderNativeForm(uploads, 'token', { state: createFormState({ documents: 'C:\\private\\secret.txt' }, [
      { field: 'documents', code: 'BAD', message: 'Reselect file' },
    ]), mode: 'invalid', fields: { documents: { label: 'Attachments', id: 'upload-file', hint: 'Select text files' } } });
    const nodes = elements(html);
    const form = nodes.find((element) => element.tagName === 'form')!;
    const input = nodes.find((element) => attr(element, 'name') === 'documents')!;
    expect(attr(form, 'enctype')).toBe('multipart/form-data');
    expect(attr(input, 'type')).toBe('file');
    expect(attr(input, 'multiple')).toBe('');
    expect(attr(input, 'required')).toBe('');
    expect(attr(input, 'accept')).toBe('.txt,text/plain');
    expect(attr(input, 'value')).toBeUndefined();
    expect(attr(input, 'aria-describedby')).toBe('upload-file-hint upload-file-error');
    expect(html).not.toContain('secret.txt');
    expect(() => renderNativeField(uploads, 'documents', undefined, { control: 'text' })).toThrow('file controls');
  });

  it('uses select/checkbox choices only when native submission preserves the exact repeated sequence', () => {
    const choices = [{ value: 'a', label: '<Alpha>' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Gamma', disabled: true }];
    const selections = defineSchemaForm({ id: 'choices.edit', path: '/choices', fields: {
      tags: { type: 'array', items: { type: 'string' }, control: 'select' },
      checks: { type: 'array', items: { type: 'string' }, control: 'checkbox' },
    }, input: z.unknown(), output: z.unknown() });
    for (const name of ['tags', 'checks'] as const) {
      for (const values of [[], ['a', 'b'], ['b', 'a'], ['a', 'a'], ['unknown'], ['c']]) {
        const html = renderNativeField(selections, name, createFormState({ [name]: values }, []), { choices });
        expect(successful(html)).toEqual(values.map((value) => [name, value]));
        const nodes = elements(html);
        const native = values.length === 0 || values.join(',') === 'a,b';
        if (native && name === 'tags') expect(nodes.some((element) => element.tagName === 'select')).toBe(true);
        else if (native) expect(nodes.filter((element) => attr(element, 'type') === 'checkbox')).toHaveLength(3);
        else expect(nodes.filter((element) => attr(element, 'type') === 'text')).toHaveLength(values.length);
        expect(html).not.toContain('<Alpha>');
      }
    }
  });

  it('makes summaries focusable with an explicit host focus call and optional native autofocus', () => {
    const state = createFormState({}, [{ field: null, code: 'FORM', message: 'Try again' }]);
    const html = renderNativeErrorSummary(state, { id: 'errors', autofocus: true });
    const section = elements(html).find((element) => element.tagName === 'section')!;
    expect(attr(section, 'tabindex')).toBe('-1');
    expect(attr(section, 'id')).toBe('errors');
    expect(attr(section, 'autofocus')).toBe('');
    expect(attr(section, 'aria-labelledby')).toBe('errors-title');
    expect(renderNativeErrorSummary(createFormState({}, []))).toBe('');
    expect(renderNativeErrorSummary(state)).not.toContain(' autofocus');
    let focusCalls = 0;
    let received: FocusOptions | undefined;
    const root = { querySelector<T>() { return { focus(options: FocusOptions) { focusCalls++; received = options; } } as T; } };
    expect(focusNativeErrorSummary(root, { preventScroll: true })).toBe(true);
    expect(focusCalls).toBe(1);
    expect(received).toEqual({ preventScroll: true });
    expect(focusNativeErrorSummary({ querySelector: () => null })).toBe(false);
  });
});
