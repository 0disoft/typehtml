# Native form rendering and framework state

`renderNativeForm(form, csrfToken, options)` renders the same escaped form fragment on the initial GET and an invalid 422. Use `options.state = createFormState(rawValues, issues, ...)` on failure and `mode: 'invalid'` to omit optional fields that were never submitted. The default schema-form invalid renderer also uses this path. `fields` provides human labels, hints and radio/select choices; `renderNativeField` and `renderNativeFields` fit existing page layouts. These functions do not start a server or create a template language.

```ts
const render = (state = createFormState({}, [])) => renderNativeForm(form, token, {
  state,
  fields: { name: { label: 'Display name', hint: 'Visible on your profile' } },
  summaryAutofocus: true,
});
// GET: render()
// invalid hook: render(createFormState(rawValues, issues))
```

Repeated arrays keep order and duplicate values. A select/checkbox choice set is used only when it can represent those values exactly; otherwise the renderer uses ordered text controls. Dynamic rows use declared concrete names and caller-supplied stable row keys, never generated random identity. File controls retain no file value after a 422. Labels, descriptions and summaries link to the same field IDs; duplicate invalid row keys fall back to distinct index IDs. `focusNativeErrorSummary(root)` optionally focuses the committed error summary after a host state update.

In browser code, import `focusNativeErrorSummary` from `@0disoft/typehtml/adapters/react` or `@0disoft/typehtml/adapters/svelte`. Both expose the same DOM-only helper without importing server rendering, storage or Node crypto. The root export remains available for existing callers, but the package root includes server APIs and is not a browser entry point. Call the helper after the host has committed an invalid form, for example from a React effect or after Svelte's `tick()`; it does not move focus automatically.

`createFormMessages('ko', { fields: form.fields, uploads: form.uploads, labels })` provides localizable TypeHTML messages, including file count and duplicate-row errors. Vendor `SCHEMA` issues retain their own text unless an application supplies a message mapping.

`validateSchemaFormInput(form, businessEntries, { signal })` performs only bounded wire decoding and input-schema validation. It never reads a request, checks output, authorizes a requester, executes an operation, or creates an HTTP endpoint. Authentication, CSRF and authorization still belong to the real server handler; a preview result is not permission to write. Required uploads remain missing until a real multipart request supplies capabilities.

Optional connections use the application's existing state implementation:

```ts
import * as React from 'react';
import { createReactSubmissionHook, toReactFieldProps } from '@0disoft/typehtml/adapters/react';
const useSubmission = createReactSubmissionHook(React);
// Inside a component: const submission = useSubmission();
// A user action explicitly invokes submission.run(({signal}) => hostTask(signal)).
// toReactFieldProps(props) maps native attributes and uses uncontrolled defaults.
```

```ts
import { writable } from 'svelte/store';
import { onDestroy } from 'svelte';
import { connectSvelteSubmission } from '@0disoft/typehtml/adapters/svelte';
const submission = connectSvelteSubmission(writable);
onDestroy(submission.dispose);
```

`createSubmissionTask` coordinates one explicit host task: duplicate pending runs fail, cancellation/deadlines release listeners/timers, late responses cannot replace newer state, and disposal aborts the active task. React uses its own hooks and Svelte its own writable store. TypeHTML does not install submit interception, serialize bodies, retry POST requests or introduce a reactive store. The baseline native form works without JavaScript. Disable a button with pending state when useful; durable duplicate-effect protection still requires the server's idempotency policy. Canceling client work does not roll back an already committed server operation.
