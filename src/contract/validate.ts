import type { JsonValue } from './strict-json.ts';
import {
  CONTRACT_FORMAT,
  FORM_CHECK_FORMAT,
  SUPPORTED_CSRF_FIELD,
  SUPPORTED_PARSER_PROFILE,
  SUPPORTED_REQUEST_KEY_FIELD,
  SUPPORTED_STRING_PATTERNS,
  type BoundaryContract,
  type CodecName,
  type FieldSchema,
  type FormCheck,
  type InputContract,
  type ObjectSchema,
} from './types.ts';

export type ContractValidationCode =
  | 'EXPECTED_OBJECT'
  | 'EXPECTED_ARRAY'
  | 'EXPECTED_STRING'
  | 'EXPECTED_INTEGER'
  | 'EXPECTED_BOOLEAN'
  | 'MISSING_KEY'
  | 'UNKNOWN_KEY'
  | 'UNSUPPORTED_KEYWORD'
  | 'UNSUPPORTED_PATTERN'
  | 'INVALID_VALUE'
  | 'INVALID_ID'
  | 'INVALID_PATH'
  | 'INVALID_TEMPLATE_PATH'
  | 'INVALID_SHA256'
  | 'DUPLICATE_ITEM'
  | 'REQUIRED_NOT_IN_PROPERTIES'
  | 'MISSING_CODEC'
  | 'CODEC_FOR_UNKNOWN_FIELD'
  | 'CODEC_TYPE_MISMATCH'
  | 'SERVER_OWNED_INPUT_CONFLICT'
  | 'PROTOCOL_INPUT_CONFLICT'
  | 'BOUNDS_INVERTED'
  | 'OUT_OF_RANGE';

export class ContractValidationError extends Error {
  readonly code: ContractValidationCode;
  readonly path: string;

  constructor(code: ContractValidationCode, path: string, message: string) {
    super(message);
    this.name = 'ContractValidationError';
    this.code = code;
    this.path = path;
  }
}

type Obj = Record<string, unknown>;

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
const CONTRACT_ID = /^[A-Za-z][A-Za-z0-9_.]*$/;
const PROTOCOL_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TEMPLATE_PARAM = '{intentId}';

function fail(code: ContractValidationCode, path: string, message: string): never {
  throw new ContractValidationError(code, path, message);
}

function pointer(path: string, key: string | number): string {
  const escaped = String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  return `${path}/${escaped}`;
}

