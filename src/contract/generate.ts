import { BEHAVIOR_DIGEST_PROFILE, BEHAVIOR_FIELDS, computeBehaviorSha256 } from './behavior.ts';
import { projectFormCheck, projectStartFormCheck, type ProjectionOptions } from './project.ts';
import { validateBoundaryContract } from './validate.ts';
import type { FieldSchema, FormCheck, LoadedBoundaryContract, ObjectSchema } from './types.ts';

export interface ContractTypeNames {
  readonly input: string;
  readonly output: string;
  readonly pageView: string;
}

export interface GenerationOptions extends ProjectionOptions {
  readonly typeNames?: ContractTypeNames;
}

export interface GeneratedContractArtifacts {
  readonly types: string;
  readonly formCheck: FormCheck;
  readonly startFormCheck: FormCheck;
  readonly digests: {
    readonly format: 'boundary-reference-digests/1';
    readonly status: 'generated-design-reference';
    readonly sourceSha256: string;
    readonly behaviorProfile: typeof BEHAVIOR_DIGEST_PROFILE;
    readonly behaviorSha256: string;
    readonly includedFields: typeof BEHAVIOR_FIELDS;
    readonly operationRevision: number;
    readonly callbackCompatibility: 'manual-operationRevision; not inferred from source code';
  };
}

const DEFAULT_TYPE_NAMES: ContractTypeNames = {
  input: 'OrderInput',
  output: 'PublicReceipt',
  pageView: 'OrderPageView',
};

function literal(value: string | number): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function scalarType(schema: FieldSchema): string {
  if (schema.const !== undefined) return literal(schema.const);
  if (schema.enum !== undefined) return schema.enum.map(literal).join(' | ');
  return schema.type === 'string' ? 'string' : 'number';
}

function objectType(name: string, schema: ObjectSchema, pointer: string): string {
  const required = new Set(schema.required);
  const fields = Object.entries(schema.properties).map(([key, value]) =>
    `  readonly ${literal(key)}${required.has(key) ? '' : '?'}: ${scalarType(value)};`,
  );
  return `// Source JSON Pointer: ${pointer}\nexport type ${name} = {\n${fields.join('\n')}\n};\n`;
}

/** Derive data artifacts only. No application modules, callbacks, or server code are executed. */
export function generateContractArtifacts(
  loaded: LoadedBoundaryContract,
  options: GenerationOptions,
): GeneratedContractArtifacts {
  const contract = validateBoundaryContract(loaded.value);
  const behaviorSha256 = computeBehaviorSha256(loaded.value);
  if (behaviorSha256 !== loaded.behaviorSha256) {
    throw new TypeError('loaded contract behavior has changed since validation');
  }
  if (!/^[a-f0-9]{64}$/.test(loaded.sourceSha256) || options.sourceSha256 !== loaded.sourceSha256) {
    throw new TypeError('generation requires the loaded source byte hash');
  }
  if (options.sourcePath.length === 0 || /[\r\n\u2028\u2029]/.test(options.sourcePath)) {
    throw new TypeError('sourcePath must be a non-empty single-line path');
  }
  const names = options.typeNames ?? DEFAULT_TYPE_NAMES;
  const seen = new Set<string>();
  for (const name of [names.input, names.output, names.pageView]) {
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(name) || seen.has(name)) {
      throw new TypeError('generated type names must be distinct identifiers starting with an uppercase letter');
    }
    seen.add(name);
  }
  const types = [
    `// GENERATED from ${options.sourcePath}; do not edit.\n`,
    `// Source SHA256: ${loaded.sourceSha256}\n`,
    '// Numeric/string constraints remain runtime responsibilities.\n',
    objectType(names.input, contract.input.schema, '/input/schema'),
    objectType(names.output, contract.output.schema, '/output/schema'),
    objectType(names.pageView, contract.page.viewSchema, '/page/viewSchema'),
  ].join('');
  return {
    types,
    formCheck: projectFormCheck(contract, loaded.value, options),
    startFormCheck: projectStartFormCheck(contract, loaded.value, options),
    digests: {
      format: 'boundary-reference-digests/1',
      status: 'generated-design-reference',
      sourceSha256: loaded.sourceSha256,
      behaviorProfile: BEHAVIOR_DIGEST_PROFILE,
      behaviorSha256,
      includedFields: BEHAVIOR_FIELDS,
      operationRevision: contract.operationRevision,
      callbackCompatibility: 'manual-operationRevision; not inferred from source code',
    },
  };
}
