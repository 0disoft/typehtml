import type { HtmlEntry } from './html.ts';
import type { SourceLocation } from './types.ts';

export interface IndexedEntries {
  readonly first: HtmlEntry;
  readonly locations: readonly SourceLocation[];
}

/** One owned index retains the first entry and every location in collection order. */
export function indexEntries(entries: readonly HtmlEntry[]): ReadonlyMap<string, IndexedEntries> {
  const byName = new Map<string, { first: HtmlEntry; locations: SourceLocation[] }>();
  for (const entry of entries) {
    const existing = byName.get(entry.name);
    if (existing) existing.locations.push(entry.control.location);
    else byName.set(entry.name, { first: entry, locations: [entry.control.location] });
  }
  return byName;
}
