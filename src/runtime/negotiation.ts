import { parseAccept } from 'hono/utils/accept';

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
  if (!/^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/.test(raw)) return 0;
  return Number(raw);
}

/** RFC 9110 Accept handling sufficient for the native-HTML profile. */
export function acceptsHtml(header: string | null): boolean {
  if (header === null) return true;
  let bestSpecificity = -1;
  let bestQuality = 0;
  for (const item of parseAccept(header)) {
    const range = item.type.toLowerCase();
    let quality = 1;
    let parameterSpecificity = 0;
    let matchesParameters = true;
    for (const [rawName, value] of Object.entries(item.params)) {
      const name = rawName.toLowerCase();
      if (name === 'q') quality = parseQuality(value);
      else if (name === 'charset' && value.toLowerCase() === 'utf-8') parameterSpecificity++;
      else matchesParameters = false;
    }
    if (!matchesParameters) continue;
    let specificity: number;
    if (range === 'text/html') specificity = 2;
    else if (range === 'text/*') specificity = 1;
    else if (range === '*/*') specificity = 0;
    else continue;
    specificity = specificity * 100 + parameterSpecificity;
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestQuality = quality;
    } else if (specificity === bestSpecificity) {
      bestQuality = Math.max(bestQuality, quality);
    }
  }
  return bestSpecificity >= 0 && bestQuality > 0;
}

function normalizedOrigin(value: string, serialized = false): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '') return null;
    if (serialized && value !== url.origin) return null;
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
  const allowed = new Set(policy.allowedOrigins.map((value) => {
    const origin = normalizedOrigin(value, true);
    if (origin === null) throw new Error('INVALID_ALLOWED_ORIGIN');
    return origin;
  }));
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
    const normalized = normalizedOrigin(origin, true);
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
