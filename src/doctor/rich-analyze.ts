import { getActiveTransportRows, resolveTransportField, type NormalizedTransportField } from '../form/transport.ts';
import { getRichFormTransport, type RichFormCheck } from '../form/wire-manifest.ts';
import { collectionFieldName } from '../form/collections.ts';
import type { ScalarFormField } from '../form/fields.ts';
import { UPLOAD_LIMITS } from '../form/uploads.ts';
import { collectRichFormControls, type RichCollectionResult, type RichFieldFact } from './rich-controls.ts';
import type { ControlFact, FormFact } from './html.ts';
import { diagnosticError, diagnosticUnknown, type AnalysisStatus, type Diagnostic, type Severity, type SourceLocation } from './types.ts';
import { acceptsNativeInteger, nativeIntegerLimits, readNativeIntegerConstraints, selectNativeIntegerControl } from './constraints.ts';

export interface RichDiagnostic extends Diagnostic {
  readonly schemaPath?: string;
  readonly reason: string;
  readonly remediation: string;
}

export interface RichAnalysisResult {
  readonly collection: RichCollectionResult;
  readonly findings: readonly RichDiagnostic[];
  readonly supplyStatus: AnalysisStatus;
  readonly cardinalityStatus: AnalysisStatus;
  readonly constraintsStatus: AnalysisStatus;
}

const pointer = (text: string) => text.replaceAll('~', '~0').replaceAll('/', '~1');

function acceptsChoice(codec: ScalarFormField, value: string): boolean | null {
  if (codec.type === 'boolean') return value === (codec.trueValue ?? 'on') || codec.falseValue !== undefined && value === codec.falseValue;
  if (codec.type === 'string') {
    if (codec.const !== undefined && value !== codec.const) return false;
    if (codec.enum !== undefined && !codec.enum.includes(value)) return false;
    const length = [...value].length;
    if (length < (codec.minLength ?? 0) || length > (codec.maxLength ?? Infinity)) return false;
    // General patterns are not executed against potentially huge captured option values.
    return codec.pattern === undefined ? true : null;
  }
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(value)) return false;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return false;
  return (codec.const === undefined || codec.const === number) && (codec.enum === undefined || codec.enum.includes(number)) &&
    number >= (codec.minimum ?? -Infinity) && number <= (codec.maximum ?? Infinity);
}

function hasValueConstraints(codec: ScalarFormField): boolean {
  return codec.type !== 'string' || codec.const !== undefined || codec.enum !== undefined ||
    codec.minLength !== undefined || codec.maxLength !== undefined || codec.pattern !== undefined;
}

/**
 * The rich branch proves declared wire structure, not opaque schema execution.
 * Cardinality uses native count intervals and never enumerates combinations of choices.
 */
