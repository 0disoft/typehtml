import { describe, expect, test } from 'bun:test';
import { parseHtmlDocument } from '../../src/doctor/html.ts';

const URL = 'https://example.test/forms';

describe('indexed HTML form facts', () => {
  test('preserves document/control order, first-ID ownership, and duplicate form facts', () => {
    const parsed = parseHtmlDocument(`<input name="before" form="same">
      <form id="same"><input name="first"><input name="empty" form=""></form>
      <form id="same"><input name="second"></form><input name="after" form="same">
      <div id="shadow"></div><form id="shadow"><input name="implicit"><input name="explicit" form="shadow"></form>`, URL);
    expect(parsed.forms.map((form) => form.id)).toEqual(['same', 'same', 'shadow']);
    expect(parsed.forms.map((form) => form.controls.map((control) => control.name)))
      .toEqual([['before', 'first', 'after'], ['second'], ['implicit']]);
    expect(parsed.forms.map((form) => form.order)).toEqual([4, 7, 11]);
    expect(parsed.controls.map((control) => control.order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parsed.formIds.get('same')).toEqual(parsed.forms.slice(0, 2));
    expect(parsed.formIds.get('same')![0]).toBe(parsed.forms[0]);
    expect([...parsed.duplicateIds]).toEqual(['same', 'shadow']);
  });

  test('retains first-occurrence order when IDs become duplicated in a different order', () => {
    const parsed = parseHtmlDocument('<div id="a"></div><div id="b"></div><div id="b"></div><div id="a"></div>', URL);
    expect([...parsed.duplicateIds]).toEqual(['a', 'b']);
  });

  test('preserves missing versus empty form IDs and custom-element attributes', () => {
    const missing = parseHtmlDocument('<form></form><form id=""></form><form id="named"></form><x-field></x-field>', URL);
    expect(missing.forms.map((form) => form.id)).toEqual([null, null, 'named']);
    expect(missing.forms.map((form) => form.hasDynamicControls)).toEqual([true, false, false]);
    const empty = parseHtmlDocument('<form></form><form id=""></form><form id="named"></form><x-field form=""></x-field>', URL);
    expect(empty.forms.map((form) => form.hasDynamicControls)).toEqual([false, true, false]);
    expect([...empty.formIds.keys()]).toEqual(['named']);
  });

  test('indexes custom-element descendants and explicit associations for every matching form', () => {
    const parsed = parseHtmlDocument(`<div id="same"></div><form id="same"></form><form id="same"></form>
      <form id="inside"><div><x-field form="other"></x-field></div></form>
      <form id="other"></form><form id="none"></form><x-field form="same"></x-field>`, URL);
    expect(parsed.forms.map((form) => [form.id, form.hasDynamicControls]))
      .toEqual([['same', true], ['same', true], ['inside', true], ['other', true], ['none', false]]);
  });

  test('keeps template/datalist exclusion and disabled-fieldset legend semantics', () => {
    const parsed = parseHtmlDocument(`<base href="/base/"><form id="form"><fieldset disabled>
      <legend><input name="first-legend"></legend><legend><input name="second-legend"></legend><input name="disabled">
      </fieldset><datalist><input name="excluded"><x-field></x-field></datalist></form>
      <form id="template-only"><template><x-field form="template-only"></x-field><input name="hidden"><script></script></template></form>`, URL);
    expect(parsed.forms[0]!.controls.map((control) => [control.name, control.disabled]))
      .toEqual([['first-legend', false], ['second-legend', true], ['disabled', true]]);
    expect(parsed.forms.map((form) => form.hasDynamicControls)).toEqual([true, false]);
    expect(parsed.controls).toHaveLength(3);
    expect(parsed.hasScript).toBe(false);
    expect(parsed.baseUrl).toBe('https://example.test/base/');
  });

  test('does not repeat whole-document or form-fact searches for each form', () => {
    const count = 500;
    const html = Array.from({ length: count }, (_, index) => `<form id="f${index}"><input name="value"></form>`).join('');
    const descriptors = ['indexOf', 'some', 'find'].map((name) => [name, Object.getOwnPropertyDescriptor(Array.prototype, name)!] as const);
    let documentVisits = 0;
    let formFactVisits = 0;
    for (const [name, descriptor] of descriptors) {
      const original = descriptor.value;
      Object.defineProperty(Array.prototype, name, {
        ...descriptor,
        value: function (this: any[], callback: any, thisArg?: unknown) {
          const document = this[0]?.tagName === 'html';
          const facts = this[0]?.element?.tagName === 'form';
          if (name === 'indexOf') {
            if (document && callback?.tagName === 'form') documentVisits += this.length;
            return original.call(this, callback, thisArg);
          }
          return original.call(this, (value: unknown, index: number, array: unknown[]) => {
            if (document) documentVisits++;
            if (facts) formFactVisits++;
            return Reflect.apply(callback, thisArg, [value, index, array]);
          });
        },
      });
    }
    let parsed;
    try { parsed = parseHtmlDocument(html, URL); }
    finally { for (const [name, descriptor] of descriptors) Object.defineProperty(Array.prototype, name, descriptor); }
    expect(parsed.forms).toHaveLength(count);
    expect(parsed.formIds.size).toBe(count);
    expect(documentVisits).toBeLessThanOrEqual((2 * count + 3) * 3);
    expect(formFactVisits).toBeLessThanOrEqual(count * 3);
  });

  test('does not repeatedly copy the growing bucket of duplicate IDs', () => {
    const count = 2000;
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!;
    const original = descriptor.value;
    let copiedReferences = 0;
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      ...descriptor,
      value: function* (this: any[]) {
        const bucket = this[0]?.tagName === 'div' && this[0]?.attrs?.[0]?.value === 'duplicate';
        const iterator = original.call(this);
        for (let step = iterator.next(); !step.done; step = iterator.next()) {
          if (bucket) copiedReferences++;
          yield step.value;
        }
      },
    });
    let parsed;
    try { parsed = parseHtmlDocument('<div id="duplicate"></div>'.repeat(count), URL); }
    finally { Object.defineProperty(Array.prototype, Symbol.iterator, descriptor); }
    expect([...parsed.duplicateIds]).toEqual(['duplicate']);
    expect(copiedReferences).toBeLessThanOrEqual(count * 2);
  });
});
