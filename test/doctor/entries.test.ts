import { describe, expect, test } from 'bun:test';
import { indexEntries } from '../../src/doctor/entries.ts';
import { collectFormEntries, parseHtmlDocument } from '../../src/doctor/html.ts';

describe('Doctor entry indexing', () => {
  test('preserves first entries, duplicates, and every location without mutating the collection', () => {
    const form = parseHtmlDocument('<form><input name="b"><input name="a"><input name="b"><button name="a">Go</button></form>', 'https://example.test').forms[0]!;
    const collection = collectFormEntries(form, form.controls[3]!);
    for (const entry of collection.entries) Object.freeze(entry);
    Object.freeze(collection.entries);
    const indexed = indexEntries(collection.entries);
    expect([...indexed.keys()]).toEqual(['b', 'a']);
    expect(indexed.get('b')?.first).toBe(collection.entries[0]);
    expect(indexed.get('a')?.first).toBe(collection.entries[1]);
    expect(indexed.get('b')?.locations).toEqual([form.controls[0]!.location, form.controls[2]!.location]);
    expect(indexed.get('a')?.locations).toEqual([form.controls[1]!.location, form.controls[3]!.location]);
    expect(indexed.get('missing')).toBeUndefined();
    expect(collection.entries).toHaveLength(4);
  });

  test('indexes and looks up a thousand fields with only two name reads per entry', () => {
    const count = 1000;
    const html = '<form>' + Array.from({ length: count }, (_, i) => `<input name="f${i}">`).join('') + '</form>';
    const collection = collectFormEntries(parseHtmlDocument(html, 'https://example.test').forms[0]!, null);
    let reads = 0;
    const entries = collection.entries.map((entry) => Object.freeze({
      ...entry, get name() { reads++; return entry.name; },
    }));
    const indexed = indexEntries(Object.freeze(entries));
    for (let i = 0; i < count; i++) expect(indexed.get(`f${i}`)?.first.control).toBe(entries[i]!.control);
    expect(reads).toBe(2 * count);
    expect(indexEntries([]).size).toBe(0);
  });
});
