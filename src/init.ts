import { mkdir, mkdtemp, open, readdir, rename, rm, rmdir, writeFile, lstat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { VERSION } from './version.ts';

export type PackageManager = 'bun' | 'npm';
export type InitOptions = Readonly<{ directory: string; packageManager?: PackageManager; packageSource?: string }>;
export type InitResult = Readonly<{
  format: 'typehtml-init/1';
  status: 'created';
  directory: string;
  files: readonly string[];
  runtime: 'Bun >=1.4.0';
  packageManager: PackageManager;
  nextCommands: readonly (readonly string[])[];
}>;

const VENDORED_PACKAGE = 'vendor/typehtml.tgz';
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

/** Create a standalone local example without installing dependencies or starting a server. */
export async function initProject(options: InitOptions): Promise<InitResult> {
  const directory = resolve(options.directory);
  const parent = dirname(directory);
  if (directory === parent) throw new Error('the filesystem root cannot be a starter directory');
  const packageManager = options.packageManager ?? 'bun';
  if (packageManager !== 'bun' && packageManager !== 'npm') throw new Error('package manager must be bun or npm');
  let existed = false;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('starter target must be a real directory');
    if ((await readdir(directory)).length !== 0) throw new Error('starter target is not empty; no files were changed');
    existed = true;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const archive = options.packageSource === undefined ? undefined : await readPackageSource(options.packageSource);
  const files: Readonly<Record<string, string | Uint8Array>> = {
    ...starterFiles(directory, packageManager, archive !== undefined),
    ...(archive === undefined ? {} : { [VENDORED_PACKAGE]: archive }),
  };
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(resolve(parent, '.typehtml-init-'));
  let removedEmptyTarget = false;
  try {
    for (const [name, contents] of Object.entries(files)) {
      const file = resolve(stage, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents, { flag: 'wx' });
    }
    if (existed) {
      // rmdir refuses a target populated while the starter was being prepared.
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('starter target changed while preparing files');
      await rmdir(directory);
      removedEmptyTarget = true;
    }
    try {
      await rename(stage, directory);
    } catch (error) {
      if (removedEmptyTarget) await mkdir(directory).catch(() => undefined);
      throw error;
    }
  } finally {
    // stage was created exclusively above; the user target is never recursively removed.
    await rm(stage, { recursive: true, force: true });
  }
  return {
    format: 'typehtml-init/1', status: 'created', directory, files: Object.keys(files),
    runtime: 'Bun >=1.4.0', packageManager,
    nextCommands: [[packageManager, 'install'], [packageManager, 'run', 'generate'], [packageManager, 'run', 'doctor'], [packageManager, 'run', 'dev']],
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Copy bytes only: npm/Bun validates the package manifest when the user installs it. */
async function readPackageSource(source: string): Promise<Uint8Array> {
  if (typeof source !== 'string' || source.trim() === '' || /[\u0000-\u001f]/u.test(source) || !/\.tgz$/iu.test(source)) {
    throw new TypeError('package source must be a local .tgz file path');
  }
  const file = await open(resolve(source), 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new TypeError('package source must be a regular file');
    if (info.size < 2 || info.size > MAX_PACKAGE_BYTES) throw new RangeError('package source must contain 2 bytes through 64 MiB');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error('package source changed while it was being read');
      offset += bytesRead;
    }
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new TypeError('package source must be a gzip-compressed .tgz file');
    const { bytesRead } = await file.read(Buffer.alloc(1), 0, 1, bytes.length);
    if (bytesRead !== 0) throw new Error('package source changed while it was being read');
    return bytes;
  } finally {
    await file.close();
  }
}

function starterFiles(directory: string, packageManager: PackageManager, vendored = false): Readonly<Record<string, string>> {
  const name = basename(directory).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '') || 'typehtml-app';
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const generate = 'typehtml generate --form form.json --out-dir generated --root .';
  return {
    'package.json': json({ name, version: '0.0.0', private: true, type: 'module', engines: { bun: '>=1.4.0' }, scripts: {
      dev: 'bun run generate && bun server.ts', start: 'bun run generate && bun server.ts', generate, 'generate:check': `${generate} --check`, doctor: 'typehtml doctor --config doctor.config.json',
    }, dependencies: { '@0disoft/typehtml': vendored ? `file:./${VENDORED_PACKAGE}` : `^${VERSION}` } }),
    'form.json': json({ format: 'typehtml-form/1', id: 'greeting.create', path: '/greet', input: {
      type: 'object', additionalProperties: false, required: ['name', 'quantity'], properties: {
        name: { type: 'string', minLength: 1, maxLength: 80 }, quantity: { type: 'integer', minimum: 1, maximum: 20 },
      },
    }, output: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string', minLength: 1, maxLength: 200 } } } }),
    'doctor.config.json': json({ format: 'boundary-doctor/0.5-draft', root: '.', inputs: [{ kind: 'form-projection', path: 'generated/form-check.generated.json' }], documents: [{
      path: 'index.html', documentUrl: 'http://127.0.0.1:3000/', sourceKind: 'template-snapshot', executionAssumption: 'native-no-script-by-example', bindings: [{
        formId: 'greeting', actionId: 'greeting.create', required: true, submitterPolicy: 'enumerate-native', constraintMismatchSeverity: 'warning',
      }],
    }] }),
    'index.html': INDEX_HTML,
    'server.ts': SERVER_TS,
    '.gitignore': 'node_modules/\n.env\n.env.*\n.DS_Store\n',
    'README.md': `# ${name}\n\nA native HTML form using TypeHTML. Bun 1.4+ runs the server; ${packageManager} installs dependencies and runs the scripts.\n\n\`\`\`sh\n${packageManager} install\n${packageManager} run generate\n${packageManager} run doctor\n${packageManager} run dev\n\`\`\`\n\nOpen http://127.0.0.1:3000/. Set PORT and ALLOWED_ORIGIN together when changing the local address.\n\nEdit form.json as the single source of input/output constraints. Run generate after schema changes, and generate:check to detect stale artifacts. Doctor compares index.html with the generated form projection; it does not test authentication or database behavior.\n\nThe local example uses anonymous in-memory sessions and synchronizer CSRF tokens. It has no user accounts, persistent storage, transaction coordinator, or idempotency protection. Connect real application ports before handling durable writes. The server binds to 127.0.0.1.\n`,
  };
}

const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TypeHTML starter</title></head>
<body><main><h1>TypeHTML starter</h1>
<p>A native HTML form with server-side contract validation.</p>
{{summary}}
<form id="greeting" method="post" action="/greet" enctype="application/x-www-form-urlencoded" accept-charset="UTF-8">
<input type="hidden" name="_bc_csrf" value="{{csrf}}">
<p><label for="name">Name</label><input id="name" name="name" required maxlength="80" value="{{name}}" aria-describedby="name-error"></p>
<p id="name-error">{{name-error}}</p>
<p><label for="quantity">Quantity</label><input id="quantity" name="quantity" type="text" inputmode="numeric" pattern="([1-9]|1[0-9]|20)" maxlength="2" required value="{{quantity}}" aria-describedby="quantity-hint quantity-error"></p>
<p id="quantity-hint">Enter an integer from 1 to 20.</p><p id="quantity-error">{{quantity-error}}</p>
<button type="submit">Send greeting</button>
</form></main></body></html>
`;

const SERVER_TS = `import { readFile } from 'node:fs/promises';
import { createFormHandler } from '@0disoft/typehtml';
import { form } from './generated/form-definition.ts';

const template = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const port = Number(process.env.PORT ?? 3000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const origin = process.env.ALLOWED_ORIGIN ?? 'http://127.0.0.1:' + port;
type Session = { id: string; csrfToken: string; expiresAt: number };
const sessions = new Map<string, Session>();

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function sessionFor(request: Request): Session | null {
  const id = request.headers.get('cookie')?.match(/(?:^|;\\s*)typehtml_session=([^;]+)/)?.[1];
  if (id === undefined) return null;
  const session = sessions.get(id);
  if (session === undefined || session.expiresAt <= Date.now()) { sessions.delete(id); return null; }
  return session;
}
function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  } });
}
function render(csrfToken: string, raw: Readonly<Record<string, string>> = {}, issues: readonly { field: string | null; message: string }[] = []): string {
  const values: Record<string, string> = {
    csrf: escape(csrfToken), name: escape(raw.name ?? ''), quantity: escape(raw.quantity ?? '2'),
    summary: issues.length === 0 ? '' : '<section role="alert"><h2>Please check your input</h2><ul>' + issues.map((issue) => '<li>' + escape(issue.message) + '</li>').join('') + '</ul></section>',
    'name-error': issues.filter((issue) => issue.field === 'name').map((issue) => escape(issue.message)).join(', '),
    'quantity-error': issues.filter((issue) => issue.field === 'quantity').map((issue) => escape(issue.message)).join(', '),
  };
  return template.replace(/\\{\\{([a-z-]+)\\}\\}/g, (_match, key: string) => values[key] ?? '');
}

