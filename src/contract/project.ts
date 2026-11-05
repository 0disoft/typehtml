import { computeBehaviorSha256 } from './behavior.ts';
import { canonicalJson } from './canonical-json.ts';
import type { JsonObject } from './strict-json.ts';
import {
  FORM_CHECK_FORMAT,
  type BoundaryContract,
  type FormCheck,
  type InputContract,
  type LoadedBoundaryContract,
  type ObjectSchema,
} from './types.ts';

export interface ProjectionOptions {
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly generator?: string;
}

export class ProjectionError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'ProjectionError';
    this.path = path;
  }
}

function projectSource(
  contract: BoundaryContract,
  value: JsonObject,
  options: ProjectionOptions,
): FormCheck['source'] {
  return {
    path: options.sourcePath,
    sha256: options.sourceSha256,
    generator: options.generator ?? 'typehtml/contract-projection',
    projection: 'exact-for-selected-structural-fields',
    runtimeCoverage: 'not-evaluated',
    behaviorSha256: computeBehaviorSha256(value),
  };
}

function projectAction(contract: BoundaryContract, id: string, path: string): FormCheck['action'] {
  return {
    id,
    method: 'POST',
    path,
    encoding: 'urlencoded',
    parserProfile: contract.http.parserProfile,
  };
}

export function projectFormCheck(
  contract: BoundaryContract,
  value: JsonObject,
  options: ProjectionOptions,
): FormCheck {
  return {
    format: FORM_CHECK_FORMAT,
    status: 'generated-design-reference-not-product-output',
    source: projectSource(contract, value, options),
    action: projectAction(contract, contract.id, contract.http.path),
    input: contract.input,
    protocolFields: [contract.protocol.csrfField, contract.protocol.requestKeyField],
  };
}

/** Project only the fields declared by the start/begin POST. */
export function projectStartFormCheck(
  contract: BoundaryContract,
  value: JsonObject,
  options: ProjectionOptions,
): FormCheck {
  const fields = new Set(contract.page.intentInitialization.inputFields);
  const properties: Record<string, InputContract['schema']['properties'][string]> = Object.create(null);
  for (const key of Object.keys(contract.input.schema.properties)) {
    if (fields.has(key)) properties[key] = contract.input.schema.properties[key]!;
  }
  const required = contract.input.schema.required.filter((key) => fields.has(key));
  const codecs: Record<string, InputContract['codecs'][string]> = Object.create(null);
  for (const key of Object.keys(contract.input.codecs)) {
    if (fields.has(key)) codecs[key] = contract.input.codecs[key]!;
  }
  const schema: ObjectSchema = {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
  };
  const input: InputContract = {
    schema,
    codecs,
    unknownKeys: 'reject',
    duplicateScalars: 'reject',
    scalarSemantics: contract.input.scalarSemantics,
  };
  return {
    format: FORM_CHECK_FORMAT,
    status: 'generated-design-reference-not-product-output',
    source: projectSource(contract, value, options),
    action: projectAction(
      contract,
      `${contract.id}.begin`,
      contract.page.intentInitialization.path,
    ),
    input,
    protocolFields: [contract.protocol.csrfField],
  };
}

/** Verify both freshness and the selected structural fields claimed by an exact projection. */
export function verifyFormCheckSource(formCheck: FormCheck, source: LoadedBoundaryContract): void {
  if (formCheck.source.sha256 !== source.sourceSha256) {
    throw new ProjectionError('/source/sha256', 'form projection source bytes have changed');
  }
  if (formCheck.source.behaviorSha256 !== source.behaviorSha256) {
    throw new ProjectionError('/source/behaviorSha256', 'form projection behavior digest does not match its source');
  }
  const options: ProjectionOptions = {
    sourcePath: formCheck.source.path,
    sourceSha256: source.sourceSha256,
    generator: formCheck.source.generator,
  };
  const expected = formCheck.action.id === source.contract.id
    ? projectFormCheck(source.contract, source.value, options)
    : formCheck.action.id === `${source.contract.id}.begin`
      ? projectStartFormCheck(source.contract, source.value, options)
      : null;
  if (expected === null) {
    throw new ProjectionError('/action/id', 'form projection action does not belong to its source');
  }
  for (const field of ['action', 'input', 'protocolFields'] as const) {
    if (canonicalJson(formCheck[field]) !== canonicalJson(expected[field])) {
      throw new ProjectionError(`/${field}`, `form projection ${field} does not match its source`);
    }
  }
}
