import type { LoadedBoundaryContract } from '../contract/types.ts';
import { validateBusinessInput, hashValidatedInput, type InputValidation } from './input.ts';
import type { IntentDecision, IntentSnapshot, SubmissionInput } from './intent.ts';
import { decideIntent } from './intent.ts';
import type { OrderBindings, Grant } from './order-bindings.ts';
import type { OrderReadTx, OrderStorage, StoredIntent } from './order-storage.ts';
import {
  newDraftId,
  newIntentId,
  toPageView,
  type FormState,
  type OrderInput,
  type PageResolution,
  type PageTarget,
  type Principal,
  type PublicReceipt,
} from './order.ts';
import { validateOutputObject, OutputValidationError } from './output.ts';
import { assertSynchronous } from './sync.ts';

export class OrderFailure extends Error {
  readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 410 | 413 | 415 | 422 | 500 | 503;
  readonly code: string;
  readonly retryAfterSeconds: number | null;
  readonly formState: FormState | null;

  constructor(
    status: OrderFailure['status'],
    code: string,
    options: Readonly<{ retryAfterSeconds?: number; formState?: FormState }> = {},
  ) {
    super(code);
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
}>;

export type BeginResult = Readonly<{ intentId: string; location: string }>;
export type SubmitResult = Readonly<{ kind: 'receipt'; location: string }>;

type CoordinatorSnapshot = IntentSnapshot & Readonly<{ productId: string }>;

export class OrderCoordinator {
  private readonly loaded: LoadedBoundaryContract;
  private readonly bindings: OrderBindings;
  private readonly storage: OrderStorage;
  private readonly now: () => number;

  constructor(options: OrderCoordinatorOptions) {
    this.loaded = options.loaded;
    this.bindings = options.bindings;
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
  }

  private get actionId(): string {
    return this.loaded.contract.id;
  }

  private get behaviorSha256(): string {
    return this.loaded.behaviorSha256;
  }

