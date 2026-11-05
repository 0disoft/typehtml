import { describe, expect, test } from 'bun:test';
import { acceptsHtml, assertRequestOrigin, NegotiationError } from '../../src/runtime/negotiation.ts';

const policy = { allowedOrigins: ['https://example.test'] };

function request(headers: Record<string, string>): Request {
  return new Request('https://example.test/actions/x', { method: 'POST', headers });
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
    ]) {
      expect(() => assertRequestOrigin(request(headers), policy)).toThrow(NegotiationError);
    }
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
