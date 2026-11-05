import { describe, expect, test } from 'bun:test';
import { readUrlEncodedEntries, readUrlEncodedForm, formReadOptions, WireError, type FormBodyReader, type FormReadRuntime } from '../../src/runtime/wire.ts';
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
      status: 400,
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

  test('shares bounded entry parsing with routes that have no action protocol fields', async () => {
    const request = new Request('https://example.test/login', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'tenantId=t&subjectId=s&password=correct+horse',
    });
    expect(await readUrlEncodedEntries(request, http)).toEqual([
      { key: 'tenantId', value: 't' }, { key: 'subjectId', value: 's' }, { key: 'password', value: 'correct horse' },
    ]);
  });

});

/** No real timer, network, sleep, or global clock mock is needed. */
function transport(chunks = ['x=1']) {
  const state = { time: 0, opened: 0, reads: 0, cancelled: 0, released: 0 };
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let timerId = 0;
  const reader: FormBodyReader = {
    async read() {
      state.reads++;
      const chunk = chunks.shift();
      return chunk === undefined ? { done: true, value: undefined } : { done: false, value: new TextEncoder().encode(chunk) };
    },
    async cancel() { state.cancelled++; },
    releaseLock() { state.released++; },
  };
  const runtime: FormReadRuntime = {
    now: () => state.time,
    openReader: () => { state.opened++; return reader; },
    scheduleTimeout(callback, delay) {
      delays.push(delay);
      const id = ++timerId;
      timers.set(id, callback);
      return () => { timers.delete(id); };
    },
  };
  return { state, reader, runtime, delays, timers, fireTimer() {
    const first = timers.entries().next().value;
    if (first === undefined) throw new Error('no pending timer');
    timers.delete(first[0]);
    first[1]();
  } };
}

function bodyRequest(signal?: AbortSignal): Request {
  return new Request('https://example.test/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'x=1', signal,
  });
}

