import type { LoadedBoundaryContract } from '../contract/types.ts';
import { validateBusinessInput, hashValidatedInput, type InputValidation } from './input.ts';
import type { IntentDecision, IntentSnapshot, SubmissionInput } from './intent.ts';
import { decideIntent } from './intent.ts';
import type { GrantIssuer, OrderBindings } from './order-bindings.ts';
import type { OrderReadTx, OrderStorage, OrderWriteTx, StoredIntent, StoredResult } from './order-storage.ts';
import {
  newDraftId,
  newIntentId,
  toPageView,
  type Draft,
  type FormState,
  type OrderInput,
  type PageResolution,
  type PageTarget,
  type Principal,
  type PublicReceipt,
  type OrderPageView,
} from './order.ts';
import { validateOutputObject, OutputValidationError } from './output.ts';
import { assertSynchronous } from './sync.ts';

const MILLISECONDS_PER_SECOND = 1_000;
const TRANSIENT_RETRY_AFTER_SECONDS = 1;

export class OrderFailure extends Error {
  readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 503;
  readonly code: string;
  readonly retryAfterSeconds: number | null;
  readonly formState: FormState | null;

  constructor(
    status: OrderFailure['status'],
    code: string,
    options: Readonly<{ retryAfterSeconds?: number; formState?: FormState; cause?: unknown }> = {},
  ) {
    super(code, options);
    this.name = 'OrderFailure';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.formState = options.formState ?? null;
  }
}

export type OrderCoordinatorOptions = Readonly<{
  loaded: LoadedBoundaryContract;
  bindings: OrderBindings;
  storage: OrderStorage;
  now?: () => number;
  maxOpenIntents?: number;
}>;

export type BeginResult = Readonly<{ intentId: string; location: string }>;
export type SubmitResult = Readonly<{ kind: 'receipt'; location: string }>;

type CoordinatorSnapshot = IntentSnapshot & Readonly<{ productId: string }>;
type WriteCandidate = Readonly<{
  principal: Principal;
  intentId: string;
  validation: Extract<InputValidation, { ok: true }>;
  input: OrderInput;
  inputHash: string;
}>;

export class OrderCoordinator {
  private readonly loaded: LoadedBoundaryContract;
  private readonly bindings: OrderBindings;
  private readonly storage: OrderStorage;
  private readonly now: () => number;
  private readonly maxOpenIntents: number;

  constructor(options: OrderCoordinatorOptions) {
    this.loaded = options.loaded;
    this.bindings = options.bindings;
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
    this.maxOpenIntents = options.maxOpenIntents ?? 20;
    if (!Number.isSafeInteger(this.maxOpenIntents) || this.maxOpenIntents < 1) {
      throw new Error('INVALID_OPEN_INTENT_LIMIT');
    }
  }

  private get actionId(): string {
    return this.loaded.contract.id;
  }

  private get behaviorSha256(): string {
    return this.loaded.behaviorSha256;
  }

  async beginDraft(principal: Principal, rawProductId: string): Promise<BeginResult> {
    principal = Object.freeze({ ...principal });
    if (rawProductId.length === 0 || rawProductId.length > 64) {
      throw new OrderFailure(400, 'INVALID_PRODUCT_ID');
    }
    const intentId = newIntentId();
    try {
      await this.storage.immediate((tx) => {
        const now = this.clock();
        const expiresAt = now + this.loaded.contract.guards.idempotency.intentTtlSeconds * MILLISECONDS_PER_SECOND;
        const prepared = assertSynchronous(
          this.bindings.prepareIntent({ tx, principal, productId: rawProductId }),
        );
        if (prepared === null) throw new OrderFailure(404, 'NOT_FOUND');
        const product = Object.freeze({ ...prepared });
        if (tx.countOpenIntents(principal.tenantId, principal.subjectId, this.actionId, now) >= this.maxOpenIntents) {
          throw new OrderFailure(429, 'OPEN_INTENT_LIMIT', { retryAfterSeconds: TRANSIENT_RETRY_AFTER_SECONDS });
        }
        const intent: StoredIntent = {
          id: intentId,
          tenantId: principal.tenantId,
          subjectId: principal.subjectId,
          actionId: this.actionId,
          productId: product.id,
          resourceRevision: product.revision,
          behaviorHash: this.behaviorSha256,
          issuedAt: now,
          expiresAt,
          consumedAt: null,
        };
        tx.insertIntent(intent);
      });
    } catch (error) {
      if (isCommitError(error)) {
        this.recoverCommit(error, (tx) => {
          const decision = decideIntent(this.snapshotFrom(tx, principal, intentId), { kind: 'view' }, this.clock(), this.behaviorSha256);
          if (decision.kind === 'form') return true;
          if (decision.kind === 'error' && decision.code !== 'INTENT_UNAVAILABLE') {
            throw new OrderFailure(decision.status, decision.code);
          }
          return null;
        });
      } else {
        throw mapBusy(error);
      }
    }
    const template = this.loaded.contract.page.intentInitialization.location;
    return {
      intentId,
      location: template.replace('{intentId}', encodeURIComponent(intentId)),
    };
  }

