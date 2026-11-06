import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import type { SourceLocation } from './types.ts';

type P5Node = DefaultTreeAdapterTypes.Node;
type P5Element = DefaultTreeAdapterTypes.Element;
type P5Parent = DefaultTreeAdapterTypes.ParentNode;

function parentOf(node: P5Node): P5Parent | null {
  return (node as { parentNode?: P5Parent | null }).parentNode ?? null;
}

export interface ControlFact {
  readonly element: P5Element;
  readonly tagName: 'input' | 'select' | 'textarea' | 'button';
  readonly type: string;
  readonly name: string | null;
  readonly disabled: boolean;
  readonly readonly: boolean;
  readonly required: boolean;
  readonly multiple: boolean;
  readonly order: number;
  readonly location: SourceLocation;
}

export interface FormFact {
  readonly element: P5Element;
  readonly id: string | null;
  readonly order: number;
  readonly location: SourceLocation;
  readonly controls: readonly ControlFact[];
  readonly documentUrl: string;
  readonly baseUrl: string;
  readonly hasDynamicControls: boolean;
}

export interface ParsedDocument {
  readonly documentUrl: string;
  readonly baseUrl: string;
  readonly forms: readonly FormFact[];
  readonly formIds: ReadonlyMap<string, readonly FormFact[]>;
  readonly controls: readonly ControlFact[];
  readonly hasScript: boolean;
  readonly duplicateIds: ReadonlySet<string>;
}

export interface HtmlEntry {
  readonly name: string;
  readonly value: string;
  readonly control: ControlFact;
  readonly via: 'control' | 'dirname' | 'submitter';
}

export interface CollectionResult {
  readonly entries: readonly HtmlEntry[];
  readonly possibleCounts: ReadonlyMap<string, number>;
  readonly unsupportedNames: ReadonlySet<string>;
  readonly unsupportedControls: readonly { readonly control: ControlFact; readonly reason: string }[];
  /** A native user choice can omit these names even though a successful entry is possible. */
  readonly conditionalNames: ReadonlySet<string>;
  readonly submitter: ControlFact | null;
}

export interface EffectiveTarget {
  readonly url: URL;
  readonly method: string;
  readonly encoding: string;
  readonly skipValidation: boolean;
  readonly hasActionAttribute: boolean;
  readonly hasSubmitterOverride: boolean;
}

export interface TargetProblem {
  readonly code: 'INVALID_URL' | 'UNSUPPORTED_METHOD' | 'UNSUPPORTED_ENCODING' | 'EXTERNAL_ORIGIN' | 'NONCANONICAL_PATH';
  readonly message: string;
}

export interface TargetResult {
  readonly target: EffectiveTarget | null;
  readonly problem: TargetProblem | null;
}

export function attribute(element: P5Element, name: string): string | null {
  const found = element.attrs.find((attr) => attr.name === name);
  return found ? found.value : null;
}

export function hasAttribute(element: P5Element, name: string): boolean {
  return element.attrs.some((attr) => attr.name === name);
}

function isElement(node: P5Node): node is P5Element {
  return typeof (node as P5Element).tagName === 'string';
}

function locationOf(element: P5Element, path: string): SourceLocation {
  const loc = element.sourceCodeLocation;
  if (!loc) return { path, line: 1, column: 1, offset: 0 };
  return { path, line: loc.startLine, column: loc.startCol, offset: loc.startOffset };
}

function walkElements(root: P5Parent, out: P5Element[]): void {
  for (const child of root.childNodes) {
    if (!isElement(child)) continue;
    out.push(child);
    if (child.tagName === 'template') continue;
    walkElements(child, out);
  }
}

function firstBaseUrl(documentUrl: string, elements: readonly P5Element[]): string {
  const base = elements.find((element) => element.tagName === 'base' && attribute(element, 'href') !== null);
  if (!base) return documentUrl;
  try {
    return new URL(attribute(base, 'href') as string, documentUrl).href;
  } catch {
    return documentUrl;
  }
}

function isDisabledByFieldset(control: P5Element): boolean {
  let parent = parentOf(control);
  while (parent) {
    if (parent.nodeName === 'fieldset' && isElement(parent) && hasAttribute(parent, 'disabled')) {
      const firstLegend = parent.childNodes.find(
        (child): child is P5Element => isElement(child) && child.tagName === 'legend',
      );
      if (!firstLegend || !isInside(control, firstLegend)) return true;
    }
    parent = parentOf(parent);
  }
  return false;
}

