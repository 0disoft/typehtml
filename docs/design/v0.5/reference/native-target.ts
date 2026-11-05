/** URL resolution from already supplied attribute facts. No HTML parser or browser execution. */
export type TargetFacts = Readonly<{
  documentUrl: string; effectiveBaseUrl: string | null;
  formAction: string | null; submitterAction: string | null;
}>;
export function resolveNativeAction(facts: TargetFacts): URL {
  // null means no attribute; "" is an explicit empty override, not absence.
  const raw = facts.submitterAction !== null ? facts.submitterAction : (facts.formAction ?? '');
  return raw === '' ? new URL(facts.documentUrl) : new URL(raw, facts.effectiveBaseUrl ?? facts.documentUrl);
}
export function assertFixedPath(path: string, origin: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || /[\s\\?#]/u.test(path) || /%(?![0-9A-Fa-f]{2})/u.test(path))
    throw new Error('NONCANONICAL_PATH');
  const base = new URL(origin);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('UNSUPPORTED_ORIGIN');
  if (base.href !== base.origin + '/') throw new Error('NONCANONICAL_ORIGIN');
  const target = new URL(path, base);
  if (target.origin !== base.origin || target.pathname !== path || target.search || target.hash)
    throw new Error('NONCANONICAL_PATH');
  // Encoded separators require framework/proxy semantics outside this initial profile.
  if (/%(?:2f|5c)/iu.test(path)) throw new Error('UNSUPPORTED_ENCODED_SEPARATOR');
  return path;
}
