import { createHash, timingSafeEqual } from 'node:crypto';

export class CsrfError extends Error {
  readonly status = 403;
  readonly code = 'CSRF_INVALID';

  constructor() {
    super('CSRF token does not match');
    this.name = 'CsrfError';
  }
}

/** Compare hashes so token length does not influence the timing-safe compare. */
export function csrfTokenMatches(received: string, expected: string): boolean {
  const left = createHash('sha256').update(received, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}

export function assertCsrfToken(received: string, expected: string): void {
  if (!csrfTokenMatches(received, expected)) throw new CsrfError();
}
