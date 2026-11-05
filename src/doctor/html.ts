import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';

type P5Node = DefaultTreeAdapterTypes.Node;
type P5Element = DefaultTreeAdapterTypes.Element;
type P5Parent = DefaultTreeAdapterTypes.ParentNode;

export interface SourceLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
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
}

export interface ParsedDocument {
  readonly documentUrl: string;
  readonly baseUrl: string;
  readonly forms: readonly FormFact[];
  readonly formIds: ReadonlyMap<string, readonly FormFact[]>;
  readonly controls: readonly ControlFact[];
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

function textContent(node: P5Node): string {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterTypes.TextNode).value;
  if (!('childNodes' in node) || !node.childNodes) return '';
  return node.childNodes.map(textContent).join('');
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
  let parent = control.parentNode;
  while (parent) {
    if (parent.nodeName === 'fieldset' && isElement(parent) && hasAttribute(parent, 'disabled')) {
      const firstLegend = parent.childNodes.find(
        (child): child is P5Element => isElement(child) && child.tagName === 'legend',
      );
      if (!firstLegend || !isInside(control, firstLegend)) return true;
    }
    parent = parent.parentNode;
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
  let parent = element.parentNode;
  while (parent) {
    if (parent.nodeName === 'form' && isElement(parent)) return parent;
    parent = parent.parentNode;
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
    type: tag === 'input' || tag === 'button' ? (attribute(element, 'type') ?? (tag === 'button' ? 'submit' : 'text')).toLowerCase() : tag,
    name: name === null || name === '' ? null : name,
    disabled: hasAttribute(element, 'disabled') || isDisabledByFieldset(element),
    readonly: hasAttribute(element, 'readonly'),
    required: hasAttribute(element, 'required'),
    multiple: tag === 'select' && hasAttribute(element, 'multiple'),
    order,
    location: locationOf(element, path),
  };
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
  let order = 0;
  const forms: P5Element[] = [];
  const formIds = new Map<string, P5Element[]>();
  for (const element of elements) {
    if (element.tagName !== 'form') continue;
    forms.push(element);
    const id = attribute(element, 'id');
    if (id !== null && id !== '') {
      const list = formIds.get(id) ?? [];
      list.push(element);
      formIds.set(id, list);
    }
  }
  const controls = elements
    .filter((element) => ['input', 'select', 'textarea', 'button'].includes(element.tagName))
    .map((element) => makeControl(element, order++, path));
  const controlByForm = new Map<P5Element, ControlFact[]>();
  for (const form of forms) controlByForm.set(form, []);
  for (const control of controls) {
    const formAttribute = attribute(control.element, 'form');
    let owner: P5Element | null = null;
    if (formAttribute !== null) {
      const candidates = formIds.get(formAttribute);
      if (candidates && candidates.length === 1) owner = candidates[0]!;
    } else {
      owner = nearestForm(control.element);
    }
    if (owner) controlByForm.get(owner)?.push(control);
  }
  const formFacts: FormFact[] = forms.map((element) => {
    const id = attribute(element, 'id');
    return {
      element,
      id: id === '' ? null : id,
      order: elements.indexOf(element),
      location: locationOf(element, path),
      controls: (controlByForm.get(element) ?? []).sort((a, b) => a.order - b.order),
      documentUrl,
      baseUrl,
    };
  });
  const formIdFact = new Map<string, FormFact[]>();
  for (const [id, list] of formIds) {
    formIdFact.set(id, list.map((element) => formFacts.find((fact) => fact.element === element)!));
  }
  return {
    documentUrl,
    baseUrl,
    forms: formFacts,
    formIds: formIdFact,
    controls,
  };
}

function selectEntries(control: ControlFact): HtmlEntry[] {
  const options = control.element.childNodes.filter(
    (child): child is P5Element => isElement(child) && child.tagName === 'option',
  );
  const selected = options.filter((option) => hasAttribute(option, 'selected') && !hasAttribute(option, 'disabled'));
  const chosen = control.multiple
    ? selected
    : selected.length > 0
      ? selected.slice(0, 1)
      : options.filter((option) => !hasAttribute(option, 'disabled')).slice(0, 1);
  return chosen.map((option) => ({
    name: control.name as string,
    value: attribute(option, 'value') ?? textContent(option),
    control,
    via: 'control' as const,
  }));
}

function textareaValue(control: ControlFact): string {
  let value = textContent(control.element).replace(/\r\n?/g, '\n');
  if (value.startsWith('\n')) value = value.slice(1);
  return value;
}

function dirnameEntry(control: ControlFact): HtmlEntry | null {
  const dirname = attribute(control.element, 'dirname');
  if (dirname === null || dirname === '' || control.name === null) return null;
  if (control.tagName === 'textarea' || (control.tagName === 'input' && !['checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button'].includes(control.type))) {
    return { name: dirname, value: attribute(control.element, 'dir') ?? 'ltr', control, via: 'dirname' };
  }
  return null;
}

function isSuccessfulControl(control: ControlFact, submitter: ControlFact | null): boolean {
  if (control.disabled) return false;
  if (control.tagName === 'button') {
    return control === submitter && control.type !== 'button' && control.type !== 'reset';
  }
  if (control.tagName === 'input') {
    if (control.type === 'submit') return control === submitter;
    if (control.type === 'image') return false;
    if (control.type === 'button' || control.type === 'reset' || control.type === 'file') return false;
    if (control.type === 'checkbox' || control.type === 'radio') return hasAttribute(control.element, 'checked');
  }
  return true;
}

export function collectFormEntries(form: FormFact, submitter: ControlFact | null): CollectionResult {
  const entries: HtmlEntry[] = [];
  const possibleCounts = new Map<string, number>();
  const unsupportedNames = new Set<string>();
  const unsupportedControls: { control: ControlFact; reason: string }[] = [];
  const bump = (name: string, amount = 1) => possibleCounts.set(name, (possibleCounts.get(name) ?? 0) + amount);
  for (const control of form.controls) {
    if (control.name !== null && !control.disabled) {
      if (control.tagName === 'input' && control.type === 'file') {
        unsupportedNames.add(control.name);
        unsupportedControls.push({ control, reason: 'file-input' });
      } else if (control.tagName === 'input' && control.type === 'image') {
        unsupportedNames.add(control.name);
        unsupportedControls.push({ control, reason: 'image-submit' });
      } else if (control.tagName === 'select' && control.multiple) {
        const options = control.element.childNodes.filter(
          (child): child is P5Element => isElement(child) && child.tagName === 'option' && !hasAttribute(child, 'disabled'),
        );
        bump(control.name, Math.max(1, options.length));
      } else if (control.tagName === 'input' && (control.type === 'checkbox' || control.type === 'radio')) {
        bump(control.name, 1);
      } else if (control.tagName === 'button' || (control.tagName === 'input' && control.type === 'submit')) {
        if (control === submitter) bump(control.name, 1);
      } else {
        bump(control.name, 1);
      }
    }
    if (!isSuccessfulControl(control, submitter)) continue;
    if (control.name === null) continue;
    if (control.tagName === 'select') {
      entries.push(...selectEntries(control));
    } else if (control.tagName === 'textarea') {
      entries.push({ name: control.name, value: textareaValue(control), control, via: 'control' });
    } else if (control.tagName === 'input' || control.tagName === 'button') {
      if (control.type === 'file' || control.type === 'image') continue;
      const value = attribute(control.element, 'value') ?? (control.type === 'checkbox' || control.type === 'radio' ? 'on' : '');
      entries.push({ name: control.name, value, control, via: control === submitter ? 'submitter' : 'control' });
    }
    const dirname = dirnameEntry(control);
    if (dirname) {
      entries.push(dirname);
      bump(dirname.name, 1);
    }
  }
  return { entries, possibleCounts, unsupportedNames, unsupportedControls, submitter };
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
  if (findSubmitters(form).length > 0) return false;
  const blocking = form.controls.filter(
    (control) =>
      !control.disabled &&
      control.name !== null &&
      (control.tagName === 'textarea' ||
        (control.tagName === 'input' &&
          ['text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number'].includes(control.type))),
  );
  const otherNamed = form.controls.filter(
    (control) => !control.disabled && control.name !== null && !blocking.includes(control),
  );
  return blocking.length === 1 && otherNamed.length === 0;
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
  const normalizedMethod = method.toLowerCase();
  if (normalizedMethod === 'dialog') {
    return { target: null, problem: { code: 'UNSUPPORTED_METHOD', message: 'dialog method is outside the native form submission profile' } };
  }
  const encoding =
    (submitter ? attribute(submitter.element, 'formenctype') : null) ??
    attribute(form.element, 'enctype') ??
    'application/x-www-form-urlencoded';
  const normalizedEncoding = encoding.toLowerCase();
  if (normalizedEncoding !== 'application/x-www-form-urlencoded') {
    return {
      target: null,
      problem: { code: 'UNSUPPORTED_ENCODING', message: 'only application/x-www-form-urlencoded is supported' },
    };
  }
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
  if (target.origin !== documentUrl.origin) {
    return {
      target: effective,
      problem: { code: 'EXTERNAL_ORIGIN', message: 'effective action points outside the document origin' },
    };
  }
  return { target: effective, problem: null };
}