function isInside(node: P5Node, ancestor: P5Node): boolean {
  let current: P5Node | null = node;
  while (current) {
    if (current === ancestor) return true;
    current = 'parentNode' in current ? current.parentNode : null;
  }
  return false;
}

function nearestForm(element: P5Element): P5Element | null {
  let parent = parentOf(element);
  while (parent) {
    if (parent.nodeName === 'form' && isElement(parent)) return parent;
    parent = parentOf(parent);
  }
  return null;
}

function makeControl(element: P5Element, order: number, path: string): ControlFact {
  const tag = element.tagName;
  if (tag !== 'input' && tag !== 'select' && tag !== 'textarea' && tag !== 'button') {
    throw new Error('unsupported form control');
  }
  const name = attribute(element, 'name');
  return {
    element,
    tagName: tag,
    type: normalizedControlType(element),
    name: name === null || name === '' ? null : name,
    disabled: hasAttribute(element, 'disabled') || isDisabledByFieldset(element),
    readonly: hasAttribute(element, 'readonly'),
    required: hasAttribute(element, 'required'),
    multiple: tag === 'select' && hasAttribute(element, 'multiple'),
    order,
    location: locationOf(element, path),
  };
}

function normalizedControlType(element: P5Element): string {
  const value = (attribute(element, 'type') ?? '').toLowerCase();
  if (element.tagName === 'button') return ['button', 'reset'].includes(value) ? value : 'submit';
  if (element.tagName !== 'input') return element.tagName;
  return ['hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number', 'range', 'color', 'checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button'].includes(value) ? value : 'text';
}

function insideDatalist(element: P5Element): boolean {
  let parent = parentOf(element);
  while (parent) {
    if (parent.nodeName === 'datalist') return true;
    parent = parentOf(parent);
  }
  return false;
}

function indexDynamicControls(elements: readonly P5Element[]): {
  readonly descendants: ReadonlySet<P5Element>;
  readonly formAttributes: ReadonlySet<string | null>;
} {
  const descendants = new Set<P5Element>();
  const formAttributes = new Set<string | null>();
  // Reverse document order visits children before their parents, including non-form ancestors.
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index]!;
    if (element.tagName.includes('-')) {
      descendants.add(element);
      formAttributes.add(attribute(element, 'form'));
    }
    const parent = parentOf(element);
    if (descendants.has(element) && parent !== null && isElement(parent)) descendants.add(parent);
  }
  return { descendants, formAttributes };
}

export function parseHtmlDocument(html: string, documentUrl: string, path = '<html>'): ParsedDocument {
  let parsed: URL;
  try {
    parsed = new URL(documentUrl);
  } catch {
    throw new Error('DOCUMENT_URL_INVALID');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('DOCUMENT_URL_UNSUPPORTED');
  }
  const document = parse(html, { sourceCodeLocationInfo: true });
  const elements: P5Element[] = [];
  walkElements(document, elements);
  const baseUrl = firstBaseUrl(documentUrl, elements);
  const dynamic = indexDynamicControls(elements);
  const elementOrder = new Map<P5Element, number>();
  let order = 0;
  const forms: P5Element[] = [];
  const elementsById = new Map<string, P5Element[]>();
  for (const element of elements) {
    elementOrder.set(element, elementOrder.size);
    const elementId = attribute(element, 'id');
    if (elementId) {
      const list = elementsById.get(elementId) ?? [];
      list.push(element);
      elementsById.set(elementId, list);
    }
    if (element.tagName !== 'form') continue;
    forms.push(element);
  }
  const controls = elements
    .filter((element) => !insideDatalist(element) && ['input', 'select', 'textarea', 'button'].includes(element.tagName))
    .map((element) => makeControl(element, order++, path));
  const controlByForm = new Map<P5Element, ControlFact[]>();
  for (const form of forms) controlByForm.set(form, []);
  for (const control of controls) {
    const formAttribute = attribute(control.element, 'form');
    let owner: P5Element | null = null;
    if (formAttribute !== null) {
      const candidate = elementsById.get(formAttribute)?.[0];
      if (candidate?.tagName === 'form') owner = candidate;
    } else {
      owner = nearestForm(control.element);
    }
    if (owner) controlByForm.get(owner)?.push(control);
  }
  const formIdFact = new Map<string, FormFact[]>();
  const formFacts: FormFact[] = forms.map((element) => {
    const id = attribute(element, 'id');
    const fact: FormFact = {
      element,
      id: id === '' ? null : id,
      order: elementOrder.get(element)!,
      location: locationOf(element, path),
      controls: (controlByForm.get(element) ?? []).sort((a, b) => a.order - b.order),
      documentUrl,
      baseUrl,
      hasDynamicControls: dynamic.descendants.has(element) || dynamic.formAttributes.has(id),
    };
    if (id !== null && id !== '') {
      const list = formIdFact.get(id) ?? [];
      list.push(fact);
      formIdFact.set(id, list);
    }
    return fact;
  });
  return {
    documentUrl,
    baseUrl,
    forms: formFacts,
    formIds: formIdFact,
    controls,
    hasScript: elements.some((element) => element.tagName === 'script' || element.attrs.some((attr) => attr.name.startsWith('on'))),
    duplicateIds: new Set([...elementsById].filter(([, list]) => list.length > 1).map(([id]) => id)),
  };
}

