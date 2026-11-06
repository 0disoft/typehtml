import { SUPPORTED_CSRF_FIELD, SUPPORTED_REQUEST_KEY_FIELD, type ObjectSchema } from '../contract/types.ts';
import { validateBusinessInput } from '../runtime/input.ts';
import { validateOutputObject } from '../runtime/output.ts';
import { readUrlEncodedForm } from '../runtime/wire.ts';
import type { DefinedForm, InferSchema } from './definition.ts';
import { renderFormErrors } from './html.ts';
import { createBoundaryHandler, type BoundaryHooks, type BoundaryInvalidContext } from './boundary.ts';
import type { FormStateOptions } from './state.ts';

export { FormHttpError, type FormContext } from './boundary.ts';
export interface InvalidFormContext<Principal> extends BoundaryInvalidContext<Principal, Readonly<Record<string, string>>> {}
export interface FormHandlerOptions<I extends ObjectSchema, O extends ObjectSchema, Principal extends object, Result>
  extends BoundaryHooks<InferSchema<I>, InferSchema<O>, Principal, Result, Readonly<Record<string, string>>> {
  readonly errors?: FormStateOptions & Readonly<{ title?: string; summaryTitle?: string; submitLabel?: string }>;
}

/** Existing flat-form API; transport, validation precedence, responses, and receivers are preserved. */
export function createFormHandler<I extends ObjectSchema, O extends ObjectSchema, Principal extends object, Result>(
  form: DefinedForm<I, O>, options: FormHandlerOptions<I, O, Principal, Result>,
): (request: Request) => Promise<Response> {
  const acceptRequestKey = options.acceptRequestKey === true;
  const errors = options.errors === undefined ? undefined : Object.freeze({ ...options.errors, messages: options.errors.messages === undefined ? undefined : Object.freeze({ ...options.errors.messages }) });
  return createBoundaryHandler({
    path: form.path, limits: form.limits,
    read: async (request) => {
      const parsed = await readUrlEncodedForm(request, {
        ...form.limits, csrfField: SUPPORTED_CSRF_FIELD, requestKeyField: SUPPORTED_REQUEST_KEY_FIELD, expectRequestKey: acceptRequestKey,
      });
      return { csrf: parsed.csrf, raw: parsed.fields, ...(parsed.requestKey === null ? {} : { requestKey: parsed.requestKey }), validate: () => {
        const validation = validateBusinessInput(form.input, parsed.fields);
        return validation.ok ? { ok: true as const, value: validation.value as InferSchema<I> } : validation;
      } };
    },
    validateOutput: (value) => validateOutputObject(form.output, value) as InferSchema<O>,
    renderInvalid: (context) => renderFormErrors(form.path, form.input.schema, context.rawValues, context.issues, context.csrfToken, errors, context.requestKey),
  }, options);
}