const submit = createFormHandler(form, {
  allowedOrigins: [origin],
  authenticate: (request) => sessionFor(request),
  csrfToken: ({ principal }) => principal.csrfToken,
  authorize: () => true, // This local example is an anonymous public form, not user authentication.
  execute: ({ input }) => ({ message: 'Hello ' + input.name + '! Quantity: ' + input.quantity, internal: 'not public' }),
  project: (result) => ({ message: result.message }),
  success: (output) => ({ location: '/thanks?message=' + encodeURIComponent(output.message) }),
  invalid: ({ rawValues, issues, csrfToken }) => render(csrfToken, rawValues, issues),
});

const server = Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/') {
    let session = sessionFor(request);
    if (session === null) {
      for (const [id, existing] of sessions) if (existing.expiresAt <= Date.now()) sessions.delete(id);
      if (sessions.size >= 1024) return html('<h1>Please try again later</h1>', 503);
      session = { id: crypto.randomUUID(), csrfToken: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'), expiresAt: Date.now() + 3_600_000 };
      sessions.set(session.id, session);
    }
    const response = html(render(session.csrfToken));
    response.headers.set('Set-Cookie', 'typehtml_session=' + session.id + '; Path=/; HttpOnly; SameSite=Strict' + (new URL(origin).protocol === 'https:' ? '; Secure' : ''));
    return response;
  }
  if (url.pathname === form.path) return submit(request);
  if (request.method === 'GET' && url.pathname === '/thanks') {
    if (sessionFor(request) === null) return html('<h1>Session expired</h1>', 401);
    const message = (url.searchParams.get('message') ?? '').slice(0, 200);
    return html('<!doctype html><html lang="en"><meta charset="utf-8"><title>Greeting sent</title><main><h1>' + escape(message) + '</h1><a href="/">Start again</a></main></html>');
  }
  return html('<h1>Not found</h1>', 404);
} });
console.log('TypeHTML starter: ' + origin);
const shutdown = () => { server.stop(true); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
`;
