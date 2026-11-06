import { describe, expect, test } from 'bun:test';
import { collectFormEntries, parseHtmlDocument } from '../../src/doctor/html.ts';

function collect(html: string, skipValidation = false) {
  const form = parseHtmlDocument(`<form>${html}</form>`, 'https://example.test').forms[0]!;
  return collectFormEntries(form, null, skipValidation);
}

describe('Doctor native choice controls', () => {
  test('reads textarea text, decoded entities and native line endings', () => {
    const result = collect('<textarea name="message">\nA&amp;B\nC</textarea>');
    expect(result.entries.map(({ name, value }) => [name, value])).toEqual([['message', 'A&B\r\nC']]);
    expect(result.unsupportedControls).toHaveLength(0);
  });

  test('counts radio groups once but detects collisions with another scalar', () => {
    const result = collect('<input type="radio" name="choice" required value="a"><input type="radio" name="choice" value="b" checked><input name="choice">');
    expect(result.entries.map((entry) => entry.value)).toEqual(['b', '']);
    expect(result.possibleCounts.get('choice')).toBe(2);
    expect(result.conditionalNames.has('choice')).toBe(false);
    expect(collect('<input type="radio" name="x" value="a"><input type="radio" name="x" value="b">').conditionalNames.has('x')).toBe(true);
  });

  test('optional choices remain conditional, required validation is activation-specific', () => {
    const html = '<input type="checkbox" name="accept" required><input type="checkbox" name="news" checked>';
    const result = collect(html);
    expect(result.entries.map((entry) => entry.value)).toEqual(['on', 'on']);
    expect([...result.conditionalNames]).toEqual(['news']);
    expect([...collect(html, true).conditionalNames]).toEqual(['accept', 'news']);
  });

  test('select ignores disabled options and optgroups and tracks multiple cardinality', () => {
    const html = '<select name="one"><option disabled value="x">X</option><optgroup disabled><option value="y">Y</option></optgroup><option> A  B </option><option selected value="z">Z</option></select>';
    expect(collect(html).entries[0]?.value).toBe('z');
    const multiple = collect('<select multiple name="tags" required><option>a</option><option>b</option><option disabled>c</option></select>');
    expect(multiple.possibleCounts.get('tags')).toBe(2);
    expect(multiple.conditionalNames.has('tags')).toBe(false);
    expect(collect('<select name="none"></select>').entries).toEqual([]);
  });

  test('keeps unsupported file controls and dirname explicit', () => {
    const result = collect('<textarea name="message" dirname="direction"></textarea><input type="file" name="file">');
    expect([...result.unsupportedNames]).toEqual(['message', 'direction', 'file']);
    expect(result.unsupportedControls.map((item) => item.reason)).toEqual(['dirname', 'file-input']);
  });

  test('does not claim disabled selected options guarantee supply, and preserves non-ASCII whitespace', () => {
    const result = collect('<select name="choice" required><option disabled selected value="a">A</option><option>B</option></select>');
    expect(result.possibleCounts.get('choice')).toBe(1);
    expect(result.conditionalNames.has('choice')).toBe(true);
    expect(collect('<select name="space"><option> &nbsp; X &nbsp; </option></select>').entries[0]?.value).toBe('\u00a0 X \u00a0');
  });
});