export function analyzeRichForm(options: Readonly<{
  form: FormFact; check: RichFormCheck; submitter: ControlFact | null; skipValidation?: boolean;
  constraintSeverity?: Severity;
  redactedValues?: boolean;
}>): RichAnalysisResult {
  const { form, check, submitter } = options;
  const prepared = getRichFormTransport(check);
  const collection = collectRichFormControls(form, submitter, options.skipValidation ?? false, options.redactedValues ?? false);
  const findings: RichDiagnostic[] = [];
  let supplyStatus: AnalysisStatus = 'checked';
  let cardinalityStatus: AnalysisStatus = 'checked';
  let constraintsStatus: AnalysisStatus = 'unknown'; // Opaque runtime validators are never static proof.
  const protocol = new Set(check.protocolFields);
  const activeRows = getActiveTransportRows(prepared, [...collection.fields].filter(([, fact]) => fact.maximum !== 0).map(([name]) => name));
  const guaranteedRows = getActiveTransportRows(prepared, [...collection.fields].filter(([, fact]) => fact.minimum > 0).map(([name]) => name));
  const activeIndexes = Object.fromEntries(Object.entries(activeRows).map(([name, indexes]) => [name, new Set(indexes)]));
  const schemaPointer = (field: NormalizedTransportField) => field.row === undefined
    ? `/transport/declarations/${pointer(field.name)}`
    : `/transport/collections/${pointer(field.row.collection)}/fields/${pointer(field.row.member)}`;
  const emit = (kind: 'defect' | 'unknown', code: string, name: string, reason: string, remediation: string,
    location: SourceLocation | null, schemaPath?: string, severity?: Severity) => {
    const key = `${check.action.id}/rich/${name}/${code}`;
    const diagnostic = kind === 'defect'
      ? diagnosticError(code === 'missing-wire-field' ? 'BC010' : 'BC011', 'rich-wire-contract', key, code, reason, location, severity)
      : diagnosticUnknown('BC012', 'rich-wire-contract', key, code, reason, location);
    findings.push({ ...diagnostic, reason, remediation, ...(schemaPath === undefined ? {} : { schemaPath }) });
  };
  for (const item of collection.unsupportedControls) {
    supplyStatus = cardinalityStatus = 'unknown';
    emit('unknown', 'unsupported-rich-control', item.control.name ?? '', `Native ${item.reason} submission is outside this structural profile.`,
      'Use an explicitly supported named control or inspect a rendered native form state.', item.control.location);
  }
  for (const [name, fact] of collection.fields) {
    if (fact.maximum === 0) continue;
    const field = resolveTransportField(prepared, name);
    const upload = Object.hasOwn(check.uploads, name) ? check.uploads[name]! : undefined;
    const location = fact.locations[0] ?? form.location;
    if (upload !== undefined) {
      const schemaPath = `/uploads/${pointer(name)}`;
      if (fact.kind !== 'file') {
        emit('defect', 'wire-kind-mismatch', name, `Native text values cannot be decoded by upload slot ${JSON.stringify(name)}.`,
          'Use an input type="file" for this upload slot.', location, schemaPath);
      } else {
        const maximum = upload.maxFiles ?? (upload.multiple ? UPLOAD_LIMITS.defaultMultipleCount : 1);
        if (!upload.multiple && fact.maximum === null || fact.maximum !== null && fact.maximum > maximum) {
          emit('defect', 'upload-cardinality-mismatch', name, `Native file controls can exceed the ${maximum}-file declaration for ${JSON.stringify(name)}.`,
            'Align native multiple controls and the declared upload cardinality.', location, schemaPath);
        } else if (fact.maximum === null) {
          cardinalityStatus = 'unknown';
          emit('unknown', 'selected-file-count-unknown', name, `The selected file count for ${JSON.stringify(name)} is not determined by the HTML snapshot.`,
            'Keep bounded multipart and upload-count validation; HTML multiple has no maximum-file-count constraint.', location, schemaPath);
        }
        constraintsStatus = 'unknown';
        emit('unknown', 'file-content-not-analyzed', name, `File bytes, actual MIME, size and accept hints for ${JSON.stringify(name)} are not static proof.`,
          'Inspect authorized uploaded content and enforce runtime byte/count limits; accept is a browser hint.', location, schemaPath);
      }
      continue;
    }
    if (field === null && !protocol.has(name)) {
      emit('defect', 'unknown-wire-field', name, `Native form can submit undeclared wire name ${JSON.stringify(name)}.`,
        'Declare this exact canonical wire name or remove its successful control name.', location);
      continue;
    }
    const schemaPath = field === null ? '/protocolFields' : schemaPointer(field);
    if (fact.kind !== 'text') {
      constraintsStatus = 'unknown';
      emit('defect', 'wire-kind-mismatch', name, `File values cannot be decoded by the declared text field ${JSON.stringify(name)}.`,
        'Declare an upload slot and multipart transport, or use a text control.', location, schemaPath);
      continue;
    }
    const maximum = field === null ? 1 : field.maxOccurrences;
    if (maximum !== null && (fact.maximum === null || fact.maximum > maximum)) {
      emit('defect', field?.cardinality === 'repeated' ? 'max-occurrences' : 'duplicate-scalar', name,
        `Native form can submit ${fact.maximum ?? 'an unbounded number of'} values for ${JSON.stringify(name)}; the declared maximum is ${maximum}.`,
        field?.cardinality === 'repeated' ? 'Limit native selections or raise the declared maxItems within request limits.' : 'Keep one successful scalar control or explicitly declare a repeated field.',
        location, schemaPath);
    }
    if (field !== null && options.redactedValues !== true) checkChoices(field, fact, schemaPath);
  }
  for (const [name, upload] of Object.entries(check.uploads)) {
    const minimum = Math.max(upload.required ? 1 : 0, upload.minFiles ?? 0);
    if (minimum === 0) continue;
    const fact = collection.fields.get(name);
    if (fact !== undefined && fact.minimum >= minimum) continue;
    const possible = fact === undefined ? 0 : fact.maximum;
    const unknown = form.hasDynamicControls || collection.unsupportedNames.has(name) || possible === null || possible >= minimum;
    if (unknown) supplyStatus = cardinalityStatus = 'unknown';
    emit(unknown ? 'unknown' : 'defect', unknown ? 'conditional-upload-supply' : 'missing-wire-field', name,
      `The snapshot ${unknown ? 'does not guarantee' : 'cannot supply'} ${minimum} selected file(s) for ${JSON.stringify(name)}.`,
      'Align native required/multiple controls with the upload minimum; keep runtime validation.', fact?.locations[0] ?? form.location, `/uploads/${pointer(name)}`);
  }
  for (const field of prepared.fields) {
    if (field.row !== undefined && !activeIndexes[field.row.collection]!.has(field.row.index)) continue;
    const fact = collection.fields.get(field.name);
    if (field.minOccurrences === 0) continue;
    const schemaPath = schemaPointer(field);
    const minimum = fact?.minimum ?? 0;
    const maximum = fact === undefined ? 0 : fact.maximum;
    if (minimum >= field.minOccurrences) continue;
    if (collection.unsupportedNames.has(field.name) || form.hasDynamicControls || fact !== undefined && (maximum === null || maximum >= field.minOccurrences)) {
      supplyStatus = cardinalityStatus = 'unknown';
      emit('unknown', 'conditional-wire-supply', field.name,
        `The snapshot does not guarantee ${field.minOccurrences} value(s) for ${JSON.stringify(field.name)}.`,
        'Add matching native required/minimum controls or capture the additional rendered state; runtime validation remains necessary.',
        fact?.locations[0] ?? form.location, schemaPath);
    } else {
      emit('defect', 'missing-wire-field', field.name,
        `Native form supplies at most ${maximum} value(s) for ${JSON.stringify(field.name)}; the declared minimum is ${field.minOccurrences}.`,
        'Add enough successful controls or adjust the declared presence/minItems policy.', fact?.locations[0] ?? form.location, schemaPath);
    }
  }
  for (const [name, group] of Object.entries(prepared.collections)) {
    const possible = activeRows[name]!;
    const guaranteed = guaranteedRows[name]!;
    const schemaPath = `/transport/collections/${pointer(name)}`;
    if (guaranteed.length < group.minItems) {
      const unknown = form.hasDynamicControls || possible.length >= group.minItems;
      if (unknown) cardinalityStatus = 'unknown';
      emit(unknown ? 'unknown' : 'defect', unknown ? 'conditional-collection-rows' : 'missing-collection-rows', name,
        `The snapshot ${unknown ? 'does not guarantee' : 'cannot supply'} ${group.minItems} active row(s) for ${JSON.stringify(name)}.`,
        'Render enough canonical contiguous rows, or adjust the declared collection minimum.', form.location, schemaPath);
    }
    if (possible.some((index, position) => index !== position)) {
      emit('defect', 'sparse-collection-rows', name, `Possible rows for ${JSON.stringify(name)} contain an index gap.`,
        'Submit row indexes contiguously from zero; preserve stable identity in the rowKey member.', form.location, schemaPath);
    } else if (guaranteed.length !== possible.length && possible.length > 1) {
      cardinalityStatus = 'unknown';
      emit('unknown', 'conditional-row-contiguity', name, `Optional controls can omit an earlier row of ${JSON.stringify(name)} while retaining a later row.`,
        'Keep a successful rowKey hidden input in each rendered row and renumber rows after removal.', form.location, schemaPath);
    }
    const keys = new Map<string, number>();
    for (const index of possible) {
      const keyName = collectionFieldName(name, index, group.rowKey);
      const key = collection.fields.get(keyName);
      if (key === undefined) continue; // The member presence check already reports the missing row key.
      if (options.redactedValues === true) {
        cardinalityStatus = 'unknown';
        emit('unknown', 'redacted-row-identity', keyName, `Redacted row identity for ${JSON.stringify(keyName)} cannot be compared for uniqueness.`,
          'Retain runtime row-key validation; never put sensitive row identities back into a shared capture artifact.', key.locations[0] ?? form.location, schemaPath);
        continue;
      }
      if (key.choices.length === 0) {
        cardinalityStatus = 'unknown';
        emit('unknown', 'editable-row-identity', keyName, `Editable row identity for ${JSON.stringify(keyName)} cannot be proved unique.`,
          'Render a stable hidden rowKey per row and retain runtime uniqueness validation.', key.locations[0] ?? form.location, schemaPath);
        continue;
      }
      for (const choice of key.choices) {
        const previous = keys.get(choice.value);
        if (previous !== undefined && previous !== index) emit('defect', 'duplicate-row-identity', keyName,
          `Rows ${previous} and ${index} of ${JSON.stringify(name)} can submit the same rowKey ${JSON.stringify(choice.value)}.`,
          'Assign distinct stable row keys; row identities do not grant authorization.', choice.control.location, schemaPath);
        else keys.set(choice.value, index);
      }
    }
  }
  for (const name of check.protocolFields) {
    const fact = collection.fields.get(name);
    if (fact !== undefined && fact.minimum >= 1) continue;
    const unknown = form.hasDynamicControls || collection.unsupportedNames.has(name) || fact !== undefined && fact.maximum !== 0;
    if (unknown) supplyStatus = 'unknown';
    emit(unknown ? 'unknown' : 'defect', unknown ? 'conditional-protocol-supply' : 'missing-wire-field', name,
      `The snapshot ${unknown ? 'does not guarantee' : 'cannot supply'} required protocol field ${JSON.stringify(name)}.`,
      'Render the protocol hidden field for this native activation.', fact?.locations[0] ?? form.location, '/protocolFields');
  }
  if (form.hasDynamicControls) {
    supplyStatus = cardinalityStatus = 'unknown';
    emit('unknown', 'dynamic-wire-controls', '', 'The selected snapshot contains dynamic controls whose future submitted names are unknown.',
      'Capture each important rendered form state; arbitrary JavaScript control mutations are not analyzed.', form.location);
  }
  let minimumEntries = 0;
  let maximumEntries: number | null = 0;
  for (const fact of collection.fields.values()) {
    // Every successful file input emits at least one multipart part, even its empty placeholder.
    const fileControls = fact.controls.filter((control) => control.type === 'file');
    const selectedMinimum = options.skipValidation ? 0 : fileControls.filter((control) => control.required).length;
    minimumEntries += fact.minimum - selectedMinimum + fileControls.length;
    maximumEntries = maximumEntries === null || fact.maximum === null ? null : maximumEntries + fact.maximum;
  }
  const entryLimits = [{ value: check.limits.maxEntries, path: '/limits/maxEntries' },
    ...(check.multipart === undefined ? [] : [{ value: check.multipart.maxParts, path: '/multipart/maxParts' }]),
  ];
  for (const limit of entryLimits) {
    if (minimumEntries > limit.value) emit('defect', 'entry-budget-mismatch', limit.path,
      `Native controls guarantee at least ${minimumEntries} submitted entries/parts; the declared limit is ${limit.value}.`,
      'Reduce successful controls or deliberately increase the bounded request entry/part limit.', form.location, limit.path);
    else if (maximumEntries === null || maximumEntries > limit.value) {
      cardinalityStatus = 'unknown';
      emit('unknown', 'conditional-entry-budget', limit.path,
        `Native choices can exceed the declared ${limit.value}-entry/part limit; the snapshot does not guarantee an accepted count.`,
        'Bound selections or retain runtime rejection and set a request budget sized for the supported form states.', form.location, limit.path);
    }
  }
  return Object.freeze({ collection, findings: Object.freeze(findings), supplyStatus, cardinalityStatus, constraintsStatus });

  function checkChoices(field: NormalizedTransportField, fact: RichFieldFact, schemaPath: string): void {
    const constrained = hasValueConstraints(field.codec);
    if (!constrained) return;
    if (field.codec.type === 'integer') for (const control of fact.controls) {
      const native = selectNativeIntegerControl(field.codec, control, options.skipValidation ?? false);
      if (native === null) continue;
      const constraints = readNativeIntegerConstraints(native);
      for (const limit of nativeIntegerLimits(field.codec, constraints)) {
        if (limit.candidate === undefined || limit.server === undefined || !acceptsNativeInteger(limit.candidate, constraints)) continue;
        const reason = `Native ${control.type} control permits ${limit.candidate}, which the declared integer ${limit.kind === 'max' ? 'maximum' : 'minimum'} rejects.`;
        findings.push({ ...diagnosticError('BC013', 'known-constraint-witness', `${check.action.id}/rich/${field.name}/${limit.kind}-witness`,
          `${limit.kind}-witness`, reason, control.location, options.constraintSeverity), reason,
          remediation: 'Align the native integer min/max/step constraints with the declared wire bounds; retain runtime validation.',
          schemaPath: `${schemaPath}/${limit.kind === 'max' ? 'maximum' : 'minimum'}`,
          witness: { rawValue: String(limit.candidate), codecValue: limit.candidate, codec: 'decimal-integer',
            schemaPointer: `${schemaPath}/${limit.kind === 'max' ? 'maximum' : 'minimum'}`, source: check.source,
            synthetic: true, nativeValidation: 'enabled-for-selected-activation',
            ...(limit.kind === 'max' ? { hypotheticalServerMaximum: limit.server } : { hypotheticalServerMinimum: limit.server }),
            ...(limit.kind === 'max' && limit.html !== null ? { unchangedHtmlMaximum: limit.html } : {}),
          },
        });
      }
    }
    const editable = fact.controls.some((control) => control.tagName !== 'select' && !['checkbox', 'radio', 'submit', 'hidden'].includes(control.type) && control.tagName !== 'button' && !control.readonly);
    if (editable || fact.choices.length === 0) {
      constraintsStatus = 'unknown';
      emit('unknown', 'editable-wire-constraints', field.name, `Editable values for ${JSON.stringify(field.name)} are not proved to satisfy its declared codec and constraints.`,
        'Keep runtime validation and align native constraint attributes; opaque refinements and transforms are never static proof.', fact.locations[0] ?? form.location, schemaPath);
    }
    for (const choice of fact.choices) {
      const accepted = acceptsChoice(field.codec, choice.value);
      if (accepted === null) { constraintsStatus = 'unknown'; continue; }
      if (!accepted) emit('defect', 'native-choice-rejected', field.name,
        `Native choice ${JSON.stringify(choice.value)} for ${JSON.stringify(field.name)} is rejected by its declared wire codec or constraints.`,
        'Use matching native option/checkbox tokens and declared enum, literal or scalar bounds.', choice.control.location, schemaPath, options.constraintSeverity);
    }
  }
}
