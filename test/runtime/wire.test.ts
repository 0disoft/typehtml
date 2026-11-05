import { describe, expect, test } from 'bun:test';
import { readUrlEncodedForm, formReadOptions, WireError } from '../../src/runtime/wire.ts';
import { SUPPORTED_CSRF_FIELD, SUPPORTED_REQUEST_KEY_FIELD } from '../../src/contract/types.ts';

const http = {
  method: 'POST' as const,
  path: '/actions/orders/create-draft',
  body: 'urlencoded' as const,
  maxBytes: 16384,
  maxEntries: 16,
  maxKeyBytes: 64,
  maxValueBytes: 1024,
  charset: 'utf-8' as const,
  contentEncoding: 'identity-only' as const,
  parserProfile: 'strict-urlencoded-utf8/1',
};
const protocol = {
  csrfField: SUPPORTED_CSRF_FIELD,
  requestKeyField: SUPPORTED_REQUEST_KEY_FIELD,
  countProtocolEntries: true as const,
};

async function parse(
  raw: string | Uint8Array,
  options: { expectRequestKey?: boolean; contentType?: string; contentEncoding?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/x-www-form-urlencoded',
    ...(options.contentEncoding ? { 'content-encoding': options.contentEncoding } : {}),
    ...options.headers,
  };
  const body =
    typeof raw === 'string'
      ? raw
      : (raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
  const request = new Request('http://example.test/actions/orders/create-draft', {
    method: 'POST',
    headers,
    body,
  });
  return readUrlEncodedForm(request, formReadOptions(http, protocol, options.expectRequestKey ?? false));
}

describe('strict urlencoded parser', () => {
  test('decodes plus and percent escapes and separates protocol fields', async () => {
    const form = await parse('_bc_csrf=tok&quantity=2&productId=p_100');
    expect(form.csrf).toBe('tok');
    expect(form.requestKey).toBeNull();
    expect(form.fields).toEqual({ quantity: '2', productId: 'p_100' });
    expect(form.entries.map((entry) => entry.key)).toEqual(['_bc_csrf', 'quantity', 'productId']);
  });

  test('preserves empty strings and a leading BOM as data', async () => {
    const form = await parse('_bc_csrf=tok&quantity=&productId=%EF%BB%BFp');
    expect(form.fields.quantity).toBe('');
    expect(form.fields.productId).toBe('\uFEFFp');
  });

  test('requires a request key only for existing intents', async () => {
    await expect(parse('_bc_csrf=tok&_bc_request=draft_1&quantity=2', { expectRequestKey: true })).resolves.toMatchObject({
      requestKey: 'draft_1',
    });
    await expect(parse('_bc_csrf=tok&_bc_request=draft_1&quantity=2')).rejects.toMatchObject({ code: 'UNEXPECTED_REQUEST_KEY' });
    await expect(parse('_bc_csrf=tok&quantity=2', { expectRequestKey: true })).rejects.toMatchObject({ code: 'MISSING_REQUEST_KEY' });
  });

  test('rejects duplicates after percent decoding', async () => {
    for (const raw of ['_bc_csrf=tok&quantity=1&quantity=2', '_bc_csrf=tok&quantity=1&%71uantity=2']) {
      await expect(parse(raw)).rejects.toBeInstanceOf(WireError);
      await expect(parse(raw)).rejects.toMatchObject({ code: 'DUPLICATE_KEY', status: 400 });
    }
  });

  test('rejects prototype keys, unknown reserved, and legacy reserved keys', async () => {
    for (const raw of ['__proto__=x', 'constructor=x', 'prototype=x', '_bc_admin=1', '_th_request=old']) {
      await expect(parse(raw)).rejects.toMatchObject({ status: 400 });
    }
  });

  test('rejects malformed percent escapes and invalid UTF-8', async () => {
    await expect(parse('_bc_csrf=tok&productId=%G1')).rejects.toMatchObject({ code: 'INVALID_PERCENT' });
    await expect(parse(new Uint8Array([95, 98, 99, 95, 99, 115, 114, 102, 61, 116, 111, 107, 38, 112, 61, 255]))).rejects.toMatchObject({
      code: 'INVALID_UTF8',
    });
  });

  test('requires csrf and supports only urlencoded identity bodies', async () => {
    await expect(parse('quantity=2')).rejects.toMatchObject({ code: 'MISSING_CSRF' });
    await expect(parse('_bc_csrf=tok', { contentType: 'multipart/form-data' })).rejects.toMatchObject({ status: 415 });
    await expect(parse('_bc_csrf=tok', { contentType: 'application/x-www-form-urlencoded; charset=latin1' })).rejects.toMatchObject({
      status: 415,
    });
    await expect(parse('_bc_csrf=tok', { contentEncoding: 'gzip' })).rejects.toMatchObject({ status: 415 });
  });

  test('bounds entries and bytes from the stream', async () => {
    const tooMany = ['_bc_csrf=tok'];
    for (let index = 0; index < 16; index++) tooMany.push(`f${index}=1`);
    await expect(parse(tooMany.join('&'))).rejects.toMatchObject({ code: 'TOO_MANY_ENTRIES', status: 413 });
    const big = new Uint8Array(16385).fill(65);
    await expect(parse(big)).rejects.toMatchObject({ code: 'BODY_TOO_LARGE', status: 413 });
    await expect(parse(`_bc_csrf=tok&x=${'a'.repeat(1025)}`)).rejects.toMatchObject({ code: 'VALUE_TOO_LARGE' });
  });
});
