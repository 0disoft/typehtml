/** Bounded, in-memory reference only. Not an HTTP handler or a complete validator. */
export class WireError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'WireError'; }
}
export type WireLimits = Readonly<{ maxBytes: number; maxEntries: number; maxKeyBytes: number; maxValueBytes: number }>;
export const referenceLimits: WireLimits = Object.freeze({ maxBytes: 16384, maxEntries: 16, maxKeyBytes: 64, maxValueBytes: 1024 });
const encoder = new TextEncoder();
const keySyntax = /^(?:[A-Za-z][A-Za-z0-9_]*|_bc_csrf|_bc_request)$/;
const deniedKeys = new Set(['__proto__', 'constructor', 'prototype']);
function hex(b: number): number {
  if (b >= 48 && b <= 57) return b - 48;
  if (b >= 65 && b <= 70) return b - 55;
  if (b >= 97 && b <= 102) return b - 87;
  return -1;
}
function decodePart(bytes: Uint8Array): string {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 37) {
      const a = bytes[i + 1], c = bytes[i + 2];
      if (a === undefined || c === undefined || hex(a) < 0 || hex(c) < 0) throw new WireError('INVALID_PERCENT');
      out.push(hex(a) * 16 + hex(c)); i += 2;
    } else out.push(b === 43 ? 32 : b);
  }
  let text: string;
  try {
    // ignoreBOM=true preserves a leading U+FEFF as data; it does not strip it.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new Uint8Array(out));
  } catch { throw new WireError('INVALID_UTF8'); }
  if (text.includes('\u0000')) throw new WireError('NUL_NOT_ALLOWED');
  return text;
}
export function parseWire(bytes: Uint8Array, limits: WireLimits = referenceLimits): readonly (readonly [string, string])[] {
  if (bytes.byteLength > limits.maxBytes) throw new WireError('BODY_TOO_LARGE');
  const entries: (readonly [string, string])[] = [];
  const seen = new Set<string>();
  let start = 0;
  for (let end = 0; end <= bytes.length; end++) {
    if (end < bytes.length && bytes[end] !== 38) continue;
    if (end > start) {
      if (entries.length >= limits.maxEntries) throw new WireError('TOO_MANY_ENTRIES');
      let split = start;
      while (split < end && bytes[split] !== 61) split++;
      const key = decodePart(bytes.subarray(start, split));
      const value = decodePart(bytes.subarray(split < end ? split + 1 : end, end));
      if (!keySyntax.test(key) || deniedKeys.has(key)) throw new WireError('INVALID_KEY');
      if (encoder.encode(key).length > limits.maxKeyBytes) throw new WireError('KEY_TOO_LARGE');
      if (encoder.encode(value).length > limits.maxValueBytes) throw new WireError('VALUE_TOO_LARGE');
      if (seen.has(key)) throw new WireError('DUPLICATE_KEY');
      seen.add(key); entries.push(Object.freeze([key, value] as const));
    }
    start = end + 1;
  }
  return Object.freeze(entries);
}
export function decimalInteger(raw: string): number {
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(raw)) throw new WireError('INVALID_INTEGER_SYNTAX');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new WireError('INTEGER_RANGE');
  return value;
}
export function canonicalInput(input: Readonly<Record<string, string | number>>): string {
  const entries = Object.keys(input).sort().map(key => {
    const value = input[key];
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new WireError('INVALID_DOMAIN_INTEGER');
      return [key, 'integer', value];
    }
    if (typeof value !== 'string') throw new WireError('INVALID_DOMAIN_VALUE');
    // Validated input contains scalar values. Reject lone surrogates instead of replacing them.
    if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(encoder.encode(value)) !== value) throw new WireError('INVALID_DOMAIN_UNICODE');
    return [key, 'string', value];
  });
  return JSON.stringify(['bc-input/1', entries]);
}
export function lengthUnits(text: string): Readonly<{ codePoints: number; utf16: number; utf8: number }> {
  return { codePoints: [...text].length, utf16: text.length, utf8: encoder.encode(text).length };
}
