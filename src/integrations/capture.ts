import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { sourceSha256 } from '../contract/behavior.ts';
import { escapeHtml } from '../form/html.ts';
import { collectRenderedHtml, type CollectRenderedHtmlOptions, type RenderedCollection, type RenderedSnapshotSelection } from '../doctor/capture.ts';

export interface FrameworkCaptureSelection extends RenderedSnapshotSelection {
  /** An invalid-form state may explicitly expect 422; unexpected statuses always fail. */
  readonly expectedStatus?: number;
}
export interface FrameworkCaptureContext { readonly request: Request; readonly signal: AbortSignal }
export interface FrameworkCaptureOptions extends Omit<CollectRenderedHtmlOptions, 'selections' | 'render' | 'fetch'> {
  readonly selections: readonly FrameworkCaptureSelection[];
  /** Additional named control values to remove. Protocol tokens and password inputs are always redacted. */
  readonly redactFields?: readonly string[];
}
export interface FrameworkRenderedCollection extends RenderedCollection {
  readonly framework: 'hono' | 'astro' | 'sveltekit';
  readonly redaction: Readonly<{ mode: 'control-values'; fields: readonly string[]; controls: number }>;
}

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;
type Patch = Readonly<{ start: number; end: number; text: string }>;
const marker = '[REDACTED]';
const defaults = { maxBytes: 2 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 } as const;

function redactionNames(fields: readonly string[] = []): readonly string[] {
  if (!Array.isArray(fields) || fields.length > 1024 || fields.some((field) => typeof field !== 'string' || field.length === 0 || field.length > 1024)) throw new TypeError('invalid capture redaction fields');
  return Object.freeze([...new Set(['_bc_csrf', '_bc_request', ...fields])]);
}

/** Remove only declared control values, preserving native structural flags and surrounding source. */
export function redactCapturedHtml(html: string, fields: readonly string[] = []): Readonly<{ html: string; fields: readonly string[]; controls: number }> {
  const names = redactionNames(fields);
  const sensitive = new Set(names);
  let incompleteTag = false;
  const document = parse(html, { sourceCodeLocationInfo: true, onParseError: (error) => { if (error.code === 'eof-in-tag') incompleteTag = true; } });
  if (incompleteTag) throw new TypeError('capture HTML contains an incomplete tag that cannot be safely redacted');
  const elements: Element[] = [];
  const visit = (node: Node) => {
    if ('tagName' in node) elements.push(node);
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
    if ('content' in node && node.tagName === 'template') visit(node.content);
  };
  visit(document);
  const attribute = (element: Element, name: string) => element.attrs.find((attr) => attr.name === name)?.value;
  const lists = new Set<string>();
  for (const element of elements) if (element.tagName === 'input' && (sensitive.has(attribute(element, 'name') ?? '') || attribute(element, 'type')?.toLowerCase() === 'password')) {
    const list = attribute(element, 'list'); if (list !== undefined) lists.add(list);
  }
  const patches: Patch[] = [];
  const handled = new Set<Element>();
  let controls = 0;
  const redactElement = (element: Element, contents: boolean) => {
    if (handled.has(element)) return;
    handled.add(element);
    const location = element.sourceCodeLocation;
    if (location?.startTag === undefined) throw new TypeError('sensitive capture control has no source location');
    if (element.attrs.some((attr) => attr.name === 'value')) {
      // Regenerate this start tag so duplicate raw value attributes cannot retain a secret.
      const attributes = element.attrs.map((attr) => ` ${attr.prefix ? `${attr.prefix}:` : ''}${attr.name}="${escapeHtml(attr.name === 'value' ? marker : attr.value)}"`).join('');
      patches.push({ start: location.startTag.startOffset, end: location.startTag.endOffset, text: `<${element.tagName}${attributes}>` });
    }
    if (contents) patches.push({ start: location.startTag.endOffset, end: location.endTag?.startOffset ?? location.endOffset, text: marker });
    controls++;
  };
  const redactOptions = (element: Element) => {
    for (const child of element.childNodes) {
      if (!('tagName' in child)) continue;
      if (child.tagName === 'option') redactElement(child, true); else redactOptions(child);
    }
  };
  for (const element of elements) {
    const named = sensitive.has(attribute(element, 'name') ?? '');
    if (element.tagName === 'input' && (named || attribute(element, 'type')?.toLowerCase() === 'password')) redactElement(element, false);
    else if (named && ['textarea', 'button', 'output'].includes(element.tagName)) redactElement(element, true);
    else if (element.tagName === 'select' && named || element.tagName === 'datalist' && lists.has(attribute(element, 'id') ?? '')) redactOptions(element);
  }
  patches.sort((left, right) => left.start - right.start || right.end - left.end);
  let offset = 0; const chunks: string[] = [];
  for (const patch of patches) {
    if (patch.start < offset) continue; // An enclosing redacted text region already removes this patch.
    chunks.push(html.slice(offset, patch.start), patch.text); offset = patch.end;
  }
  chunks.push(html.slice(offset));
  return Object.freeze({ html: chunks.join(''), fields: names, controls });
}

