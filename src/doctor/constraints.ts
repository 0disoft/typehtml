import type { FieldSchema, IntegerFieldSchema } from '../contract/types.ts';
import { attribute } from './html.ts';
import type { ControlFact } from './html.ts';

const KNOWN_INTEGER_TEXT_PATTERN = '([1-9]|1[0-9]|20)';
const KNOWN_INTEGER_TEXT_VALUE = new RegExp(`^(?:${KNOWN_INTEGER_TEXT_PATTERN})$`);
const STEP_ALIGNMENT_TOLERANCE = 1e-9;

export interface NativeIntegerControl {
  readonly schema: IntegerFieldSchema;
  readonly control: ControlFact;
  readonly knownTextPattern: boolean;
}

export interface NativeIntegerConstraints extends NativeIntegerControl {
  readonly htmlMin: number | null;
  readonly htmlMax: number | null;
  readonly step: number | null;
  readonly base: number;
}

export interface NativeIntegerLimit {
  readonly kind: 'max' | 'min';
  readonly server: number | undefined;
  readonly candidate: number | undefined;
  readonly html: number | null;
}

/** Parse the selected profile's numeric HTML attribute syntax without normalizing it. */
export function parseNativeNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === '' || !/^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(raw)) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

export function selectNativeIntegerControl(schema: FieldSchema, control: ControlFact, skipValidation: boolean): NativeIntegerControl | null {
  if (skipValidation || control.readonly || control.tagName !== 'input') return null;
  const pattern = attribute(control.element, 'pattern');
  const knownTextPattern = control.type === 'text' && pattern === KNOWN_INTEGER_TEXT_PATTERN;
  if (schema.type !== 'integer' || (control.type !== 'number' && !knownTextPattern)) return null;
  return { schema, control, knownTextPattern };
}

function numberAttribute(control: ControlFact, key: string): number | null {
  return parseNativeNumber(attribute(control.element, key));
}

function nativeStep(raw: string | null, number: number | null): number | null {
  if (raw?.toLowerCase() === 'any') return null;
  if (number !== null && number > 0) return number;
  return 1;
}

/** Keep attribute reads in min, max, raw step, numeric step, then fallback value order. */
export function readNativeIntegerConstraints(native: NativeIntegerControl): NativeIntegerConstraints {
  const { control } = native;
  const htmlMin = control.type === 'number' ? numberAttribute(control, 'min') : null;
  const htmlMax = control.type === 'number' ? numberAttribute(control, 'max') : null;
  const rawStep = attribute(control.element, 'step');
  const numberStep = numberAttribute(control, 'step');
  const step = nativeStep(rawStep, numberStep);
  const base = htmlMin ?? numberAttribute(control, 'value') ?? 0;
  return { ...native, htmlMin, htmlMax, step, base };
}

/** The native numeric step comparison deliberately uses the existing absolute tolerance. */
export function alignsWithNativeStep(candidate: number, base: number, step: number | null): boolean {
  if (step === null) return true;
  const quotient = (candidate - base) / step;
  return Math.abs(quotient - Math.round(quotient)) < STEP_ALIGNMENT_TOLERANCE;
}

function acceptsKnownIntegerText(raw: string, minimumLength: number | null, maximumLength: number | null): boolean {
  return KNOWN_INTEGER_TEXT_VALUE.test(raw) && (minimumLength === null || raw.length >= minimumLength) && (maximumLength === null || raw.length <= maximumLength);
}

export function acceptsNativeInteger(candidate: number, constraints: NativeIntegerConstraints): boolean {
  const { control, htmlMin, htmlMax, knownTextPattern, base, step } = constraints;
  if (!Number.isSafeInteger(candidate) || (htmlMin !== null && candidate < htmlMin) || (htmlMax !== null && candidate > htmlMax)) return false;
  if (knownTextPattern) {
    const raw = String(candidate);
    // Text length attributes remain lazy: rejected range candidates never read them.
    const minimumLength = numberAttribute(control, 'minlength');
    const maximumLength = numberAttribute(control, 'maxlength');
    return acceptsKnownIntegerText(raw, minimumLength, maximumLength);
  }
  return alignsWithNativeStep(candidate, base, step);
}

export function nativeIntegerLimits(schema: IntegerFieldSchema, constraints: NativeIntegerConstraints): readonly NativeIntegerLimit[] {
  return [
    { kind: 'max', server: schema.maximum, candidate: schema.maximum === undefined ? undefined : schema.maximum + 1, html: constraints.htmlMax },
    { kind: 'min', server: schema.minimum, candidate: schema.minimum === undefined ? undefined : schema.minimum - 1, html: constraints.htmlMin },
  ];
}