  async beginDraft(principal: Principal, rawProductId: string): Promise<BeginResult> {
    if (rawProductId.length === 0 || rawProductId.length > 64) {
      throw new OrderFailure(400, 'INVALID_PRODUCT_ID');
    }
    const now = this.clock();
    const intentId = newIntentId();
    const expiresAt = now + this.loaded.contract.guards.idempotency.intentTtlSeconds * 1000;
    try {
      await this.storage.immediate((tx) => {
        const product = assertSynchronous(
          this.bindings.prepareIntent({ tx, principal, productId: rawProductId }),
        );
        if (product === null) throw new OrderFailure(404, 'NOT_FOUND');
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
      throw mapBusy(error);
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
    return this.storage.read((tx) => {
      if (!tx.currentMember(principal.tenantId, principal.subjectId)) {
        return { kind: 'failure', status: 404, code: 'NOT_FOUND' } as const;
      }
      if (target.kind === 'product') {
        const product = tx.loadProduct(principal.tenantId, target.productId);
        if (product === null || !product.active) {
          return { kind: 'failure', status: 404, code: 'NOT_FOUND' } as const;
        }
        return { kind: 'start', view: toPageView(product) } as const;
      }
      const snapshot = this.snapshotFrom(tx, principal, target.intentId);
      const decision = decideIntent(snapshot, { kind: 'view' }, this.clock(), this.behaviorSha256);
      if (decision.kind === 'form') {
        const product = snapshot === null ? null : tx.loadProduct(principal.tenantId, snapshot.productId);
        if (product === null || !product.active) {
          return { kind: 'failure', status: 404, code: 'NOT_FOUND' } as const;
        }
        return { kind: 'form', intentId: target.intentId, view: toPageView(product) } as const;
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
    return this.storage.read((tx) => this.receiptView(tx, principal, orderId));
  }

  private receiptView(tx: OrderReadTx, principal: Principal, orderId: string): PublicReceipt {
    const draft = assertSynchronous(this.bindings.loadReceipt({ tx, principal, orderId }));
    if (draft === null) throw new OrderFailure(404, 'NOT_FOUND');
    const decision = assertSynchronous(this.bindings.authorizeReceipt({ principal, receipt: draft }));
    if (!decision.allow) throw new OrderFailure(404, 'NOT_FOUND');
    const intent = tx.loadIntent(principal.tenantId, principal.subjectId, this.actionId, draft.intentId);
    if (intent === null) throw new OrderFailure(410, 'RESULT_EXPIRED');
    const result = tx.loadResult(draft.intentId);
    if (result === null) throw new OrderFailure(500, 'INTENT_STATE_INVALID');
    if (this.clock() >= result.expiresAt) throw new OrderFailure(410, 'RESULT_EXPIRED');
    const output = assertSynchronous(this.bindings.projectReceipt(draft));
    return this.validateReceipt(output);
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
        return { kind: 'receipt', location: this.receiptLocation(decision.orderId) };
      case 'needs-input': {
        const snapshot = this.readSnapshot(principal, intentId);
        if (snapshot !== null && snapshot.consumedAt !== null) {
          throw new OrderFailure(409, 'COMPLETED_INPUT_CONFLICT');
        }
        return { kind: 'invalid' };
      }
      case 'invalid': {
        const fresh = this.readSnapshot(principal, intentId);
        const freshDecision = decideIntent(fresh, this.submission(validation), this.clock(), this.behaviorSha256);
        if (freshDecision.kind === 'invalid') return { kind: 'invalid' };
        return this.resolveSubmitDecision(principal, intentId, validation, freshDecision);
      }
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
    const input: OrderInput = {
      productId: validation.value.productId as string,
      quantity: validation.value.quantity as number,
    };
    const inputHash = hashValidatedInput(validation.value);
    let location: string;
    try {
      location = await this.storage.immediate((tx) => {
        const lockedAt = this.clock();
        const snapshot = this.snapshotFrom(tx, principal, intentId);
        const freshDecision = decideIntent(snapshot, this.submission(validation), lockedAt, this.behaviorSha256);
        if (freshDecision.kind === 'receipt') return this.receiptLocation(freshDecision.orderId);
        if (freshDecision.kind === 'error') throw new OrderFailure(freshDecision.status, freshDecision.code);
        if (freshDecision.kind !== 'write-candidate') {
          throw new OrderFailure(409, 'COMPLETED_INPUT_CONFLICT');
        }
        const product = assertSynchronous(this.bindings.load({ tx, principal, input }));
        if (product === null) throw new OrderFailure(404, 'NOT_FOUND');
        const allowed = assertSynchronous(this.bindings.authorize({ principal, input, resource: product }));
        if (!allowed.allow) throw new OrderFailure(404, 'NOT_FOUND');

        const grant: Grant = {
          principal,
          resourceId: product.id,
          resourceRevision: product.revision,
          operation: 'orders.createDraft',
          draftId: newDraftId(),
          actionId: this.actionId,
          intentId,
          behaviorSha256: this.behaviorSha256,
          inputHash,
        };
        let draft;
        try {
          draft = assertSynchronous(this.bindings.execute({ tx, principal, input, resource: product, grant, now: lockedAt }));
        } catch (error) {
          if (error instanceof Error && error.message === 'REVISION_CONFLICT') {
            throw new OrderFailure(409, 'QUOTE_CHANGED');
          }
          throw error;
        }
        if (!tx.consumeIntent({ intentId, principal, behaviorHash: this.behaviorSha256, now: lockedAt })) {
          throw new OrderFailure(409, 'CAS_CONFLICT');
        }
        const output = assertSynchronous(this.bindings.project(draft));
        const validated = this.validateReceipt(output);
        tx.insertResult({
          intentId,
          draftId: draft.orderId,
          behaviorHash: this.behaviorSha256,
          inputHash,
          completedAt: lockedAt,
          expiresAt: lockedAt + this.loaded.contract.guards.idempotency.resultRetentionSeconds * 1000,
        });
        tx.insertAudit({ intentId, actionId: this.actionId, outcome: 'SUCCESS', createdAt: lockedAt });
        return this.receiptLocation(validated.orderId);
      });
    } catch (error) {
      throw mapBusy(error);
    }
    return { kind: 'receipt', location };
  }

  private readSnapshot(principal: Principal, intentId: string): CoordinatorSnapshot | null {
    return this.storage.read((tx) => this.snapshotFrom(tx, principal, intentId));
  }

  private snapshotFrom(tx: OrderReadTx, principal: Principal, intentId: string): CoordinatorSnapshot | null {
    const intent = tx.loadIntent(principal.tenantId, principal.subjectId, this.actionId, intentId);
    if (intent === null) return null;
    const result = tx.loadResult(intent.id);
    const draft = tx.readDraftByIntent(intent.id);
    const product = tx.loadProduct(intent.tenantId, intent.productId);
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
      currentAuthorized: tx.currentMember(intent.tenantId, intent.subjectId),
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
        ...(Object.hasOwn(fields, 'productId') ? { productId: fields.productId } : {}),
        ...(Object.hasOwn(fields, 'quantity') ? { quantity: fields.quantity } : {}),
      },
      fieldErrors,
      formErrors,
      csrfToken: '',
      intentId,
    };
  }

  private receiptLocation(orderId: string): string {
    return this.loaded.contract.response.receipt.path.replace(':orderId', encodeURIComponent(orderId));
  }

  private validateReceipt(value: PublicReceipt): PublicReceipt {
    try {
      return validateOutputObject(this.loaded.contract.output.schema, value) as unknown as PublicReceipt;
    } catch (error) {
      if (error instanceof OutputValidationError) throw new OrderFailure(500, 'OUTPUT_INVALID');
      throw error;
    }
  }

  private clock(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new OrderFailure(500, 'INVALID_CLOCK');
    return now;
  }
}

function busyRetryAfter(error: unknown): number | null {
  if (!(error instanceof Error) || error.name !== 'StoreBusyError') return null;
  const value = (error as Error & { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === 'number' ? value : 1;
}

function mapBusy(error: unknown): unknown {
  const retryAfter = busyRetryAfter(error);
  return retryAfter === null ? error : new OrderFailure(503, 'BUSY', { retryAfterSeconds: retryAfter });
}
