import type { InputIssue } from '../runtime/input.ts';
import type { FormField, FormFields, ScalarFormField } from './fields.ts';
import type { FormMessages } from './state.ts';

export type FormMessageLocale = 'en' | 'ko';

export interface FormMessageOptions {
  /** Explicit wire-field definitions: form.fields or form.input.schema.properties. */
  readonly fields?: FormFields;
  readonly labels?: Readonly<Record<string, string>>;
}

type FieldMessageData = Readonly<{
  label: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
  minItems?: number; maxItems?: number; literal?: string;
}>;

function fieldMessageData(field: FormField | undefined, label: string): FieldMessageData {
  const scalar: ScalarFormField | undefined = field?.type === 'array' ? field.items : field;
  return Object.freeze({ label,
    ...(scalar?.type === 'string' ? { minLength: scalar.minLength, maxLength: scalar.maxLength } : {}),
    ...(scalar?.type === 'integer' ? { minimum: scalar.minimum, maximum: scalar.maximum } : {}),
    ...(field?.type === 'array' ? { minItems: field.minItems, maxItems: field.maxItems } : {}),
    ...(scalar !== undefined && 'const' in scalar && scalar.const !== undefined
      ? { literal: JSON.stringify(scalar.const) } : {}),
  });
}

function formatIssue(locale: FormMessageLocale, issue: InputIssue, data: FieldMessageData): string {
  const { label, minLength, maxLength, minimum, maximum, minItems, maxItems, literal } = data;
  if (locale === 'ko') {
    switch (issue.code) {
      case 'REQUIRED': return `${label} 항목을 입력해 주세요.`;
      case 'MIN_LENGTH': return minLength === undefined ? `${label} 입력값이 너무 짧습니다.` : `${label} 항목은 ${minLength}자 이상 입력해 주세요.`;
      case 'MAX_LENGTH': return maxLength === undefined ? `${label} 입력값이 너무 깁니다.` : `${label} 항목은 ${maxLength}자 이하로 입력해 주세요.`;
      case 'MINIMUM': return minimum === undefined ? `${label} 값이 최솟값보다 작습니다.` : `${label} 항목은 ${minimum} 이상이어야 합니다.`;
      case 'MAXIMUM': return maximum === undefined ? `${label} 값이 최댓값보다 큽니다.` : `${label} 항목은 ${maximum} 이하여야 합니다.`;
      case 'CONST': return literal === undefined ? `${label} 값이 지정된 값과 다릅니다.` : `${label} 항목은 ${literal} 값이어야 합니다.`;
      case 'ENUM': return `${label} 항목에서 허용된 값을 선택해 주세요.`;
      case 'PATTERN': return `${label} 항목을 지정된 형식으로 입력해 주세요.`;
      case 'PATTERN_UNSUPPORTED': return `${label} 항목의 검증 패턴을 지원하지 않습니다.`;
      case 'INVALID_INTEGER_SYNTAX': case 'INTEGER_RANGE': return `${label} 항목은 안전한 범위의 정수여야 합니다.`;
      case 'BOOLEAN': return `${label} 항목에서 허용된 체크박스 값을 선택해 주세요.`;
      case 'DUPLICATE_KEY': return `${label} 항목은 한 번만 제출해 주세요.`;
      case 'MIN_ITEMS': return minItems === undefined ? `${label} 항목의 값이 부족합니다.` : `${label} 항목은 ${minItems}개 이상 선택해 주세요.`;
      case 'MAX_ITEMS': return maxItems === undefined ? `${label} 항목의 값이 너무 많습니다.` : `${label} 항목은 ${maxItems}개 이하로 선택해 주세요.`;
      case 'SPARSE_ARRAY': return '순서가 있는 입력값은 0번부터 빠짐없이 제출해 주세요.';
      default: return issue.message;
    }
  }
  switch (issue.code) {
    case 'REQUIRED': return `${label} is required`;
    case 'MIN_LENGTH': return minLength === undefined ? `${label} is too short` : `${label} must be at least ${minLength} characters`;
    case 'MAX_LENGTH': return maxLength === undefined ? `${label} is too long` : `${label} must be at most ${maxLength} characters`;
    case 'MINIMUM': return minimum === undefined ? `${label} is below the minimum` : `${label} must be at least ${minimum}`;
    case 'MAXIMUM': return maximum === undefined ? `${label} is above the maximum` : `${label} must be at most ${maximum}`;
    case 'CONST': return literal === undefined ? `${label} must match the required value` : `${label} must be ${literal}`;
    case 'ENUM': return `${label} is not an allowed value`;
    case 'PATTERN': return `${label} does not match the required pattern`;
    case 'PATTERN_UNSUPPORTED': return `${label} has an unsupported pattern`;
    case 'INVALID_INTEGER_SYNTAX': case 'INTEGER_RANGE': return `${label} must be a decimal integer`;
    case 'BOOLEAN': return `${label} must be an allowed checkbox value`;
    case 'DUPLICATE_KEY': return `${label} must occur once`;
    case 'MIN_ITEMS': return minItems === undefined ? `${label} has too few values` : `${label} must contain at least ${minItems} values`;
    case 'MAX_ITEMS': return maxItems === undefined ? `${label} has too many values` : `${label} must contain at most ${maxItems} values`;
    case 'SPARSE_ARRAY': return 'Indexed form values must be contiguous from zero';
    default: return issue.message;
  }
}