type Renderer = (selection: FrameworkCaptureSelection, context: FrameworkCaptureContext) => string | Response | Promise<string | Response>;

async function collectFrameworkHtml(framework: FrameworkRenderedCollection['framework'], options: FrameworkCaptureOptions, render: Renderer): Promise<FrameworkRenderedCollection> {
  const fields = redactionNames(options.redactFields);
  const maxBytes = options.maxBytes ?? defaults.maxBytes;
  const maxTotalBytes = options.maxTotalBytes ?? defaults.maxTotalBytes;
  const selections = options.selections.map((selection) => {
    const expectedStatus = selection.expectedStatus ?? 200;
    if (!Number.isSafeInteger(expectedStatus) || expectedStatus < 200 || expectedStatus > 499) throw new TypeError('capture expectedStatus must be between 200 and 499');
    return Object.freeze({ ...selection, expectedStatus });
  });
  const byId = new Map(selections.map((selection) => [selection.id, selection]));
  const collection = await collectRenderedHtml({ ...options, selections,
    render: async (selection, { signal }) => {
      const selected = byId.get(selection.id)!;
      const request = new Request(selection.url, { method: 'GET', headers: { Accept: 'text/html' }, signal });
      const rendered = await render(selected, Object.freeze({ request, signal }));
      if (typeof rendered === 'string') {
        if (selected.expectedStatus !== 200) throw new TypeError('non-200 selected states require a Response with the declared status');
        return rendered;
      }
      if (!(rendered instanceof Response) || rendered.status !== selected.expectedStatus) {
        if (rendered instanceof Response) void rendered.body?.cancel().catch(() => undefined);
        throw new TypeError(`capture did not return declared HTTP ${selected.expectedStatus}`);
      }
      if (rendered.url !== '' && new URL(rendered.url).origin !== new URL(selection.url).origin) {
        void rendered.body?.cancel().catch(() => undefined);
        throw new TypeError('capture response origin changed');
      }
      // Keep the bounded collector's content-type/body checks, while accepting one declared 422 state.
      return rendered.status === 200 ? rendered : new Response(rendered.body, { status: 200, headers: rendered.headers });
    },
  });
  let totalBytes = 0; let controls = 0;
  const snapshots = collection.snapshots.map((snapshot) => {
    const redacted = redactCapturedHtml(snapshot.html, fields);
    const size = Buffer.byteLength(redacted.html); totalBytes += size; controls += redacted.controls;
    if (size > maxBytes || totalBytes > maxTotalBytes) throw new RangeError('redacted capture exceeds byte limits');
    const url = new URL(snapshot.document.documentUrl);
    for (const field of fields) if (url.searchParams.has(field)) url.searchParams.set(field, marker);
    return Object.freeze({ ...snapshot, html: redacted.html, sha256: sourceSha256(Buffer.from(redacted.html)),
      document: Object.freeze({ ...snapshot.document, documentUrl: url.href, sourceKind: 'redacted-snapshot',
        executionAssumption: `${snapshot.document.executionAssumption}; framework:${framework}; original-http-status:${byId.get(snapshot.id)!.expectedStatus}; redacted-fields:${JSON.stringify(fields)}; value-dependent-constraints-not-evaluated`,
      }),
    });
  });
  return Object.freeze({ ...collection, framework, snapshots: Object.freeze(snapshots), redaction: Object.freeze({ mode: 'control-values', fields, controls }) });
}

/** Host calls its already initialized Hono app; TypeHTML starts no server or application import. */
export function collectHonoHtml(options: FrameworkCaptureOptions & Readonly<{
  request: (request: Request, selection: FrameworkCaptureSelection, context: FrameworkCaptureContext) => Response | Promise<Response>;
}>): Promise<FrameworkRenderedCollection> {
  const request = options.request;
  return collectFrameworkHtml('hono', options, (selection, context) => Reflect.apply(request, options, [context.request, selection, context]));
}

/** Host owns the Astro component/container and selected props. */
export function collectAstroHtml(options: FrameworkCaptureOptions & Readonly<{ render: Renderer }>): Promise<FrameworkRenderedCollection> {
  const render = options.render;
  return collectFrameworkHtml('astro', options, (selection, context) => Reflect.apply(render, options, [selection, context]));
}

/** Host owns the SvelteKit Server/respond callback and request platform context. */
export function collectSvelteKitHtml(options: FrameworkCaptureOptions & Readonly<{
  respond: (request: Request, selection: FrameworkCaptureSelection, context: FrameworkCaptureContext) => Response | Promise<Response>;
}>): Promise<FrameworkRenderedCollection> {
  const respond = options.respond;
  return collectFrameworkHtml('sveltekit', options, (selection, context) => Reflect.apply(respond, options, [context.request, selection, context]));
}
