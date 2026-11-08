import type { DefaultTreeAdapterTypes } from 'parse5';
import { attribute, hasAttribute, type ControlFact, type FormFact } from './html.ts';
import type { SourceLocation } from './types.ts';

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;

export interface RichFieldFact {
  readonly name: string;
  /** Semantic values, excluding an unselected file input's empty File placeholder. */
  readonly minimum: number;
  readonly maximum: number | null;
  readonly kind: 'text' | 'file' | 'mixed';
  readonly controls: readonly ControlFact[];
  readonly locations: readonly SourceLocation[];
  /** Finite native choices only; editable text input values are not treated as constraints. */
  readonly choices: readonly Readonly<{ value: string; control: ControlFact }>[];
}

export interface RichCollectionResult {
  readonly fields: ReadonlyMap<string, RichFieldFact>;
  readonly unsupportedControls: readonly Readonly<{ control: ControlFact; reason: string }>[];
  readonly unsupportedNames: ReadonlySet<string>;
}

function isElement(node: Node): node is Element { return 'tagName' in node; }

function optionsIn(element: Element): Element[] {
  const options: Element[] = [];
  const visit = (node: Node) => {
    if (!isElement(node) || node.tagName === 'template') return;
    if (node.tagName === 'option') options.push(node);
    for (const child of node.childNodes) visit(child);
  };
  for (const child of element.childNodes) visit(child);
  return options;
}

function disabledOption(option: Element): boolean {
  const parent = option.parentNode;
  return hasAttribute(option, 'disabled') || parent !== null && parent !== undefined &&
    isElement(parent) && parent.tagName === 'optgroup' && hasAttribute(parent, 'disabled');
}

function text(node: Node): string {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterTypes.TextNode).value;
  if (isElement(node) && node.tagName === 'script') return '';
  return 'childNodes' in node ? node.childNodes.map(text).join('') : '';
}

function optionValue(option: Element): string {
  return attribute(option, 'value') ?? text(option).replace(/[\t\n\f\r ]+/g, ' ').replace(/^ | $/g, '');
}

/**
 * One interval per wire name, not 2^N combinations of checkbox/selection state.
 * Radios are grouped before summing, and only the selected native submitter contributes.
 */
export function collectRichFormControls(form: FormFact, submitter: ControlFact | null, skipValidation = false, redactedValues = false): RichCollectionResult {
  type MutableFact = { name: string; minimum: number; maximum: number | null; kind: RichFieldFact['kind'];
    controls: ControlFact[]; locations: SourceLocation[]; choices: { value: string; control: ControlFact }[] };
  const fields = new Map<string, MutableFact>();
  const unsupportedControls: { control: ControlFact; reason: string }[] = [];
  const unsupportedNames = new Set<string>();
  const groups = new Map<string, ControlFact[]>();
  for (const control of form.controls) {
    if (control.type !== 'radio' || control.name === null) continue;
    const group = groups.get(control.name);
    if (group) group.push(control); else groups.set(control.name, [control]);
  }
  const emittedGroups = new Set<string>();
  const append = (controls: readonly ControlFact[], minimum: number, maximum: number | null,
    kind: 'text' | 'file', choices: readonly { value: string; control: ControlFact }[] = []) => {
    const name = controls[0]!.name!;
    let fact = fields.get(name);
    if (fact === undefined) {
      fact = { name, minimum: 0, maximum: 0, kind, controls: [], locations: [], choices: [] };
      fields.set(name, fact);
    }
    fact.minimum += minimum;
    fact.maximum = fact.maximum === null || maximum === null ? null : fact.maximum + maximum;
    if (fact.kind !== kind) fact.kind = 'mixed';
    for (const control of controls) { fact.controls.push(control); fact.locations.push(control.location); }
    for (const choice of choices) fact.choices.push(choice);
  };
  for (const control of form.controls) {
    if (control.disabled) continue;
    const direction = attribute(control.element, 'dirname');
    if (control.type === 'image' || direction !== null) {
      if (control.name !== null) unsupportedNames.add(control.name);
      if (direction !== null && direction !== '') unsupportedNames.add(direction);
      unsupportedControls.push({ control, reason: control.type === 'image' ? 'image-input' : 'dirname' });
      continue;
    }
    if (control.tagName === 'input' && ['button', 'reset'].includes(control.type)) continue;
    if ((control.tagName === 'button' || control.type === 'submit') && control !== submitter) continue;
    if (control.name === null) continue;
    if (control.type === 'radio') {
      if (emittedGroups.has(control.name)) continue;
      emittedGroups.add(control.name);
      const group = groups.get(control.name)!;
      const enabled = group.filter((item) => !item.disabled);
      const checked = group.findLast((item) => hasAttribute(item.element, 'checked'));
      const minimum = !skipValidation && group.some((item) => item.required) && checked?.disabled !== true ? 1 : 0;
      append(enabled, minimum, 1, 'text', enabled.map((item) => ({ value: attribute(item.element, 'value') ?? 'on', control: item })));
      continue;
    }
    if (control.type === 'checkbox') {
      append([control], !skipValidation && control.required ? 1 : 0, 1, 'text', [{ value: attribute(control.element, 'value') ?? 'on', control }]);
      continue;
    }
    if (control.tagName === 'select') {
      const all = optionsIn(control.element);
      const options = all.filter((option) => !disabledOption(option));
      const disabledSelected = all.some((option) => disabledOption(option) && hasAttribute(option, 'selected'));
      const multiple = hasAttribute(control.element, 'multiple');
      const listbox = multiple || Number(attribute(control.element, 'size') ?? 0) > 1;
      const minimum = redactedValues || options.length === 0 || disabledSelected || listbox && (skipValidation || !control.required) ? 0 : 1;
      // Only the first direct empty option is a placeholder; later empty-valued options can be valid.
      const placeholder = !skipValidation && control.required && !listbox && all[0]?.parentNode === control.element && optionValue(all[0]!) === '' ? all[0] : undefined;
      const choices = options.filter((option) => option !== placeholder)
        .map((option) => ({ value: optionValue(option), control }));
      append([control], minimum, multiple ? options.length : Math.min(1, options.length), 'text', choices);
      continue;
    }
    if (control.type === 'file') {
      append([control], !skipValidation && control.required ? 1 : 0,
        hasAttribute(control.element, 'multiple') ? null : 1, 'file');
      continue;
    }
    const fixed = control.type === 'hidden' || control.type === 'submit' || control.tagName === 'button' || control.readonly;
    const value = control.tagName === 'textarea' ? text(control.element).replace(/\r?\n/g, '\r\n') : attribute(control.element, 'value') ?? '';
    append([control], 1, 1, 'text', fixed ? [{ value, control }] : []);
  }
  const immutable = new Map<string, RichFieldFact>();
  for (const [name, fact] of fields) immutable.set(name, Object.freeze({ ...fact,
    controls: Object.freeze(fact.controls), locations: Object.freeze(fact.locations), choices: Object.freeze(fact.choices),
  }));
  return Object.freeze({ fields: immutable, unsupportedControls: Object.freeze(unsupportedControls), unsupportedNames });
}