const MESSAGE_CODES = Object.freeze([
  'REQUIRED', 'MIN_LENGTH', 'MAX_LENGTH', 'MINIMUM', 'MAXIMUM', 'CONST', 'ENUM', 'PATTERN',
  'PATTERN_UNSUPPORTED', 'INVALID_INTEGER_SYNTAX', 'INTEGER_RANGE', 'BOOLEAN', 'DUPLICATE_KEY',
  'MIN_ITEMS', 'MAX_ITEMS', 'SPARSE_ARRAY',
]);

/**
 * Opt-in messages for TypeHTML's own validation codes. Bounds come from explicit field data,
 * never from parsing English errors. SCHEMA/vendor and unknown codes retain their original text.
 * Returned messages contain plain text; renderers remain responsible for HTML escaping.
 */
export function createFormMessages(locale: string, options: FormMessageOptions = {}): FormMessages {
  const language = new Intl.Locale(canonicalLocale(locale)).language;
  if (language !== 'en' && language !== 'ko') throw new TypeError('unsupported built-in form message locale');
  const labels = new Map<string, string>();
  for (const [name, label] of Object.entries(options.labels ?? {})) {
    if (typeof label !== 'string') throw new TypeError('form field labels must be strings');
    labels.set(name, label);
  }
  const fields = new Map<string, FieldMessageData>();
  for (const [name, field] of Object.entries(options.fields ?? {})) fields.set(name, fieldMessageData(field, labels.get(name) ?? name));
  const format = (issue: InputIssue): string => formatIssue(language, issue,
    fields.get(issue.field ?? '') ?? fieldMessageData(undefined, labels.get(issue.field ?? '') ?? issue.field ?? 'Form'));
  return Object.freeze(Object.fromEntries(MESSAGE_CODES.map((code) => [code, format])));
}

export interface FormLocaleOptions {
  /** A bounded application-owned allowlist; the returned locale is canonicalized. */
  readonly supportedLocales: readonly string[];
  readonly fallbackLocale: string;
  /** Explicit user/session preferences take precedence over the request header. */
  readonly preferredLocales?: readonly string[];
  readonly acceptLanguage?: string | null;
}

const LOCALE_LIMITS = Object.freeze({ supported: 32, preferred: 32, headerLength: 8_192 });
type LanguageRange = Readonly<{ range: string; quality: number; order: number }>;

function canonicalLocale(locale: string): string {
  if (typeof locale !== 'string' || locale === '') throw new TypeError('expected a nonempty locale');
  return Intl.getCanonicalLocales(locale)[0]!;
}

