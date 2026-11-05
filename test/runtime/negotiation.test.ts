import { describe, expect, test } from 'bun:test';
import { acceptsHtml, assertRequestOrigin, NegotiationError } from '../../src/runtime/negotiation.ts';

const policy = { allowedOrigins: ['https://example.test'] };

function request(headers: Record<string, string | undefined>): Request {
  const effective = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) effective.set(name, value);
  }
  return new Request('https://example.test/actions/x', { method: 'POST', headers: effective });
}

describe('Accept negotiation', () => {
  test('accepts absent and positive HTML ranges', () => {
    expect(acceptsHtml(null)).toBe(true);
    expect(acceptsHtml('text/html')).toBe(true);
    expect(acceptsHtml('text/html,application/xhtml+xml')).toBe(true);
    expect(acceptsHtml('*/*')).toBe(true);
  });

  test('honours q=0 and explicit JSON rejection', () => {
    expect(acceptsHtml('text/html;q=0')).toBe(false);
    expect(acceptsHtml('application/json')).toBe(false);
    expect(acceptsHtml('text/html;q=0, */*;q=1')).toBe(false);
    expect(acceptsHtml('text/*;q=0.2, text/html;q=0.9')).toBe(true);
  });

  test('uses media specificity and supported response parameters independently of header order', () => {
    expect(acceptsHtml('text/html;q=0,text/html;q=1')).toBe(true);
    expect(acceptsHtml('text/html;q=1,text/html;q=0')).toBe(true);
    expect(acceptsHtml('text/html;charset="UTF-8";q=0,text/html;q=1')).toBe(false);
    expect(acceptsHtml('text/html;level=1')).toBe(false);
    expect(acceptsHtml('text/html;note="x,y",application/json')).toBe(false);
    expect(acceptsHtml('text/html;charset=iso-8859-1')).toBe(false);
    expect(acceptsHtml('TEXT/HTML;CHARSET=UTF-8')).toBe(true);
  });

  test('does not treat exponent, excess precision, or out-of-range quality as permission', () => {
    for (const quality of ['1e0', '0x1', '0.0001', '2', '-1', 'Infinity']) {
      expect(acceptsHtml(`text/html;q=${quality},*/*;q=1`)).toBe(false);
    }
  });
});

describe('Origin and Fetch Metadata', () => {
  test('accepts exact origin and referer fallback', () => {
    expect(() => assertRequestOrigin(request({ origin: 'https://example.test' }), policy)).not.toThrow();
    expect(() => assertRequestOrigin(request({ referer: 'https://example.test/orders/new' }), policy)).not.toThrow();
  });

  test('rejects null, foreign, missing, and malformed sources', () => {
    for (const headers of [
      { origin: 'null' },
      { origin: 'https://evil.test' },
      { origin: 'https://example.test.evil' },
      {},
      { referer: 'not a url' },
      { origin: 'https://example.test, https://evil.test' },
      { origin: 'https://example.test/path' },
      { origin: 'https://example.test?query=1' },
      { origin: 'https://example.test#fragment' },
      { origin: 'https://user:pass@example.test' },
      { origin: 'https://example.test/' },
    ]) {
      expect(() => assertRequestOrigin(request(headers), policy)).toThrow(NegotiationError);
    }
  });

  test('rejects malformed allowed-origin configuration instead of broadening it', () => {
    expect(() => assertRequestOrigin(request({ origin: 'https://example.test' }), {
      allowedOrigins: ['https://example.test/path'],
    })).toThrow('INVALID_ALLOWED_ORIGIN');
  });

  test('rejects cross-site and same-site fetch metadata', () => {
    expect(() =>
      assertRequestOrigin(request({ origin: 'https://example.test', 'sec-fetch-site': 'cross-site' }), policy),
    ).toThrow(NegotiationError);
    expect(() =>
      assertRequestOrigin(request({ origin: 'https://example.test', 'sec-fetch-site': 'same-site' }), policy),
    ).toThrow(NegotiationError);
    expect(() =>
      assertRequestOrigin(request({ origin: 'https://example.test', 'sec-fetch-site': 'same-origin' }), policy),
    ).not.toThrow();
  });
});
