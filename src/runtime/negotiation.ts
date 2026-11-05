export type NegotiationStatus = 403 | 406;

export class NegotiationError extends Error {
  readonly status: NegotiationStatus;
  readonly code: string;

  constructor(status: NegotiationStatus, code: string) {
    super(code);
    this.name = 'NegotiationError';
    this.status = status;
    this.code = code;
  }
}

function parseQuality(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value > 1) return 0;
  return value;
}

/** RFC 9110 Accept handling sufficient for the native-HTML profile. */
export function acceptsHtml(header: string | null): boolean {
  if (header === null) return true;
  let bestSpecificity = -1;
  let bestQuality = 0;
  for (const item of header.split(',')) {
    const parts = item.split(';').map((part) => part.trim());
    const range = (parts.shift() ?? '').toLowerCase();
    if (range === '') continue;
    let quality = 1;
    for (const parameter of parts) {
      if (parameter === '') continue;
      const separator = parameter.indexOf('=');
      if (separator < 0) continue;
      if (parameter.slice(0, separator).trim().toLowerCase() === 'q') {
        quality = parseQuality(parameter.slice(separator + 1));
      }
    }
    let specificity: number;
    if (range === 'text/html') specificity = 2;
    else if (range === 'text/*') specificity = 1;
    else if (range === '*/*') specificity = 0;
    else continue;
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestQuality = quality;
    }
  }
  return bestSpecificity >= 0 && bestQuality > 0;
}

function normalizedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export interface OriginPolicy {
  readonly allowedOrigins: readonly string[];
}

/** Origin with same-origin Referer fallback, plus Fetch Metadata rejection. */
export function assertRequestOrigin(request: Request, policy: OriginPolicy): void {
  const allowed = new Set(policy.allowedOrigins.map((value) => normalizedOrigin(value) ?? value));
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null) {
    const normalized = fetchSite.trim().toLowerCase();
    if (normalized === 'cross-site' || normalized === 'same-site') {
      throw new NegotiationError(403, 'CROSS_SITE_REQUEST');
    }
  }

  const origin = request.headers.get('origin');
  if (origin !== null) {
    if (origin.trim() !== origin || origin.includes(',')) {
      throw new NegotiationError(403, 'INVALID_ORIGIN');
    }
    if (origin.trim().toLowerCase() === 'null') {
      throw new NegotiationError(403, 'NULL_ORIGIN');
    }
    const normalized = normalizedOrigin(origin);
    if (normalized === null) throw new NegotiationError(403, 'INVALID_ORIGIN');
    if (!allowed.has(normalized)) throw new NegotiationError(403, 'ORIGIN_NOT_ALLOWED');
    return;
  }

  const referer = request.headers.get('referer');
  if (referer === null) throw new NegotiationError(403, 'MISSING_ORIGIN_AND_REFERER');
  const normalized = normalizedOrigin(referer);
  if (normalized === null || !allowed.has(normalized)) {
    throw new NegotiationError(403, 'REFERER_NOT_ALLOWED');
  }
}