function languageRanges(header: string): readonly LanguageRange[] {
  const seen = new Set<string>();
  const ranges: LanguageRange[] = [];
  for (const [order, item] of header.split(',').entries()) {
    const parts = item.trim().split(';');
    const raw = parts[0]!.trim();
    if (!/^(?:\*|[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*)$/.test(raw) || parts.length > 2) continue;
    let range: string;
    try { range = raw === '*' ? '*' : canonicalLocale(raw).toLowerCase(); } catch { continue; }
    const weight = parts[1]?.trim();
    if (weight !== undefined && !/^q=(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/i.test(weight)) continue;
    if (seen.has(range)) continue;
    seen.add(range);
    ranges.push({ range, quality: weight === undefined ? 1 : Number(weight.slice(2)), order });
  }
  return ranges;
}

function matches(range: string, locale: string): boolean {
  return range === '*' || locale === range || locale.startsWith(`${range}-`);
}

function lookup(range: string, supported: readonly string[], allowed: (locale: string) => boolean): string | undefined {
  let search = range;
  while (search !== '') {
    const exact = supported.find((locale) => locale.toLowerCase() === search && allowed(locale));
    if (exact !== undefined) return exact;
    const match = supported.find((locale) => matches(search, locale.toLowerCase()) && allowed(locale));
    if (match !== undefined) return match;
    const parts = search.split('-');
    parts.pop();
    if (parts.at(-1)?.length === 1) parts.pop();
    search = parts.join('-');
  }
  return undefined;
}

function headerLocale(ranges: readonly LanguageRange[], supported: readonly string[], fallback: string): string | undefined {
  const ordered = [fallback, ...supported.filter((locale) => locale !== fallback)];
  const scores = new Map<string, LanguageRange>();
  const unmatched: string[] = [];
  for (const locale of ordered) {
    const matching = ranges.filter(({ range }) => matches(range, locale.toLowerCase()))
      .sort((a, b) => (b.range === '*' ? 0 : b.range.split('-').length) - (a.range === '*' ? 0 : a.range.split('-').length) || a.order - b.order);
    const mostSpecific = matching[0];
    if (mostSpecific === undefined) unmatched.push(locale);
    else scores.set(locale, mostSpecific);
  }
  // Lookup fallback applies only when no range (including q=0/wildcard) describes a locale.
  for (const preference of ranges.filter(({ quality, range }) => quality > 0 && range !== '*')
    .sort((a, b) => b.quality - a.quality || a.order - b.order)) {
    const found = lookup(preference.range, unmatched, () => true);
    if (found !== undefined && !scores.has(found)) scores.set(found, preference);
  }
  return ordered.filter((locale) => (scores.get(locale)?.quality ?? 0) > 0)
    .sort((a, b) => scores.get(b)!.quality - scores.get(a)!.quality || scores.get(a)!.order - scores.get(b)!.order)[0];
}

/**
 * Explicit locale negotiation without changing any handler defaults. Header weights use up to
 * three decimals; invalid ranges are ignored and duplicate ranges use their first occurrence.
 * A locale's most specific matching range determines its weight, including q=0 exclusions.
 * Subtag lookup applies only to locales with no matching range. If no preference matches
 * (including all q=0), the configured application fallback is returned.
 */
export function resolveFormLocale(options: FormLocaleOptions): string {
  if (!Array.isArray(options.supportedLocales) || options.supportedLocales.length < 1 || options.supportedLocales.length > LOCALE_LIMITS.supported) {
    throw new TypeError('expected 1 to 32 supported form locales');
  }
  const supported = [...new Set(options.supportedLocales.map(canonicalLocale))];
  const fallback = canonicalLocale(options.fallbackLocale);
  if (!supported.includes(fallback)) throw new TypeError('fallback locale must be in supportedLocales');
  const preferred = options.preferredLocales ?? [];
  if (!Array.isArray(preferred) || preferred.length > LOCALE_LIMITS.preferred) throw new TypeError('expected at most 32 preferred form locales');
  for (const preference of preferred) {
    const found = lookup(canonicalLocale(preference).toLowerCase(), supported, () => true);
    if (found !== undefined) return found;
  }
  const header = options.acceptLanguage ?? '';
  if (typeof header !== 'string' || header.length > LOCALE_LIMITS.headerLength) throw new TypeError('Accept-Language must be at most 8192 characters');
  return headerLocale(languageRanges(header), supported, fallback) ?? fallback;
}