function textContent(node: P5Node): string {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterTypes.TextNode).value;
  return 'childNodes' in node ? node.childNodes.map(textContent).join('') : '';
}

function optionIsDisabled(option: P5Element): boolean {
  return hasAttribute(option, 'disabled') ||
    (parentOf(option)?.nodeName === 'optgroup' && hasAttribute(parentOf(option) as P5Element, 'disabled'));
}

function selectOptions(control: ControlFact): P5Element[] {
  const elements: P5Element[] = [];
  walkElements(control.element, elements);
  return elements.filter((option) => option.tagName === 'option');
}

function optionText(node: P5Node): string {
  if (isElement(node) && node.tagName === 'script') return '';
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterTypes.TextNode).value;
  return 'childNodes' in node ? node.childNodes.map(optionText).join('') : '';
}

/** Possible successful controls, not an exhaustive enumeration of every user-selected state. */
export function collectFormEntries(form: FormFact, submitter: ControlFact | null, skipValidation = false): CollectionResult {
  const entries: HtmlEntry[] = [];
  const possibleCounts = new Map<string, number>();
  const unsupportedNames = new Set<string>();
  const conditionalNames = new Set<string>();
  const unsupportedControls: { control: ControlFact; reason: string }[] = [];
  const radioGroups = new Map<string, ControlFact[]>();
  for (const control of form.controls) {
    // Disabled radios still participate in group required/checked validation, but not submission.
    if (control.type !== 'radio' || control.name === null) continue;
    const group = radioGroups.get(control.name);
    if (group) group.push(control); else radioGroups.set(control.name, [control]);
  }
  const emittedRadioGroups = new Set<string>();
  const append = (control: ControlFact, value: string, count = 1) => {
    const name = control.name!;
    possibleCounts.set(name, (possibleCounts.get(name) ?? 0) + count);
    entries.push({ name, value, control, via: control === submitter ? 'submitter' : 'control' });
  };
  for (const control of form.controls) {
    if (control.disabled) continue;
    const unsupportedReason = control.tagName === 'input' && ['file', 'image'].includes(control.type)
        ? `${control.type}-input`
        : attribute(control.element, 'dirname') !== null ? 'dirname' : null;
    if (unsupportedReason !== null) {
      if (control.name) unsupportedNames.add(control.name);
      const directionName = attribute(control.element, 'dirname');
      if (directionName) unsupportedNames.add(directionName);
      unsupportedControls.push({ control, reason: unsupportedReason });
      continue;
    }
    if (control.tagName === 'input' && ['button', 'reset'].includes(control.type)) continue;
    if (control.tagName === 'button' || control.type === 'submit') {
      if (control !== submitter) continue;
    }
    if (control.name === null) continue;
    if (control.type === 'radio') {
      if (emittedRadioGroups.has(control.name)) continue;
      emittedRadioGroups.add(control.name);
      const group = radioGroups.get(control.name)!;
      const checked = group.findLast((item) => hasAttribute(item.element, 'checked'));
      const representative = checked !== undefined && !checked.disabled ? checked : control;
      if (skipValidation || !group.some((item) => item.required) || checked?.disabled === true) conditionalNames.add(control.name);
      append(representative, attribute(representative.element, 'value') ?? 'on');
      continue;
    }
    if (control.type === 'checkbox') {
      if (skipValidation || !control.required) conditionalNames.add(control.name);
      append(control, attribute(control.element, 'value') ?? 'on');
      continue;
    }
    if (control.tagName === 'select') {
      const allOptions = selectOptions(control);
      const options = allOptions.filter((option) => !optionIsDisabled(option));
      if (options.length === 0) continue;
      const selected = options.findLast((option) => hasAttribute(option, 'selected')) ?? options[0]!;
      const size = Number(attribute(control.element, 'size') ?? 0);
      if (control.multiple || size > 1) {
        if (skipValidation || !control.required) conditionalNames.add(control.name);
      }
      // A disabled selected option can satisfy native required validation but supplies no entry.
      if (allOptions.some((option) => optionIsDisabled(option) && hasAttribute(option, 'selected'))) conditionalNames.add(control.name);
      append(control, attribute(selected, 'value') ?? optionText(selected).replace(/[\t\n\f\r ]+/g, ' ').replace(/^ | $/g, ''), control.multiple ? options.length : 1);
      continue;
    }
    append(control, control.tagName === 'textarea' ? textContent(control.element).replace(/\r?\n/g, '\r\n') : attribute(control.element, 'value') ?? '');
  }
  return { entries, possibleCounts, unsupportedNames, unsupportedControls, conditionalNames, submitter };
}
export function findSubmitters(form: FormFact): ControlFact[] {
  return form.controls.filter((control) => {
    if (control.disabled) return false;
    if (control.tagName === 'button') return control.type === 'submit';
    if (control.tagName === 'input') return control.type === 'submit' || control.type === 'image';
    return false;
  });
}