function isPlainObject(value: unknown): value is Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function expectObject(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
): Obj {
  if (!isPlainObject(value)) fail('EXPECTED_OBJECT', path, 'expected an object');
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail('UNKNOWN_KEY', pointer(path, key), `unknown key: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail('MISSING_KEY', pointer(path, key), `missing key: ${key}`);
  }
  return value;
}

function assertOnlyKeys(value: Obj, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      fail('UNSUPPORTED_KEYWORD', pointer(path, key), `unsupported keyword: ${key}`);
    }
  }
}

function expectString(value: unknown, path: string, minLength = 0): string {
  if (typeof value !== 'string') fail('EXPECTED_STRING', path, 'expected a string');
  if (value.length < minLength) fail('INVALID_VALUE', path, 'string is too short');
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('EXPECTED_BOOLEAN', path, 'expected a boolean');
  return value;
}

function expectSafeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)) {
    fail('EXPECTED_INTEGER', path, 'expected a safe integer');
  }
  return value;
}

function expectPositiveInteger(value: unknown, path: string): number {
  const number = expectSafeInteger(value, path);
  if (number < 1) fail('OUT_OF_RANGE', path, 'expected an integer >= 1');
  return number;
}

function expectNonNegativeInteger(value: unknown, path: string): number {
  const number = expectSafeInteger(value, path);
  if (number < 0) fail('OUT_OF_RANGE', path, 'expected an integer >= 0');
  return number;
}

function expectArray(value: unknown, path: string, minItems = 0): unknown[] {
  if (!Array.isArray(value)) fail('EXPECTED_ARRAY', path, 'expected an array');
  if (value.length < minItems) fail('INVALID_VALUE', path, `expected at least ${minItems} item(s)`);
  return value;
}

function expectLiteral<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  path: string,
): T {
  if (value !== expected) fail('INVALID_VALUE', path, `expected ${JSON.stringify(expected)}`);
  return expected;
}

function expectIdentifier(value: unknown, path: string): string {
  const text = expectString(value, path, 1);
  if (!IDENTIFIER.test(text)) fail('INVALID_ID', path, 'expected a field identifier');
  return text;
}

function expectUniqueStrings(
  value: unknown,
  path: string,
  options: { readonly minItems?: number; readonly identifiers?: boolean } = {},
): string[] {
  const array = expectArray(value, path, options.minItems ?? 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < array.length; i++) {
    const itemPath = pointer(path, i);
    const item = options.identifiers
      ? expectIdentifier(array[i], itemPath)
      : expectString(array[i], itemPath, 1);
    if (seen.has(item)) fail('DUPLICATE_ITEM', itemPath, `duplicate item: ${item}`);
    seen.add(item);
    out.push(item);
  }
  return out;
}

function validateCanonicalPath(value: unknown, path: string): string {
  const text = expectString(value, path, 1);
  if (!text.startsWith('/') || text.startsWith('//')) {
    fail('INVALID_PATH', path, 'path must start with exactly one slash');
  }
  if (/[\s\\?#]/.test(text)) {
    fail('INVALID_PATH', path, 'path must not contain whitespace, backslash, query, or fragment');
  }
  let parsed: URL;
  try {
    parsed = new URL(text, 'http://contract.invalid');
  } catch {
    fail('INVALID_PATH', path, 'path is not URL-parseable');
  }
  if (parsed.origin !== 'http://contract.invalid' || parsed.pathname !== text || parsed.search !== '' || parsed.hash !== '') {
    fail('INVALID_PATH', path, 'path is not canonical under URL round-trip');
  }
  return text;
}

function validateTemplatePath(value: unknown, path: string): string {
  const text = expectString(value, path, 1);
  if (!text.startsWith('/') || text.startsWith('//')) {
    fail('INVALID_TEMPLATE_PATH', path, 'path must start with exactly one slash');
  }
  if (/[\s\\#]/.test(text) || text.includes('{') === false) {
    fail('INVALID_TEMPLATE_PATH', path, 'template path must not contain whitespace, backslash, or fragment');
  }
  const first = text.indexOf(TEMPLATE_PARAM);
  if (first < 0 || text.indexOf(TEMPLATE_PARAM, first + TEMPLATE_PARAM.length) >= 0) {
    fail('INVALID_TEMPLATE_PATH', path, 'template path must contain exactly one {intentId}');
  }
  if (!text.endsWith(TEMPLATE_PARAM)) {
    fail('INVALID_TEMPLATE_PATH', path, 'template path must end with {intentId}');
  }
  if (/[{}]/.test(text.replace(TEMPLATE_PARAM, ''))) {
    fail('INVALID_TEMPLATE_PATH', path, 'template path contains an unsupported template expression');
  }
  const placeholder = text.replace(TEMPLATE_PARAM, 'intent_placeholder');
  let parsed: URL;
  try {
    parsed = new URL(placeholder, 'http://contract.invalid');
  } catch {
    fail('INVALID_TEMPLATE_PATH', path, 'template path is not URL-parseable');
  }
  if (
    parsed.origin !== 'http://contract.invalid' ||
    parsed.hash !== '' ||
    parsed.pathname + parsed.search !== placeholder
  ) {
    fail('INVALID_TEMPLATE_PATH', path, 'template path is not canonical under URL round-trip');
  }
  return text;
}

function validateStringConstraints(obj: Obj, path: string): void {
  const minLength = obj.minLength === undefined ? undefined : expectNonNegativeInteger(obj.minLength, pointer(path, 'minLength'));
  const maxLength = obj.maxLength === undefined ? undefined : expectNonNegativeInteger(obj.maxLength, pointer(path, 'maxLength'));
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    fail('BOUNDS_INVERTED', path, 'minLength must not exceed maxLength');
  }
  const constValue = obj.const === undefined ? undefined : expectString(obj.const, pointer(path, 'const'));
  let enumValues: string[] | undefined;
  if (obj.enum !== undefined) {
    const values = expectArray(obj.enum, pointer(path, 'enum'), 1);
    const seen = new Set<string>();
    enumValues = values.map((value, index) => {
      const item = expectString(value, pointer(pointer(path, 'enum'), index));
      if (seen.has(item)) fail('DUPLICATE_ITEM', pointer(pointer(path, 'enum'), index), 'duplicate enum value');
      seen.add(item);
      return item;
    });
    if (constValue !== undefined && !enumValues.includes(constValue)) {
      fail('OUT_OF_RANGE', pointer(path, 'const'), 'const must be one of the enum values');
    }
  }
  if (obj.pattern !== undefined) {
    const pattern = expectString(obj.pattern, pointer(path, 'pattern'));
    if (!(SUPPORTED_STRING_PATTERNS as readonly string[]).includes(pattern)) {
      fail('UNSUPPORTED_PATTERN', pointer(path, 'pattern'), `unsupported pattern: ${pattern}`);
    }
  }
  for (const value of [constValue, ...(enumValues ?? [])]) {
    if (value === undefined) continue;
    const length = [...value].length;
    if ((minLength !== undefined && length < minLength) || (maxLength !== undefined && length > maxLength)) {
      fail('OUT_OF_RANGE', path, 'const or enum value is outside minLength/maxLength');
    }
    if (typeof obj.pattern === 'string' && !new RegExp(obj.pattern).test(value)) {
      fail('OUT_OF_RANGE', path, 'const or enum value does not match pattern');
    }
  }
  assertOnlyKeys(obj, ['type', 'minLength', 'maxLength', 'const', 'enum', 'pattern'], path);
}

function validateIntegerConstraints(obj: Obj, path: string): void {
  const minimum = obj.minimum === undefined ? undefined : expectSafeInteger(obj.minimum, pointer(path, 'minimum'));
  const maximum = obj.maximum === undefined ? undefined : expectSafeInteger(obj.maximum, pointer(path, 'maximum'));
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    fail('BOUNDS_INVERTED', path, 'minimum must not exceed maximum');
  }
  const constValue = obj.const === undefined ? undefined : expectSafeInteger(obj.const, pointer(path, 'const'));
  let enumValues: number[] | undefined;
  if (obj.enum !== undefined) {
    const values = expectArray(obj.enum, pointer(path, 'enum'), 1);
    const seen = new Set<number>();
    enumValues = values.map((value, index) => {
      const item = expectSafeInteger(value, pointer(pointer(path, 'enum'), index));
      if (seen.has(item)) fail('DUPLICATE_ITEM', pointer(pointer(path, 'enum'), index), 'duplicate enum value');
      seen.add(item);
      return item;
    });
    if (constValue !== undefined && !enumValues.includes(constValue)) {
      fail('OUT_OF_RANGE', pointer(path, 'const'), 'const must be one of the enum values');
    }
  }
  for (const value of [constValue, ...(enumValues ?? [])]) {
    if (value === undefined) continue;
    if ((minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
      fail('OUT_OF_RANGE', path, 'const or enum value is outside minimum/maximum');
    }
  }
  assertOnlyKeys(obj, ['type', 'minimum', 'maximum', 'const', 'enum'], path);
}

export function validateFieldSchema(value: unknown, path = '$'): FieldSchema {
  if (!isPlainObject(value)) {
    fail('EXPECTED_OBJECT', path, 'expected a field schema object');
  }
  assertOnlyKeys(
    value,
    ['type', 'minLength', 'maxLength', 'const', 'enum', 'pattern', 'minimum', 'maximum'],
    path,
  );
  const obj = expectObject(
    value,
    path,
    ['type', 'minLength', 'maxLength', 'const', 'enum', 'pattern', 'minimum', 'maximum'],
    ['type'],
  );
  const type = expectString(obj.type, pointer(path, 'type'));
  if (type === 'string') {
    validateStringConstraints(obj, path);
    return obj as unknown as FieldSchema;
  }
  if (type === 'integer') {
    validateIntegerConstraints(obj, path);
    return obj as unknown as FieldSchema;
  }
  fail('INVALID_VALUE', pointer(path, 'type'), 'supported types are string and integer');
}

export function validateObjectSchema(value: unknown, path = '$'): ObjectSchema {
  const obj = expectObject(
    value,
    path,
    ['type', 'additionalProperties', 'required', 'properties'],
    ['type', 'additionalProperties', 'required', 'properties'],
  );
  expectLiteral(obj.type, 'object', pointer(path, 'type'));
  expectLiteral(obj.additionalProperties, false, pointer(path, 'additionalProperties'));
  const required = expectUniqueStrings(obj.required, pointer(path, 'required'), { identifiers: true });
  if (!isPlainObject(obj.properties)) {
    fail('EXPECTED_OBJECT', pointer(path, 'properties'), 'expected an object');
  }
  const properties = obj.properties;
  if (Object.keys(properties).length === 0) {
    fail('INVALID_VALUE', pointer(path, 'properties'), 'properties must not be empty');
  }
  const fields: Record<string, FieldSchema> = Object.create(null);
  for (const key of Object.keys(properties)) {
    const fieldPath = pointer(pointer(path, 'properties'), key);
    expectIdentifier(key, fieldPath);
    fields[key] = validateFieldSchema(properties[key], fieldPath);
  }
  for (const key of required) {
    if (!Object.hasOwn(fields, key)) {
      fail('REQUIRED_NOT_IN_PROPERTIES', pointer(pointer(path, 'required'), key), `required field is not declared: ${key}`);
    }
  }
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties: fields,
  };
}

function validateScalarSemantics(value: unknown, path: string): void {
  const obj = expectObject(
    value,
    path,
    ['missing', 'emptyString', 'textNormalization', 'schemaStringLength', 'validationMutatesData'],
    ['missing', 'emptyString', 'textNormalization', 'schemaStringLength', 'validationMutatesData'],
  );
  expectLiteral(obj.missing, 'absent', pointer(path, 'missing'));
  expectLiteral(obj.emptyString, 'preserve', pointer(path, 'emptyString'));
  expectLiteral(obj.textNormalization, 'none', pointer(path, 'textNormalization'));
  expectLiteral(obj.schemaStringLength, 'unicode-code-points', pointer(path, 'schemaStringLength'));
  expectLiteral(obj.validationMutatesData, false, pointer(path, 'validationMutatesData'));
}

export function validateInputContract(value: unknown, path = '$'): InputContract {
  const obj = expectObject(
    value,
    path,
    ['schema', 'codecs', 'unknownKeys', 'duplicateScalars', 'scalarSemantics'],
    ['schema', 'codecs', 'unknownKeys', 'duplicateScalars', 'scalarSemantics'],
  );
  const schema = validateObjectSchema(obj.schema, pointer(path, 'schema'));
  if (!isPlainObject(obj.codecs)) {
    fail('EXPECTED_OBJECT', pointer(path, 'codecs'), 'expected a codecs object');
  }
  const codecs: Record<string, CodecName> = Object.create(null);
  for (const key of Object.keys(obj.codecs)) {
    const codecPath = pointer(pointer(path, 'codecs'), key);
    expectIdentifier(key, codecPath);
    const codec = expectString(obj.codecs[key], codecPath);
    if (codec !== 'text' && codec !== 'decimal-integer') {
      fail('INVALID_VALUE', codecPath, 'supported codecs are text and decimal-integer');
    }
    codecs[key] = codec;
  }
  for (const key of Object.keys(schema.properties)) {
    if (!Object.hasOwn(codecs, key)) {
      fail('MISSING_CODEC', pointer(pointer(path, 'codecs'), key), `missing codec for field: ${key}`);
    }
    const expected = schema.properties[key]!.type === 'string' ? 'text' : 'decimal-integer';
    if (codecs[key] !== expected) {
      fail(
        'CODEC_TYPE_MISMATCH',
        pointer(pointer(path, 'codecs'), key),
        `codec ${codecs[key]} does not match field type ${schema.properties[key]!.type}`,
      );
    }
  }
  for (const key of Object.keys(codecs)) {
    if (!Object.hasOwn(schema.properties, key)) {
      fail('CODEC_FOR_UNKNOWN_FIELD', pointer(pointer(path, 'codecs'), key), `codec for unknown field: ${key}`);
    }
  }
  expectLiteral(obj.unknownKeys, 'reject', pointer(path, 'unknownKeys'));
  expectLiteral(obj.duplicateScalars, 'reject', pointer(path, 'duplicateScalars'));
  validateScalarSemantics(obj.scalarSemantics, pointer(path, 'scalarSemantics'));
  return {
    schema,
    codecs,
    unknownKeys: 'reject',
    duplicateScalars: 'reject',
    scalarSemantics: {
      missing: 'absent',
      emptyString: 'preserve',
      textNormalization: 'none',
      schemaStringLength: 'unicode-code-points',
      validationMutatesData: false,
    },
  };
}

function validateHttp(value: unknown, path: string): BoundaryContract['http'] {
  const obj = expectObject(
    value,
    path,
    [
      'method', 'path', 'body', 'maxBytes', 'maxEntries', 'maxKeyBytes', 'maxValueBytes',
      'charset', 'contentEncoding', 'parserProfile',
    ],
    [
      'method', 'path', 'body', 'maxBytes', 'maxEntries', 'maxKeyBytes', 'maxValueBytes',
      'charset', 'contentEncoding', 'parserProfile',
    ],
  );
  expectLiteral(obj.method, 'POST', pointer(path, 'method'));
  const requestPath = validateCanonicalPath(obj.path, pointer(path, 'path'));
  expectLiteral(obj.body, 'urlencoded', pointer(path, 'body'));
  const maxBytes = expectPositiveInteger(obj.maxBytes, pointer(path, 'maxBytes'));
  const maxEntries = expectPositiveInteger(obj.maxEntries, pointer(path, 'maxEntries'));
  const maxKeyBytes = expectPositiveInteger(obj.maxKeyBytes, pointer(path, 'maxKeyBytes'));
  const maxValueBytes = expectPositiveInteger(obj.maxValueBytes, pointer(path, 'maxValueBytes'));
  expectLiteral(obj.charset, 'utf-8', pointer(path, 'charset'));
  expectLiteral(obj.contentEncoding, 'identity-only', pointer(path, 'contentEncoding'));
  const parserProfile = expectString(obj.parserProfile, pointer(path, 'parserProfile'));
  if (parserProfile !== SUPPORTED_PARSER_PROFILE) {
    fail('INVALID_VALUE', pointer(path, 'parserProfile'), `unsupported parser profile: ${parserProfile}`);
  }
  return {
    method: 'POST',
    path: requestPath,
    body: 'urlencoded',
    maxBytes,
    maxEntries,
    maxKeyBytes,
    maxValueBytes,
    charset: 'utf-8',
    contentEncoding: 'identity-only',
    parserProfile,
  };
}

function validateProtocol(value: unknown, path: string): BoundaryContract['protocol'] {
  const obj = expectObject(
    value,
    path,
    ['csrfField', 'requestKeyField', 'countProtocolEntries'],
    ['csrfField', 'requestKeyField', 'countProtocolEntries'],
  );
  expectLiteral(obj.csrfField, SUPPORTED_CSRF_FIELD, pointer(path, 'csrfField'));
  expectLiteral(obj.requestKeyField, SUPPORTED_REQUEST_KEY_FIELD, pointer(path, 'requestKeyField'));
  expectLiteral(obj.countProtocolEntries, true, pointer(path, 'countProtocolEntries'));
  return {
    csrfField: SUPPORTED_CSRF_FIELD,
    requestKeyField: SUPPORTED_REQUEST_KEY_FIELD,
    countProtocolEntries: true,
  };
}

function validateBindings(value: unknown, path: string): BoundaryContract['bindings'] {
  const obj = expectObject(
    value,
    path,
    ['module', 'export', 'kind', 'roleType'],
    ['module', 'export', 'kind', 'roleType'],
  );
  const moduleName = expectString(obj.module, pointer(path, 'module'), 1);
  const exportName = expectIdentifier(obj.export, pointer(path, 'export'));
  expectLiteral(obj.kind, 'typed-factory', pointer(path, 'kind'));
  expectLiteral(obj.roleType, 'BindingRoleMap', pointer(path, 'roleType'));
  return { module: moduleName, export: exportName, kind: 'typed-factory', roleType: 'BindingRoleMap' };
}

function validateIdempotency(value: unknown, path: string): BoundaryContract['guards']['idempotency'] {
  const obj = expectObject(
    value,
    path,
    [
      'intent', 'intentTtlSeconds', 'resultRetentionSeconds', 'busyRetryBudgetMs',
      'retryAfterSeconds', 'replay', 'digest', 'issuedResourceRevision', 'missingIntent',
      'resultStorage', 'expiryComparison', 'statePolicy', 'readConsistency', 'replayLock',
      'corruption',
    ],
    [
      'intent', 'intentTtlSeconds', 'resultRetentionSeconds', 'busyRetryBudgetMs',
      'retryAfterSeconds', 'replay', 'digest', 'issuedResourceRevision', 'missingIntent',
      'resultStorage', 'expiryComparison', 'statePolicy', 'readConsistency', 'replayLock',
      'corruption',
    ],
  );
  expectLiteral(obj.intent, 'server-persisted', pointer(path, 'intent'));
  const intentTtlSeconds = expectPositiveInteger(obj.intentTtlSeconds, pointer(path, 'intentTtlSeconds'));
  const resultRetentionSeconds = expectPositiveInteger(obj.resultRetentionSeconds, pointer(path, 'resultRetentionSeconds'));
  const busyRetryBudgetMs = expectPositiveInteger(obj.busyRetryBudgetMs, pointer(path, 'busyRetryBudgetMs'));
  const retryAfterSeconds = expectPositiveInteger(obj.retryAfterSeconds, pointer(path, 'retryAfterSeconds'));
  expectLiteral(obj.replay, 'current-receipt-authorization', pointer(path, 'replay'));
  expectLiteral(obj.digest, 'boundary-behavior/1', pointer(path, 'digest'));
  expectLiteral(obj.issuedResourceRevision, 'required', pointer(path, 'issuedResourceRevision'));
  expectLiteral(obj.missingIntent, 'never-create-on-submit', pointer(path, 'missingIntent'));
  expectLiteral(obj.resultStorage, 'receipt-reference', pointer(path, 'resultStorage'));
  expectLiteral(obj.expiryComparison, 'now-greater-than-or-equal', pointer(path, 'expiryComparison'));
  expectLiteral(obj.statePolicy, 'intent-state/2', pointer(path, 'statePolicy'));
  expectLiteral(obj.readConsistency, 'fresh-local-snapshot', pointer(path, 'readConsistency'));
  expectLiteral(obj.replayLock, 'read-only-transaction', pointer(path, 'replayLock'));
  expectLiteral(obj.corruption, '500-preserve-evidence', pointer(path, 'corruption'));
  return {
    intent: 'server-persisted',
    intentTtlSeconds,
    resultRetentionSeconds,
    busyRetryBudgetMs,
    retryAfterSeconds,
    replay: 'current-receipt-authorization',
    digest: 'boundary-behavior/1',
    issuedResourceRevision: 'required',
    missingIntent: 'never-create-on-submit',
    resultStorage: 'receipt-reference',
    expiryComparison: 'now-greater-than-or-equal',
    statePolicy: 'intent-state/2',
    readConsistency: 'fresh-local-snapshot',
    replayLock: 'read-only-transaction',
    corruption: '500-preserve-evidence',
  };
}

function validateGuards(value: unknown, path: string): BoundaryContract['guards'] {
  const obj = expectObject(
    value,
    path,
    ['csrf', 'originProfile', 'transaction', 'resourceRevision', 'idempotency'],
    ['csrf', 'originProfile', 'transaction', 'resourceRevision', 'idempotency'],
  );
  expectLiteral(obj.csrf, 'session-synchronizer', pointer(path, 'csrf'));
  expectLiteral(obj.originProfile, 'same-origin-with-referer-fallback', pointer(path, 'originProfile'));
  expectLiteral(obj.transaction, 'sqlite-immediate-sync', pointer(path, 'transaction'));
  expectLiteral(obj.resourceRevision, 'required-cas', pointer(path, 'resourceRevision'));
  return {
    csrf: 'session-synchronizer',
    originProfile: 'same-origin-with-referer-fallback',
    transaction: 'sqlite-immediate-sync',
    resourceRevision: 'required-cas',
    idempotency: validateIdempotency(obj.idempotency, pointer(path, 'idempotency')),
  };
}

function validateOutput(value: unknown, path: string): BoundaryContract['output'] {
  const obj = expectObject(value, path, ['schema', 'cache', 'mode'], ['schema', 'cache', 'mode']);
  const schema = validateObjectSchema(obj.schema, pointer(path, 'schema'));
  expectLiteral(obj.cache, 'private-no-store', pointer(path, 'cache'));
  expectLiteral(obj.mode, 'explicit-projection', pointer(path, 'mode'));
  return { schema, cache: 'private-no-store', mode: 'explicit-projection' };
}

function validateInitialResponse(value: unknown, path: string): BoundaryContract['page']['initialResponse'] {
  const obj = expectObject(value, path, ['status', 'renderer'], ['status', 'renderer']);
  expectLiteral(obj.status, 200, pointer(path, 'status'));
  expectLiteral(obj.renderer, 'renderStart', pointer(path, 'renderer'));
  return { status: 200, renderer: 'renderStart' };
}

function validateIntentInitialization(value: unknown, path: string): BoundaryContract['page']['intentInitialization'] {
  const obj = expectObject(
    value,
    path,
    ['status', 'location', 'method', 'path', 'csrf', 'inputFields', 'authorization', 'snapshot', 'getCreatesIntent'],
    ['status', 'location', 'method', 'path', 'csrf', 'inputFields', 'authorization', 'snapshot', 'getCreatesIntent'],
  );
  expectLiteral(obj.status, 303, pointer(path, 'status'));
  const location = validateTemplatePath(obj.location, pointer(path, 'location'));
  expectLiteral(obj.method, 'POST', pointer(path, 'method'));
  const beginPath = validateCanonicalPath(obj.path, pointer(path, 'path'));
  expectLiteral(obj.csrf, 'session-synchronizer', pointer(path, 'csrf'));
  const inputFields = expectUniqueStrings(obj.inputFields, pointer(path, 'inputFields'), { minItems: 1, identifiers: true });
  const authorization = expectString(obj.authorization, pointer(path, 'authorization'), 1);
  expectLiteral(obj.snapshot, 'store-resource-revision', pointer(path, 'snapshot'));
  expectLiteral(obj.getCreatesIntent, false, pointer(path, 'getCreatesIntent'));
  return {
    status: 303,
    location,
    method: 'POST',
    path: beginPath,
    csrf: 'session-synchronizer',
    inputFields,
    authorization,
    snapshot: 'store-resource-revision',
    getCreatesIntent: false,
  };
}

function validatePage(value: unknown, path: string): BoundaryContract['page'] {
  const obj = expectObject(
    value,
    path,
    ['path', 'viewSchema', 'initialResponse', 'intentInitialization', 'queryModes', 'authorization', 'resolver'],
    ['path', 'viewSchema', 'initialResponse', 'intentInitialization', 'queryModes', 'authorization', 'resolver'],
  );
  const pagePath = validateCanonicalPath(obj.path, pointer(path, 'path'));
  const viewSchema = validateObjectSchema(obj.viewSchema, pointer(path, 'viewSchema'));
  const initialResponse = validateInitialResponse(obj.initialResponse, pointer(path, 'initialResponse'));
  const intentInitialization = validateIntentInitialization(obj.intentInitialization, pointer(path, 'intentInitialization'));
  const queryModes = expectUniqueStrings(obj.queryModes, pointer(path, 'queryModes'), { minItems: 1, identifiers: true });
  const authorization = expectString(obj.authorization, pointer(path, 'authorization'), 1);
  expectLiteral(obj.resolver, 'resolvePage', pointer(path, 'resolver'));
  return {
    path: pagePath,
    viewSchema,
    initialResponse,
    intentInitialization,
    queryModes,
    authorization,
    resolver: 'resolvePage',
  };
}

function validateReceipt(value: unknown, path: string): BoundaryContract['response']['receipt'] {
  const obj = expectObject(
    value,
    path,
    ['method', 'path', 'load', 'authorize', 'project', 'renderer'],
    ['method', 'path', 'load', 'authorize', 'project', 'renderer'],
  );
  expectLiteral(obj.method, 'GET', pointer(path, 'method'));
  const receiptPath = validateCanonicalPath(obj.path, pointer(path, 'path'));
  const segments = receiptPath.split('/');
  if (segments.filter((segment) => segment === ':orderId').length !== 1 ||
      segments.some((segment) => segment !== ':orderId' && /[:*{}]/.test(segment))) {
    fail('INVALID_TEMPLATE_PATH', pointer(path, 'path'), 'receipt route must contain exactly one :orderId path segment and no other route parameters');
  }
  expectLiteral(obj.load, 'loadReceipt', pointer(path, 'load'));
  expectLiteral(obj.authorize, 'authorizeReceipt', pointer(path, 'authorize'));
  expectLiteral(obj.project, 'projectReceipt', pointer(path, 'project'));
  expectLiteral(obj.renderer, 'renderReceipt', pointer(path, 'renderer'));
  return { method: 'GET', path: receiptPath, load: 'loadReceipt', authorize: 'authorizeReceipt', project: 'projectReceipt', renderer: 'renderReceipt' };
}

function validateResponse(value: unknown, path: string): BoundaryContract['response'] {
  const obj = expectObject(
    value,
    path,
    ['mode', 'success', 'invalid', 'receipt', 'deniedOrMissing', 'otherErrors'],
    ['mode', 'success', 'invalid', 'receipt', 'deniedOrMissing', 'otherErrors'],
  );
  expectLiteral(obj.mode, 'native-html', pointer(path, 'mode'));
  const success = expectObject(obj.success, pointer(path, 'success'), ['status', 'route', 'parameterFrom'], ['status', 'route', 'parameterFrom']);
  expectLiteral(success.status, 303, pointer(pointer(path, 'success'), 'status'));
  expectLiteral(success.route, 'receipt', pointer(pointer(path, 'success'), 'route'));
  expectLiteral(success.parameterFrom, 'output.orderId', pointer(pointer(path, 'success'), 'parameterFrom'));
  const invalid = expectObject(obj.invalid, pointer(path, 'invalid'), ['status', 'renderer', 'preserve', 'keepIntent'], ['status', 'renderer', 'preserve', 'keepIntent']);
  expectLiteral(invalid.status, 422, pointer(pointer(path, 'invalid'), 'status'));
  expectLiteral(invalid.renderer, 'renderForm', pointer(pointer(path, 'invalid'), 'renderer'));
  expectLiteral(invalid.preserve, 'allowed-bounded-raw-values', pointer(pointer(path, 'invalid'), 'preserve'));
  expectLiteral(invalid.keepIntent, true, pointer(pointer(path, 'invalid'), 'keepIntent'));
  const receipt = validateReceipt(obj.receipt, pointer(path, 'receipt'));
  expectLiteral(obj.deniedOrMissing, 404, pointer(path, 'deniedOrMissing'));
  expectLiteral(obj.otherErrors, 'escaped-generic-html', pointer(path, 'otherErrors'));
  return {
    mode: 'native-html',
    success: { status: 303, route: 'receipt', parameterFrom: 'output.orderId' },
    invalid: { status: 422, renderer: 'renderForm', preserve: 'allowed-bounded-raw-values', keepIntent: true },
    receipt,
    deniedOrMissing: 404,
    otherErrors: 'escaped-generic-html',
  };
}

function validateHeaders(value: unknown, path: string): BoundaryContract['headers'] {
  const obj = expectObject(
    value,
    path,
    ['cacheControl', 'contentType', 'xContentTypeOptions', 'referrerPolicy', 'contentSecurityPolicy'],
    ['cacheControl', 'contentType', 'xContentTypeOptions', 'referrerPolicy', 'contentSecurityPolicy'],
  );
  expectLiteral(obj.cacheControl, 'private, no-store', pointer(path, 'cacheControl'));
  expectLiteral(obj.contentType, 'text/html; charset=utf-8', pointer(path, 'contentType'));
  expectLiteral(obj.xContentTypeOptions, 'nosniff', pointer(path, 'xContentTypeOptions'));
  expectLiteral(obj.referrerPolicy, 'same-origin', pointer(path, 'referrerPolicy'));
  const contentSecurityPolicy = expectString(obj.contentSecurityPolicy, pointer(path, 'contentSecurityPolicy'), 1);
  return {
    cacheControl: 'private, no-store',
    contentType: 'text/html; charset=utf-8',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'same-origin',
    contentSecurityPolicy,
  };
}

export function validateBoundaryContract(value: JsonValue): BoundaryContract {
  const obj = expectObject(
    value,
    '$',
    [
      'format', 'status', 'id', 'operation', 'sourceMode', 'http', 'protocol', 'input',
      'serverOwnedFields', 'bindings', 'guards', 'output', 'page', 'response', 'headers',
      'operationRevision',
    ],
    [
      'format', 'status', 'id', 'operation', 'sourceMode', 'http', 'protocol', 'input',
      'serverOwnedFields', 'bindings', 'guards', 'output', 'page', 'response', 'headers',
      'operationRevision',
    ],
  );
  expectLiteral(obj.format, CONTRACT_FORMAT, '/format');
  expectLiteral(obj.status, 'design-reference', '/status');
  const id = expectString(obj.id, '/id', 1);
  if (!CONTRACT_ID.test(id)) fail('INVALID_ID', '/id', 'contract id must start with a letter and contain [A-Za-z0-9_.]');
  expectLiteral(obj.operation, 'write', '/operation');
  expectLiteral(obj.sourceMode, 'json-authoritative', '/sourceMode');
  const http = validateHttp(obj.http, '/http');
  const protocol = validateProtocol(obj.protocol, '/protocol');
  const input = validateInputContract(obj.input, '/input');
  const serverOwnedFields = expectUniqueStrings(obj.serverOwnedFields, '/serverOwnedFields', { identifiers: true });
  for (const key of serverOwnedFields) {
    if (Object.hasOwn(input.schema.properties, key)) {
      fail('SERVER_OWNED_INPUT_CONFLICT', '/serverOwnedFields', `server-owned field is also an input: ${key}`);
    }
  }
  for (const key of [protocol.csrfField, protocol.requestKeyField]) {
    if (Object.hasOwn(input.schema.properties, key)) {
      fail('PROTOCOL_INPUT_CONFLICT', '/input/schema/properties', `protocol field is also an input: ${key}`);
    }
  }
  const bindings = validateBindings(obj.bindings, '/bindings');
  const guards = validateGuards(obj.guards, '/guards');
  const output = validateOutput(obj.output, '/output');
  const page = validatePage(obj.page, '/page');
  for (const key of page.intentInitialization.inputFields) {
    if (!Object.hasOwn(input.schema.properties, key)) {
      fail('MISSING_KEY', '/page/intentInitialization/inputFields', `begin input field is not declared in input.schema: ${key}`);
    }
  }
  const response = validateResponse(obj.response, '/response');
  if (!output.schema.required.includes('orderId') || output.schema.properties.orderId?.type !== 'string') {
    fail('INVALID_VALUE', '/output/schema/properties/orderId', 'receipt redirect requires a required string orderId output');
  }
  const headers = validateHeaders(obj.headers, '/headers');
  const operationRevision = expectPositiveInteger(obj.operationRevision, '/operationRevision');
  return {
    format: CONTRACT_FORMAT,
    status: 'design-reference',
    id,
    operation: 'write',
    sourceMode: 'json-authoritative',
    http,
    protocol,
    input,
    serverOwnedFields,
    bindings,
    guards,
    output,
    page,
    response,
    headers,
    operationRevision,
  };
}

function validateFormCheckSource(value: unknown, path: string): FormCheck['source'] {
  const obj = expectObject(
    value,
    path,
    ['path', 'sha256', 'generator', 'projection', 'runtimeCoverage', 'behaviorSha256'],
    ['path', 'sha256', 'generator', 'projection', 'runtimeCoverage', 'behaviorSha256'],
  );
  const sourcePath = expectString(obj.path, pointer(path, 'path'), 1);
  const sha256 = expectString(obj.sha256, pointer(path, 'sha256'));
  if (!SHA256.test(sha256)) fail('INVALID_SHA256', pointer(path, 'sha256'), 'expected a lowercase SHA-256 hex digest');
  const generator = expectString(obj.generator, pointer(path, 'generator'), 1);
  expectLiteral(obj.projection, 'exact-for-selected-structural-fields', pointer(path, 'projection'));
  expectLiteral(obj.runtimeCoverage, 'not-evaluated', pointer(path, 'runtimeCoverage'));
  const behaviorSha256 = expectString(obj.behaviorSha256, pointer(path, 'behaviorSha256'));
  if (!SHA256.test(behaviorSha256)) fail('INVALID_SHA256', pointer(path, 'behaviorSha256'), 'expected a lowercase SHA-256 hex digest');
  return {
    path: sourcePath,
    sha256,
    generator,
    projection: 'exact-for-selected-structural-fields',
    runtimeCoverage: 'not-evaluated',
    behaviorSha256,
  };
}

function validateFormCheckAction(value: unknown, path: string): FormCheck['action'] {
  const obj = expectObject(
    value,
    path,
    ['id', 'method', 'path', 'encoding', 'parserProfile'],
    ['id', 'method', 'path', 'encoding', 'parserProfile'],
  );
  const id = expectString(obj.id, pointer(path, 'id'), 1);
  expectLiteral(obj.method, 'POST', pointer(path, 'method'));
  const actionPath = validateCanonicalPath(obj.path, pointer(path, 'path'));
  expectLiteral(obj.encoding, 'urlencoded', pointer(path, 'encoding'));
  const parserProfile = expectString(obj.parserProfile, pointer(path, 'parserProfile'));
  if (parserProfile !== SUPPORTED_PARSER_PROFILE) {
    fail('INVALID_VALUE', pointer(path, 'parserProfile'), `unsupported parser profile: ${parserProfile}`);
  }
  return { id, method: 'POST', path: actionPath, encoding: 'urlencoded', parserProfile };
}

export function validateFormCheck(value: JsonValue): FormCheck {
  const obj = expectObject(
    value,
    '$',
    ['format', 'status', 'source', 'action', 'input', 'protocolFields'],
    ['format', 'status', 'source', 'action', 'input', 'protocolFields'],
  );
  expectLiteral(obj.format, FORM_CHECK_FORMAT, '/format');
  if (obj.status !== 'generated' && obj.status !== 'generated-design-reference-not-product-output') {
    fail('INVALID_VALUE', '/status', 'expected a generated form projection');
  }
  const source = validateFormCheckSource(obj.source, '/source');
  const action = validateFormCheckAction(obj.action, '/action');
  const input = validateInputContract(obj.input, '/input');
  const protocolFields = expectUniqueStrings(obj.protocolFields, '/protocolFields');
  for (let i = 0; i < protocolFields.length; i++) {
    if (!PROTOCOL_FIELD.test(protocolFields[i]!)) {
      fail('INVALID_ID', pointer('/protocolFields', i), 'expected a protocol field name');
    }
    if (Object.hasOwn(input.schema.properties, protocolFields[i]!)) {
      fail('PROTOCOL_INPUT_CONFLICT', pointer('/protocolFields', i), 'protocol field is also an input');
    }
  }
  return {
    format: FORM_CHECK_FORMAT,
    status: obj.status,
    source,
    action,
    input,
    protocolFields,
  };
}