  async submitIntent(
    principal: Principal,
    intentId: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<SubmitResult> {
    principal = Object.freeze({ ...principal });
    const now = this.clock();
    const validation = validateBusinessInput(this.loaded.contract.input, fields);
    if (!validation.ok && validation.unknownKeys.length > 0) {
      throw new OrderFailure(400, 'UNKNOWN_FIELD');
    }
    const snapshot = this.readSnapshot(principal, intentId);
    const decision = decideIntent(snapshot, this.submission(validation), now, this.behaviorSha256);
    const resolved = await this.resolveSubmitDecision(principal, intentId, validation, decision);
    if (resolved.kind === 'receipt') return resolved;
    throw new OrderFailure(422, 'INVALID_INPUT', {
      formState: this.formState(intentId, fields, validation),
    });
  }

  resolvePage(principal: Principal, target: PageTarget): PageResolution {
    principal = Object.freeze({ ...principal });
    return this.storage.read((tx) => {
      if (!tx.currentMember(principal.tenantId, principal.subjectId)) {
        return { kind: 'failure', status: 404, code: 'NOT_FOUND' } as const;
      }
      if (target.kind === 'product') {
        const product = tx.loadProduct(principal.tenantId, target.productId);
        if (product === null || !product.active) {
          return { kind: 'failure', status: 404, code: 'NOT_FOUND' } as const;
        }
        return { kind: 'start', view: this.validatePageView(toPageView(product)) } as const;
      }
      const snapshot = this.snapshotFrom(tx, principal, target.intentId);
      const decision = decideIntent(snapshot, { kind: 'view' }, this.clock(), this.behaviorSha256);
      if (decision.kind === 'form') {
        const product = snapshot === null ? null : tx.loadProduct(principal.tenantId, snapshot.productId);
        if (product === null || !product.active) {
          return { kind: 'failure', status: 404, code: 'NOT_FOUND' } as const;
        }
        return { kind: 'form', intentId: target.intentId, view: this.validatePageView(toPageView(product)) } as const;
      }
      if (decision.kind === 'receipt') {
        return { kind: 'receipt', output: this.receiptView(tx, principal, decision.orderId) } as const;
      }
      if (decision.kind === 'error') {
        return { kind: 'failure', status: decision.status, code: decision.code } as const;
      }
      return { kind: 'failure', status: 500, code: 'INTENT_STATE_INVALID' } as const;
    });
  }

  resolveReceipt(principal: Principal, orderId: string): PublicReceipt {
    principal = Object.freeze({ ...principal });
    return this.storage.read((tx) => this.receiptView(tx, principal, orderId));
  }

  private receiptView(tx: OrderReadTx, principal: Principal, orderId: string): PublicReceipt {
    const loadedDraft = assertSynchronous(this.bindings.loadReceipt({ tx, principal, orderId }));
    if (loadedDraft === null) throw new OrderFailure(404, 'NOT_FOUND');
    const draft = Object.freeze({ ...loadedDraft });
    const decision = assertSynchronous(this.bindings.authorizeReceipt({ principal, receipt: draft }));
    if (!decision.allow) throw new OrderFailure(404, 'NOT_FOUND');
    const intent = tx.loadIntent(principal.tenantId, principal.subjectId, this.actionId, draft.intentId);
    if (intent === null) throw new OrderFailure(410, 'RESULT_EXPIRED');
    const state = decideIntent(this.snapshotFrom(tx, principal, draft.intentId), { kind: 'view' }, this.clock(), this.behaviorSha256);
    if (state.kind === 'error') throw new OrderFailure(state.status, state.code);
    if (state.kind !== 'receipt' || state.orderId !== orderId) throw new OrderFailure(500, 'INTENT_STATE_INVALID');
    const output = assertSynchronous(this.bindings.projectReceipt(draft));
    return this.validateReceipt(output, orderId);
  }

  private async resolveSubmitDecision(
    principal: Principal,
    intentId: string,
    validation: InputValidation,
    decision: IntentDecision,
  ): Promise<{ kind: 'receipt'; location: string } | { kind: 'invalid' }> {
    switch (decision.kind) {
      case 'error':
        throw new OrderFailure(decision.status, decision.code);
      case 'receipt':
      case 'needs-input':
      case 'invalid':
        return this.storage.read((tx) => {
          const fresh = this.snapshotFrom(tx, principal, intentId);
          const final = decideIntent(fresh, this.submission(validation), this.clock(), this.behaviorSha256);
          if (final.kind === 'error') throw new OrderFailure(final.status, final.code);
          if (final.kind === 'receipt') {
            this.receiptView(tx, principal, final.orderId);
            return { kind: 'receipt', location: this.receiptLocation(final.orderId) } as const;
          }
          if (final.kind === 'needs-input' && fresh?.consumedAt !== null) {
            throw new OrderFailure(409, 'COMPLETED_INPUT_CONFLICT');
          }
          if (final.kind === 'invalid' || final.kind === 'needs-input') return { kind: 'invalid' } as const;
          throw new OrderFailure(500, 'INTENT_STATE_INVALID');
        });
      case 'write-candidate':
        return this.writeCandidate(principal, intentId, validation);
      case 'form':
        throw new OrderFailure(405, 'METHOD_NOT_ALLOWED');
    }
  }

  private async writeCandidate(
    principal: Principal,
    intentId: string,
    validation: InputValidation,
  ): Promise<{ kind: 'receipt'; location: string }> {
    if (!validation.ok) throw new OrderFailure(409, 'COMPLETED_INPUT_CONFLICT');
    const candidate: WriteCandidate = {
      principal, intentId, validation,
      input: Object.freeze({ productId: validation.value.productId as string, quantity: validation.value.quantity as number }),
      inputHash: hashValidatedInput(validation.value),
    };
    try {
      const location = await this.storage.immediate((tx, issueGrant) => this.writeLockedCandidate(tx, issueGrant, candidate));
      return { kind: 'receipt', location };
    } catch (error) {
      if (!isCommitError(error)) throw mapBusy(error);
      return { kind: 'receipt', location: this.recoverWriteLocation(candidate, error) };
    }
  }

  private writeLockedCandidate(tx: OrderWriteTx, issueGrant: GrantIssuer, candidate: WriteCandidate): string {
    const { principal, intentId, validation } = candidate;
    const lockedAt = this.clock();
    const snapshot = this.snapshotFrom(tx, principal, intentId);
    const decision = decideIntent(snapshot, this.submission(validation), lockedAt, this.behaviorSha256);
    if (decision.kind === 'receipt') {
      this.receiptView(tx, principal, decision.orderId);
      return this.receiptLocation(decision.orderId);
    }
    if (decision.kind === 'error') throw new OrderFailure(decision.status, decision.code);
    if (decision.kind !== 'write-candidate') throw new OrderFailure(409, 'COMPLETED_INPUT_CONFLICT');
    const draft = this.executeCandidate(tx, issueGrant, candidate, lockedAt);
    if (!tx.consumeIntent({ intentId, principal, behaviorHash: this.behaviorSha256, now: lockedAt })) {
      throw new OrderFailure(409, 'CAS_CONFLICT');
    }
    const output = assertSynchronous(this.bindings.project(draft));
    const validated = this.validateReceipt(output, draft.orderId);
    tx.insertResult(storedResultFor(candidate, draft.orderId, this.behaviorSha256, lockedAt,
      this.loaded.contract.guards.idempotency.resultRetentionSeconds));
    tx.insertAudit({ intentId, actionId: this.actionId, outcome: 'SUCCESS', createdAt: lockedAt });
    return this.receiptLocation(validated.orderId);
  }

  private executeCandidate(tx: OrderWriteTx, issueGrant: GrantIssuer, candidate: WriteCandidate, lockedAt: number): Draft {
    const { principal, intentId, input, inputHash } = candidate;
    const loadedProduct = assertSynchronous(this.bindings.load({ tx, principal, input }));
    if (loadedProduct === null) throw new OrderFailure(404, 'NOT_FOUND');
    const product = Object.freeze({ ...loadedProduct });
    const allowed = assertSynchronous(this.bindings.authorize({ principal, input, resource: product }));
    if (!allowed.allow) throw new OrderFailure(404, 'NOT_FOUND');
    const grant = issueGrant({
      principal,
      resourceId: product.id,
      resourceRevision: product.revision,
      operation: 'orders.createDraft',
      draftId: newDraftId(),
      actionId: this.actionId,
      intentId,
      behaviorSha256: this.behaviorSha256,
      inputHash,
    });
    const draft = this.executeDraft({ tx, principal, input, resource: product, grant, now: lockedAt });
    return Object.freeze({ ...draft });
  }

  /** Only the execute role's revision conflict is translated. */
  private executeDraft(context: Parameters<OrderBindings['execute']>[0]): Draft {
    try {
      return assertSynchronous(this.bindings.execute(context));
    } catch (error) {
      if (error instanceof Error && error.message === 'REVISION_CONFLICT') {
        throw new OrderFailure(409, 'QUOTE_CHANGED');
      }
      throw error;
    }
  }

  private recoverWriteLocation(candidate: WriteCandidate, commitError: unknown): string {
    const { principal, intentId, validation } = candidate;
    return this.recoverCommit(commitError, (tx) => {
      const decision = decideIntent(this.snapshotFrom(tx, principal, intentId), this.submission(validation), this.clock(), this.behaviorSha256);
      if (decision.kind === 'receipt') {
        this.receiptView(tx, principal, decision.orderId);
        return this.receiptLocation(decision.orderId);
      }
      if (decision.kind === 'error') throw new OrderFailure(decision.status, decision.code);
      return null;
    });
  }

  private readSnapshot(principal: Principal, intentId: string): CoordinatorSnapshot | null {
    return this.storage.read((tx) => this.snapshotFrom(tx, principal, intentId));
  }

  private recoverCommit<T>(commitError: unknown, work: (tx: OrderReadTx) => T | null): T {
    let cause = commitError;
    try {
      const recovered = this.storage.recoverRead?.(work);
      if (recovered !== undefined && recovered !== null) return recovered;
    } catch (error) {
      if (error instanceof OrderFailure) throw error;
      cause = new AggregateError([commitError, error], 'Commit acknowledgement and recovery both failed');
    }
    throw new OrderFailure(503, 'COMMIT_UNCERTAIN', { retryAfterSeconds: TRANSIENT_RETRY_AFTER_SECONDS, cause });
  }

  private snapshotFrom(tx: OrderReadTx, principal: Principal, intentId: string): CoordinatorSnapshot | null {
    const intent = tx.loadIntent(principal.tenantId, principal.subjectId, this.actionId, intentId);
    if (intent === null) return null;
    const result = tx.loadResult(intent.id);
    const draft = tx.readDraftByIntent(intent.id);
    const product = tx.loadProduct(intent.tenantId, intent.productId);
    const currentAuthorized = tx.currentMember(intent.tenantId, intent.subjectId);
    if (currentAuthorized && draft !== null && (
      draft.tenantId !== intent.tenantId || draft.subjectId !== intent.subjectId ||
      draft.productId !== intent.productId || draft.productRevision !== intent.resourceRevision
    )) throw new OrderFailure(500, 'INTENT_STATE_INVALID');
    return {
      intentId: intent.id,
      productId: intent.productId,
      behaviorHash: intent.behaviorHash,
      issuedAt: intent.issuedAt,
      expiresAt: intent.expiresAt,
      consumedAt: intent.consumedAt,
      draftId: draft === null ? null : draft.orderId,
      result: result === null
        ? null
        : {
            orderId: result.draftId,
            behaviorHash: result.behaviorHash,
            inputHash: result.inputHash,
            completedAt: result.completedAt,
            expiresAt: result.expiresAt,
          },
      currentAuthorized,
      resourceRevisionMatches:
        product !== null && product.active && product.revision === intent.resourceRevision,
    };
  }

  private submission(validation: InputValidation): { kind: 'submit'; input: SubmissionInput } {
    if (validation.ok) {
      return { kind: 'submit', input: { kind: 'valid', inputHash: hashValidatedInput(validation.value) } };
    }
    if (validation.issues.some((issue) => issue.code === 'REQUIRED')) {
      return { kind: 'submit', input: { kind: 'unchecked' } };
    }
    return { kind: 'submit', input: { kind: 'invalid' } };
  }

  private formState(
    intentId: string,
    fields: Readonly<Record<string, string>>,
    validation: InputValidation,
  ): FormState {
    const fieldErrors: Partial<Record<'productId' | 'quantity', readonly string[]>> = {};
    const formErrors: string[] = [];
    if (!validation.ok) {
      for (const issue of validation.issues) {
        if (issue.field === 'productId' || issue.field === 'quantity') {
          fieldErrors[issue.field] = [...(fieldErrors[issue.field] ?? []), issue.code];
        } else {
          formErrors.push(issue.code);
        }
      }
    }
    return {
      rawValues: {
        ...(this.echoable(fields, 'productId') ? { productId: fields.productId } : {}),
        ...(this.echoable(fields, 'quantity') ? { quantity: fields.quantity } : {}),
      },
      fieldErrors,
      formErrors,
      csrfToken: '',
      intentId,
    };
  }

  private echoable(fields: Readonly<Record<string, string>>, key: string): boolean {
    return Object.hasOwn(fields, key) && new TextEncoder().encode(fields[key]).byteLength <= this.loaded.contract.http.maxValueBytes;
  }

  private receiptLocation(orderId: string): string {
    return this.loaded.contract.response.receipt.path.replace(':orderId', encodeURIComponent(orderId));
  }

  private validateReceipt(value: PublicReceipt, expectedOrderId: string): PublicReceipt {
    try {
      const output = validateOutputObject(this.loaded.contract.output.schema, value) as unknown as PublicReceipt;
      if (output.orderId !== expectedOrderId) throw new OutputValidationError('$.orderId', 'must identify the committed draft');
      return output;
    } catch (error) {
      if (error instanceof OutputValidationError) throw new OrderFailure(500, 'OUTPUT_INVALID');
      throw error;
    }
  }

  private validatePageView(value: OrderPageView): OrderPageView {
    try {
      return validateOutputObject(this.loaded.contract.page.viewSchema, value) as unknown as OrderPageView;
    } catch (error) {
      if (error instanceof OutputValidationError) throw new OrderFailure(500, 'PAGE_VIEW_INVALID');
      throw error;
    }
  }

  private clock(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new OrderFailure(500, 'INVALID_CLOCK');
    return now;
  }
}

/** Pure result metadata calculation; the database writes remain in the locked sequence. */
function storedResultFor(candidate: WriteCandidate, draftId: string, behaviorHash: string, completedAt: number, retentionSeconds: number): StoredResult {
  return {
    intentId: candidate.intentId, draftId, behaviorHash, inputHash: candidate.inputHash,
    completedAt, expiresAt: completedAt + retentionSeconds * MILLISECONDS_PER_SECOND,
  };
}

function busyRetryAfter(error: unknown): number | null {
  if (!(error instanceof Error) || error.name !== 'StoreBusyError') return null;
  const value = (error as Error & { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === 'number' ? value : TRANSIENT_RETRY_AFTER_SECONDS;
}

function isCommitError(error: unknown): boolean {
  return error instanceof Error && error.name === 'StoreCommitError';
}

function mapBusy(error: unknown): unknown {
  const retryAfter = busyRetryAfter(error);
  return retryAfter === null ? error : new OrderFailure(503, 'BUSY', { retryAfterSeconds: retryAfter });
}