export function canImplicitlySubmit(form: FormFact): boolean {
  if (form.controls.some((control) => (control.tagName === 'button' && control.type === 'submit') || (control.tagName === 'input' && ['submit', 'image'].includes(control.type)))) return false;
  const blocking = form.controls.filter(
    (control) =>
      !control.disabled &&
      control.tagName === 'input' &&
      ['text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number'].includes(control.type),
  );
  return blocking.length <= 1;
}

function resolveAction(form: FormFact, submitter: ControlFact | null): { raw: string | null; override: boolean } {
  if (submitter) {
    const override = attribute(submitter.element, 'formaction');
    if (override !== null) return { raw: override, override: true };
  }
  const action = attribute(form.element, 'action');
  return { raw: action, override: false };
}

export function resolveEffectiveTarget(form: FormFact, submitter: ControlFact | null): TargetResult {
  const { raw, override } = resolveAction(form, submitter);
  const documentUrl = new URL(form.documentUrl);
  let target: URL;
  try {
    target = raw === null || raw === '' ? new URL(form.documentUrl) : new URL(raw, form.baseUrl);
  } catch {
    return { target: null, problem: { code: 'INVALID_URL', message: 'form action does not resolve to a URL' } };
  }
  const method = (submitter ? attribute(submitter.element, 'formmethod') : null) ?? attribute(form.element, 'method') ?? 'get';
  const normalizedMethod = ['post', 'dialog'].includes(method.toLowerCase()) ? method.toLowerCase() : 'get';
  const encoding =
    (submitter ? attribute(submitter.element, 'formenctype') : null) ??
    attribute(form.element, 'enctype') ??
    'application/x-www-form-urlencoded';
  const normalizedEncoding = ['multipart/form-data', 'text/plain'].includes(encoding.toLowerCase()) ? encoding.toLowerCase() : 'application/x-www-form-urlencoded';
  const effective: EffectiveTarget = {
    url: target,
    method: normalizedMethod,
    encoding: normalizedEncoding,
    skipValidation: submitter
      ? hasAttribute(submitter.element, 'formnovalidate') || hasAttribute(form.element, 'novalidate')
      : hasAttribute(form.element, 'novalidate'),
    hasActionAttribute: raw !== null,
    hasSubmitterOverride: override,
  };
  if (normalizedMethod === 'dialog') return { target: effective, problem: { code: 'UNSUPPORTED_METHOD', message: 'dialog method is outside the native form submission profile' } };
  if (normalizedEncoding !== 'application/x-www-form-urlencoded') return { target: effective, problem: { code: 'UNSUPPORTED_ENCODING', message: 'only application/x-www-form-urlencoded is supported' } };
  if (target.origin !== documentUrl.origin) {
    return {
      target: effective,
      problem: { code: 'EXTERNAL_ORIGIN', message: 'effective action points outside the document origin' },
    };
  }
  return { target: effective, problem: null };
}
