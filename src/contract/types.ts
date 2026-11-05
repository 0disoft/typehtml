import type { JsonObject } from './strict-json.ts';

export const CONTRACT_FORMAT = 'boundary-contract/0.5-draft';
export const FORM_CHECK_FORMAT = 'boundary-form-check/0.2-draft';
export const SUPPORTED_PARSER_PROFILE = 'strict-urlencoded-utf8/1';
export const SUPPORTED_CSRF_FIELD = '_bc_csrf';
export const SUPPORTED_REQUEST_KEY_FIELD = '_bc_request';
export const SUPPORTED_STRING_PATTERNS = Object.freeze([
  '^draft_[A-Za-z0-9_-]{1,58}$',
] as const);

export type CodecName = 'text' | 'decimal-integer';

export interface StringFieldSchema {
  readonly type: 'string';
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly const?: string;
  readonly enum?: readonly string[];
  readonly pattern?: string;
}

export interface IntegerFieldSchema {
  readonly type: 'integer';
  readonly minimum?: number;
  readonly maximum?: number;
  readonly const?: number;
  readonly enum?: readonly number[];
}

export type FieldSchema = StringFieldSchema | IntegerFieldSchema;

export interface ObjectSchema {
  readonly type: 'object';
  readonly additionalProperties: false;
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, FieldSchema>>;
}

export interface ScalarSemantics {
  readonly missing: 'absent';
  readonly emptyString: 'preserve';
  readonly textNormalization: 'none';
  readonly schemaStringLength: 'unicode-code-points';
  readonly validationMutatesData: false;
}

export interface InputContract {
  readonly schema: ObjectSchema;
  readonly codecs: Readonly<Record<string, CodecName>>;
  readonly unknownKeys: 'reject';
  readonly duplicateScalars: 'reject';
  readonly scalarSemantics: ScalarSemantics;
}

export interface HttpContract {
  readonly method: 'POST';
  readonly path: string;
  readonly body: 'urlencoded';
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly maxKeyBytes: number;
  readonly maxValueBytes: number;
  readonly charset: 'utf-8';
  readonly contentEncoding: 'identity-only';
  readonly parserProfile: string;
}

export interface ProtocolContract {
  readonly csrfField: string;
  readonly requestKeyField: string;
  readonly countProtocolEntries: true;
}

export interface BindingContract {
  readonly module: string;
  readonly export: string;
  readonly kind: 'typed-factory';
  readonly roleType: 'BindingRoleMap';
}

export interface IdempotencyContract {
  readonly intent: 'server-persisted';
  readonly intentTtlSeconds: number;
  readonly resultRetentionSeconds: number;
  readonly busyRetryBudgetMs: number;
  readonly retryAfterSeconds: number;
  readonly replay: 'current-receipt-authorization';
  readonly digest: 'boundary-behavior/1';
  readonly issuedResourceRevision: 'required';
  readonly missingIntent: 'never-create-on-submit';
  readonly resultStorage: 'receipt-reference';
  readonly expiryComparison: 'now-greater-than-or-equal';
  readonly statePolicy: 'intent-state/2';
  readonly readConsistency: 'fresh-local-snapshot';
  readonly replayLock: 'read-only-transaction';
  readonly corruption: '500-preserve-evidence';
}

export interface GuardsContract {
  readonly csrf: 'session-synchronizer';
  readonly originProfile: 'same-origin-with-referer-fallback';
  readonly transaction: 'sqlite-immediate-sync';
  readonly resourceRevision: 'required-cas';
  readonly idempotency: IdempotencyContract;
}

export interface OutputContract {
  readonly schema: ObjectSchema;
  readonly cache: 'private-no-store';
  readonly mode: 'explicit-projection';
}

export interface InitialResponseContract {
  readonly status: 200;
  readonly renderer: 'renderStart';
}

export interface IntentInitializationContract {
  readonly status: 303;
  readonly location: string;
  readonly method: 'POST';
  readonly path: string;
  readonly csrf: 'session-synchronizer';
  readonly inputFields: readonly string[];
  readonly authorization: string;
  readonly snapshot: 'store-resource-revision';
  readonly getCreatesIntent: false;
}

export interface PageContract {
  readonly path: string;
  readonly viewSchema: ObjectSchema;
  readonly initialResponse: InitialResponseContract;
  readonly intentInitialization: IntentInitializationContract;
  readonly queryModes: readonly string[];
  readonly authorization: string;
  readonly resolver: 'resolvePage';
}

export interface ReceiptContract {
  readonly method: 'GET';
  readonly path: string;
  readonly load: 'loadReceipt';
  readonly authorize: 'authorizeReceipt';
  readonly project: 'projectReceipt';
  readonly renderer: 'renderReceipt';
}

export interface ResponseContract {
  readonly mode: 'native-html';
  readonly success: {
    readonly status: 303;
    readonly route: 'receipt';
    readonly parameterFrom: 'output.orderId';
  };
  readonly invalid: {
    readonly status: 422;
    readonly renderer: 'renderForm';
    readonly preserve: 'allowed-bounded-raw-values';
    readonly keepIntent: true;
  };
  readonly receipt: ReceiptContract;
  readonly deniedOrMissing: 404;
  readonly otherErrors: 'escaped-generic-html';
}

export interface HeadersContract {
  readonly cacheControl: 'private, no-store';
  readonly contentType: 'text/html; charset=utf-8';
  readonly xContentTypeOptions: 'nosniff';
  readonly referrerPolicy: 'same-origin';
  readonly contentSecurityPolicy: string;
}

export interface BoundaryContract {
  readonly format: typeof CONTRACT_FORMAT;
  readonly status: 'design-reference';
  readonly id: string;
  readonly operation: 'write';
  readonly sourceMode: 'json-authoritative';
  readonly http: HttpContract;
  readonly protocol: ProtocolContract;
  readonly input: InputContract;
  readonly serverOwnedFields: readonly string[];
  readonly bindings: BindingContract;
  readonly guards: GuardsContract;
  readonly output: OutputContract;
  readonly page: PageContract;
  readonly response: ResponseContract;
  readonly headers: HeadersContract;
  readonly operationRevision: number;
}

export interface FormCheckSource {
  readonly path: string;
  readonly sha256: string;
  readonly generator: string;
  readonly projection: 'exact-for-selected-structural-fields';
  readonly runtimeCoverage: 'not-evaluated';
  readonly behaviorSha256: string;
}

export interface FormCheckAction {
  readonly id: string;
  readonly method: 'POST';
  readonly path: string;
  readonly encoding: 'urlencoded';
  readonly parserProfile: string;
}

export interface FormCheck {
  readonly format: typeof FORM_CHECK_FORMAT;
  readonly status: 'generated-design-reference-not-product-output';
  readonly source: FormCheckSource;
  readonly action: FormCheckAction;
  readonly input: InputContract;
  readonly protocolFields: readonly string[];
}

export interface LoadedBoundaryContract {
  readonly contract: BoundaryContract;
  readonly value: JsonObject;
  readonly sourceSha256: string;
  readonly behaviorSha256: string;
}

export interface LoadedFormCheck {
  readonly formCheck: FormCheck;
  readonly value: JsonObject;
}
