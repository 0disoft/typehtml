/**
 * Canonical JSON for contract behavior digests.
 *
 * The contract subset is JSON without floats. This serializer intentionally
 * differs from JSON.stringify in one observable way: object keys are sorted by
 * Unicode code point, matching the reference Python implementation. Arrays
 * keep their order. No ASCII escaping is performed for non-ASCII strings.
 */

export type CanonicalJsonErrorCode =
  | 'UNSUPPORTED_VALUE'
  | 'INVALID_NUMBER'
  | 'INVALID_UNICODE';

export class CanonicalJsonError extends Error {
  readonly code: CanonicalJsonErrorCode;

  constructor(code: CanonicalJsonErrorCode, message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
    this.code = code;
  }
}

const encoder = new TextEncoder();

function assertNoLoneSurrogates(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalJsonError('INVALID_UNICODE', 'lone high surrogate');
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalJsonError('INVALID_UNICODE', 'lone low surrogate');
    }
  }
}

function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const av = ai.next();
    const bv = bi.next();
    if (av.done && bv.done) return 0;
    if (av.done) return -1;
    if (bv.done) return 1;
    const ac = av.value.codePointAt(0)!;
    const bc = bv.value.codePointAt(0)!;
    if (ac !== bc) return ac - bc;
  }
}

function serializeString(value: string, path: string): string {
  assertNoLoneSurrogates(value);
  // JSON.stringify is used only after the surrogate check. It escapes control
  // characters and quotes exactly like the reference JSON encoder.
  return JSON.stringify(value);
}

function serializeNumber(value: number, path: string): string {
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
    throw new CanonicalJsonError('INVALID_NUMBER', `invalid contract number at ${path}`);
  }
  return String(value);
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value, path);
    case 'string':
      return serializeString(value, path);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError('UNSUPPORTED_VALUE', `unsupported value at ${path}`);
  }

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new CanonicalJsonError('UNSUPPORTED_VALUE', `array hole at ${path}[${i}]`);
      }
      parts.push(serialize(value[i], `${path}[${i}]`));
    }
    return `[${parts.join(',')}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError('UNSUPPORTED_VALUE', `non-plain object at ${path}`);
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCodePoints);
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`${serializeString(key, path)}:${serialize(record[key], `${path}.${key}`)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Serialize a JSON value with sorted object keys and no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

/** UTF-8 bytes of the canonical JSON, suitable for SHA-256. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value));
}