describe('bounded body deadlines and I/O', () => {
  test('copies each consumed chunk before the transport reuses its backing buffer', async () => {
    const io = transport();
    const shared = new Uint8Array(4);
    const chunks = ['a=1&', 'b=2&'];
    io.reader.read = async () => {
      const chunk = chunks.shift();
      if (chunk === undefined) {
        shared.fill(33);
        return { done: true };
      }
      shared.set(new TextEncoder().encode(chunk));
      return { done: false, value: shared };
    };
    await expect(readUrlEncodedEntries(bodyRequest(), { ...http, maxBytes: 8 }, io.runtime))
      .resolves.toEqual([{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);
    expect(io.state.cancelled).toBe(0);
    expect(io.state.released).toBe(1);
    expect(io.timers.size).toBe(0);
  });

  test('cancels one pending body without cancelling another concurrent request', async () => {
    const first = transport();
    const second = transport();
    const controller = new AbortController();
    let finishSecond!: (result: Awaited<ReturnType<FormBodyReader['read']>>) => void;
    first.reader.read = () => new Promise(() => {});
    second.reader.read = () => {
      second.reader.read = async () => ({ done: true });
      return new Promise((resolve) => { finishSecond = resolve; });
    };
    const stopped = readUrlEncodedEntries(bodyRequest(controller.signal), http, first.runtime);
    const running = readUrlEncodedEntries(bodyRequest(), http, second.runtime);
    controller.abort();
    await expect(stopped).rejects.toMatchObject({ code: 'BODY_READ_ABORTED' });
    expect(first.state.cancelled).toBe(1);
    expect(first.state.released).toBe(1);
    expect(first.timers.size).toBe(0);
    expect(second.state.cancelled).toBe(0);
    expect(second.state.released).toBe(0);
    expect(second.timers.size).toBe(1);
    finishSecond({ done: false, value: new TextEncoder().encode('x=2') });
    await expect(running).resolves.toEqual([{ key: 'x', value: '2' }]);
    expect(second.state.cancelled).toBe(0);
    expect(second.state.released).toBe(1);
    expect(second.timers.size).toBe(0);
  });

  test.each([99, 100, 101])('completion at %dms respects an exclusive 100ms deadline even before its timer fires', async (completedAt) => {
    const io = transport();
    const read = io.reader.read.bind(io.reader);
    io.reader.read = () => { io.state.time = completedAt; return read(); };
    const parsing = readUrlEncodedEntries(bodyRequest(), { ...http, readTimeoutMs: 100 }, io.runtime);
    if (completedAt < 100) {
      await expect(parsing).resolves.toEqual([{ key: 'x', value: '1' }]);
      expect(io.state.cancelled).toBe(0);
    } else {
      await expect(parsing).rejects.toMatchObject({ status: 408, code: 'BODY_READ_TIMEOUT' });
      expect(io.state.cancelled).toBe(1);
    }
    expect(io.state.released).toBe(1);
    expect(io.timers.size).toBe(0);
  });

  test('EOF at the deadline is also too late', async () => {
    const io = transport();
    const read = io.reader.read.bind(io.reader);
    io.reader.read = () => { if (io.state.reads === 1) io.state.time = 100; return read(); };
    await expect(readUrlEncodedEntries(bodyRequest(), { ...http, readTimeoutMs: 100 }, io.runtime))
      .rejects.toMatchObject({ code: 'BODY_READ_TIMEOUT' });
    expect(io.state.reads).toBe(2);
    expect(io.state.released).toBe(1);
  });

  test.each([2_147_483_646, 2_147_483_647, 2_147_483_648])('a %dms stalled read uses bounded timers without shortening the deadline', async (timeout) => {
    const io = transport();
    io.reader.read = () => new Promise(() => {});
    const parsing = readUrlEncodedEntries(bodyRequest(), { ...http, readTimeoutMs: timeout }, io.runtime);
    expect(io.delays).toEqual([Math.min(timeout, 2_147_483_647)]);
    if (timeout > 2_147_483_647) {
      io.state.time = 2_147_483_647;
      io.fireTimer();
      expect(io.delays).toEqual([2_147_483_647, 1]);
      expect(io.state.cancelled).toBe(0);
    }
    io.state.time = timeout;
    io.fireTimer();
    await expect(parsing).rejects.toMatchObject({ status: 408, code: 'BODY_READ_TIMEOUT' });
    expect(io.state.cancelled).toBe(1);
    expect(io.state.released).toBe(1);
    expect(io.timers.size).toBe(0);
  });

  test('an early timer callback re-arms only the remaining time', async () => {
    const io = transport();
    io.reader.read = () => new Promise(() => {});
    const parsing = readUrlEncodedEntries(bodyRequest(), { ...http, readTimeoutMs: 100 }, io.runtime);
    io.state.time = 99;
    io.fireTimer();
    expect(io.delays).toEqual([100, 1]);
    io.state.time = 100;
    io.fireTimer();
    await expect(parsing).rejects.toMatchObject({ code: 'BODY_READ_TIMEOUT' });
  });

  test.each([15, 16, 17])('a %d-byte chunked body respects the inclusive 16-byte limit', async (bytes) => {
    const raw = `x=${'a'.repeat(bytes - 2)}`;
    const io = transport([raw.slice(0, 8), raw.slice(8)]);
    const parsing = readUrlEncodedEntries(bodyRequest(), { ...http, maxBytes: 16 }, io.runtime);
    if (bytes <= 16) await expect(parsing).resolves.toEqual([{ key: 'x', value: 'a'.repeat(bytes - 2) }]);
    else await expect(parsing).rejects.toMatchObject({ status: 413, code: 'BODY_TOO_LARGE' });
    expect(io.state.cancelled).toBe(bytes > 16 ? 1 : 0);
    expect(io.state.released).toBe(1);
    expect(io.timers.size).toBe(0);
  });

  test.each(['request', 'additional'] as const)('%s cancellation stops a pending read and releases resources', async (source) => {
    const io = transport();
    io.reader.read = () => new Promise(() => {});
    const requestAbort = new AbortController();
    const additionalAbort = new AbortController();
    const parsing = readUrlEncodedEntries(bodyRequest(requestAbort.signal), http, { ...io.runtime, signal: additionalAbort.signal });
    (source === 'request' ? requestAbort : additionalAbort).abort();
    await expect(parsing).rejects.toMatchObject({ status: 400, code: 'BODY_READ_ABORTED' });
    expect(io.state.cancelled).toBe(1);
    expect(io.state.released).toBe(1);
    expect(io.timers.size).toBe(0);
  });

  test('pre-aborted signals acquire no reader and schedule no timer', async () => {
    const io = transport();
    const controller = new AbortController();
    controller.abort();
    await expect(readUrlEncodedEntries(bodyRequest(), http, { ...io.runtime, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'BODY_READ_ABORTED' });
    expect(io.state.opened).toBe(0);
    expect(io.delays).toEqual([]);
  });

  test('cancellation wins over an already-ready read', async () => {
    const io = transport();
    const controller = new AbortController();
    io.reader.read = async () => { controller.abort(); return { done: false, value: new TextEncoder().encode('x=1') }; };
    await expect(readUrlEncodedEntries(bodyRequest(), http, { ...io.runtime, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'BODY_READ_ABORTED' });
    expect(io.state.cancelled).toBe(1);
    expect(io.state.released).toBe(1);
  });

  test.each(['throw', 'reject'] as const)('a read %s becomes a transport error even when cleanup also fails', async (mode) => {
    const io = transport();
    const disconnected = new Error('socket disconnected');
    io.reader.read = () => { if (mode === 'throw') throw disconnected; return Promise.reject(disconnected); };
    io.reader.cancel = () => { io.state.cancelled++; if (mode === 'throw') throw new Error('cancel failed'); return Promise.reject(new Error('cancel failed')); };
    io.reader.releaseLock = () => { io.state.released++; throw new Error('release failed'); };
    await expect(readUrlEncodedEntries(bodyRequest(), http, io.runtime))
      .rejects.toMatchObject({ status: 400, code: 'BODY_READ_FAILED' });
    expect(io.state.cancelled).toBe(1);
    expect(io.state.released).toBe(1);
    expect(io.timers.size).toBe(0);
  });

  test('scheduler setup failure releases the reader and preserves the original error', async () => {
    const io = transport();
    const controller = new AbortController();
    const failure = new Error('scheduler unavailable');
    await expect(readUrlEncodedEntries(bodyRequest(), http, {
      ...io.runtime, signal: controller.signal, scheduleTimeout() { throw failure; },
    })).rejects.toBe(failure);
    controller.abort();
    expect(io.state.cancelled).toBe(1);
    expect(io.state.released).toBe(1);
  });

  test('reader acquisition failure is a transport error', async () => {
    await expect(readUrlEncodedEntries(bodyRequest(), http, { openReader() { throw new Error('body locked'); } }))
      .rejects.toMatchObject({ status: 400, code: 'BODY_READ_FAILED' });
  });

  test.each([99, 100, 101])('empty-body acquisition at %dms obeys the same 100ms deadline', async (completedAt) => {
    const io = transport();
    const parsing = readUrlEncodedEntries(bodyRequest(), { ...http, readTimeoutMs: 100 }, {
      ...io.runtime, openReader() { io.state.time = completedAt; return null; },
    });
    if (completedAt < 100) await expect(parsing).resolves.toEqual([]);
    else await expect(parsing).rejects.toMatchObject({ status: 408, code: 'BODY_READ_TIMEOUT' });
    expect(io.delays).toEqual([]);
  });

  test.each([0, -1, NaN, Infinity])('invalid timeout %s fails before opening the transport', async (readTimeoutMs) => {
    const io = transport();
    await expect(readUrlEncodedEntries(bodyRequest(), { ...http, readTimeoutMs }, io.runtime))
      .rejects.toThrow('INVALID_BODY_READ_TIMEOUT');
    expect(io.state.opened).toBe(0);
  });

  test.each([NaN, Infinity, -1])('invalid clock %s fails before opening the transport', async (time) => {
    const io = transport();
    io.state.time = time;
    await expect(readUrlEncodedEntries(bodyRequest(), http, io.runtime)).rejects.toThrow('INVALID_BODY_READ_CLOCK');
    expect(io.state.opened).toBe(0);
  });

  test('a clock moving backwards fails closed and releases the reader', async () => {
    const io = transport();
    io.state.time = 10;
    const read = io.reader.read.bind(io.reader);
    io.reader.read = () => { io.state.time = 9; return read(); };
    await expect(readUrlEncodedEntries(bodyRequest(), http, io.runtime)).rejects.toThrow('INVALID_BODY_READ_CLOCK');
    expect(io.state.cancelled).toBe(1);
    expect(io.state.released).toBe(1);
    expect(io.timers.size).toBe(0);
  });

  test('the protocol parser forwards optional runtime dependencies', async () => {
    const io = transport(['_bc_csrf=tok&quantity=2']);
    await expect(readUrlEncodedForm(bodyRequest(), formReadOptions(http, protocol, false), io.runtime))
      .resolves.toMatchObject({ csrf: 'tok', fields: { quantity: '2' } });
    expect(io.state.opened).toBe(1);
  });
});
