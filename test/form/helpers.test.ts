import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createFormHelpers, createFormState, defineForm, defineSchemaForm, getFieldProps, getFormProps,
  getSchemaFieldProps, formFieldId, renderFieldErrors, type FormFieldName,
} from '../../src/index.ts';

const form = defineForm({
  id: 'feedback.send', path: '/feedback',
  input: { type: 'object', additionalProperties: false, required: ['name'], properties: {
    name: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1 },
  } },
  output: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } },
});
const rich = defineSchemaForm({
  id: 'profile.save', path: '/profile', fields: {
    'user.name': { type: 'string', required: true },
    'items[0].quantity': { type: 'integer', required: true },
    tags: { type: 'array', items: { type: 'string' } },
  },
  input: z.object({ user: z.object({ name: z.string() }), items: z.array(z.object({ quantity: z.number() })), tags: z.array(z.string()) })
    .transform((input) => ({ accountName: input.user.name, total: input.items[0]!.quantity })),
  output: z.object({ message: z.string() }),
});

describe('typed native form helpers', () => {
  test('allows only shared names when a form has not been narrowed from a union', () => {
    const alternative = defineForm({
      id: 'alternative', path: '/alternative',
      input: { type: 'object', additionalProperties: false, required: [], properties: {
        name: { type: 'string' }, note: { type: 'string' },
      } }, output: form.output,
    });
    const alternativeRich = defineSchemaForm({
      id: 'alternative.rich', path: '/alternative-rich',
      fields: { name: { type: 'string' }, note: { type: 'string' } }, input: z.unknown(), output: z.unknown(),
    });
    const sameKind = (selected: typeof form | typeof alternative) => {
      const helper = createFormHelpers(selected);
      const name: 'name' = helper.field('name').name;
      if (false) {
        // @ts-expect-error count does not exist in every possible form
        helper.name('count');
        // @ts-expect-error note does not exist in every possible form
        helper.field('note');
      }
      return name;
    };
    const mixedKind = (selected: typeof form | typeof alternativeRich) => {
      const helper = createFormHelpers(selected);
      if (false) {
        // @ts-expect-error a union of legacy and rich forms also requires a shared declaration
        helper.field('count');
      }
      return helper.name('name');
    };
    const differentRich = (selected: typeof rich | typeof alternativeRich) => {
      if (false) {
        // @ts-expect-error these rich forms have no shared wire names
        createFormHelpers(selected).field('user.name');
        // @ts-expect-error an impossible form type cannot contribute any field names
        const impossible: FormFieldName<never> = 'name';
        void impossible;
      }
    };
    expect([sameKind(form), sameKind(alternative), mixedKind(form), mixedKind(alternativeRich)]).toEqual(['name', 'name', 'name', 'name']);
    differentRich(rich);
  });

  test('preserves legacy props and literal names while rejecting typo names', () => {
    const helpers = createFormHelpers(form);
    const name: 'name' = helpers.name('name');
    const count: 'count' = helpers.field('count', { control: 'number' }).name;
    const field: FormFieldName<typeof form> = 'count';
    expect([name, count, field]).toEqual(['name', 'count', 'count']);
    expect(helpers.form()).toEqual(getFormProps(form));
    expect(getFieldProps(form, 'count', { control: 'number' })).toEqual(helpers.field('count', { control: 'number' }));
    expect(Object.isFrozen(helpers)).toBe(true);
    expect(() => {
      // @ts-expect-error unknown field names are rejected without a string fallback overload
      helpers.field('naem');
    }).toThrow('unknown form field: naem');
    expect(() => {
      // @ts-expect-error name-only JSX bindings also reject typos
      helpers.name('naem');
    }).toThrow('unknown form field: naem');
  });

  test('checks declared nested transport paths rather than transformed domain keys', () => {
    const helpers = createFormHelpers(rich);
    const name: 'user.name' = helpers.field('user.name').name;
    const quantity: 'items[0].quantity' = helpers.name('items[0].quantity');
    expect([name, quantity]).toEqual(['user.name', 'items[0].quantity']);
    expect(getSchemaFieldProps(rich, 'tags')).toEqual(helpers.field('tags'));
    for (const invalid of ['user', 'accountName', 'items[1].quantity', 'toString']) {
      expect(() => helpers.field(invalid as FormFieldName<typeof rich>)).toThrow('unknown form field');
    }
    expect(() => {
      // @ts-expect-error post-transform input keys are not wire fields
      helpers.name('accountName');
    }).toThrow('unknown form field');
    expect(() => {
      // @ts-expect-error fixed nested names do not imply an arbitrary array-index template
      helpers.name('items[1].quantity');
    }).toThrow('unknown form field');
  });

  test('forwards error state and option props to the existing implementation', () => {
    const state = createFormState({ name: '' }, [{ field: 'name', code: 'REQUIRED', message: 'Enter a name' }]);
    const options = { state, id: 'person-name', describedBy: 'hint' };
    expect(getFieldProps(form, 'name', options)).toEqual(createFormHelpers(form).field('name', options));
    expect(getSchemaFieldProps(rich, 'user.name', options)).toEqual(createFormHelpers(rich).field('user.name', options));
    const dynamic: string = 'name';
    expect(() => {
      // @ts-expect-error dynamic strings must be checked/narrowed by the caller
      createFormHelpers(form).name(dynamic);
    }).not.toThrow();
  });

  test('links repeated text fields to the error element belonging to their custom ID', () => {
    const state = createFormState({ tags: ['a', 'b'] }, [{ field: 'tags', code: 'MAX_ITEMS', message: 'Choose fewer tags' }]);
    const helper = createFormHelpers(rich);
    const props = helper.field('tags', { control: 'text', id: 'profile-tags', describedBy: 'tags-hint', state });
    expect(props.id).toBe('profile-tags');
    expect(props['aria-invalid']).toBe('true');
    expect(props['aria-describedby']).toBe('tags-hint profile-tags-error');
    const errors = renderFieldErrors(state, 'tags', `${props.id}-error`);
    expect(errors).toContain('id="profile-tags-error"');
    expect(errors).toContain('Choose fewer tags');
    expect(helper.field('tags', { control: 'text', state })['aria-describedby']).toBe(`${formFieldId('tags')}-error`);
  });
});
