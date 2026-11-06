import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDoctor } from './analyze.ts';
import { loadDoctorConfig } from './config.ts';
import { VERSION } from '../version.ts';

const MAX_MESSAGE_BYTES = 1024 * 1024;
interface RpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
/** Minimal stdio contract keeps Node type packages optional for other Doctor consumers. */
export interface DoctorLspOutput {
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): unknown;
}

/** Persisted-snapshot diagnostics over stdio. Does not analyze unsaved JSX, execute app code, or discover routes. */
export async function runDoctorLanguageServer(configPath: string, input: AsyncIterable<Uint8Array | string>, output: DoctorLspOutput): Promise<void> {
  let buffer = Buffer.alloc(0);
  let shutdown = false;
  let exited = false;
  let lastUris = new Set<string>();
  const send = async (message: unknown) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message as object }));
    const packet = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
    await new Promise<void>((resolve, reject) => output.write(packet, (error) => error ? reject(error) : resolve()));
  };
  const publish = async () => {
    const report = await runDoctor(configPath);
    let root = process.cwd();
    const byUri = new Map<string, unknown[]>();
    try {
      const loaded = await loadDoctorConfig(configPath);
      root = loaded.baseDir;
      for (const document of loaded.config.documents) byUri.set(pathToFileURL(resolve(root, document.path)).href, []);
    } catch { /* The configuration diagnostic is published below. */ }
    for (const finding of report.findings) {
      const at = finding.evidenceRef;
      const uri = pathToFileURL(at === null ? resolve(configPath) : resolve(root, at.path)).href;
      const list = byUri.get(uri) ?? [];
      const line = Math.max(0, (at?.line ?? 1) - 1);
      const character = Math.max(0, (at?.column ?? 1) - 1);
      list.push({ range: { start: { line, character }, end: { line, character: character + 1 } },
        severity: finding.severity === 'error' ? 1 : finding.severity === 'warning' ? 2 : 3,
        code: finding.ruleId, source: 'TypeHTML', message: `[${finding.analysisStatus}] ${finding.note}`,
        data: { analysisStatus: finding.analysisStatus, certainty: finding.certainty, applicationCompleteness: 'not-evaluated' } });
      byUri.set(uri, list);
    }
    if (report.error || report.analysisTruncated || report.findingsTruncated) {
      const uri = pathToFileURL(resolve(configPath)).href;
      const list = byUri.get(uri) ?? [];
      list.push({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: report.error ? 1 : 2, source: 'TypeHTML', message: report.error ?? 'Analysis is incomplete because a resource limit was reached.' });
      byUri.set(uri, list);
    }
    for (const uri of lastUris) if (!byUri.has(uri)) byUri.set(uri, []);
    for (const [uri, diagnostics] of byUri) await send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
    lastUris = new Set(byUri.keys());
  };
  const handle = async (message: RpcMessage) => {
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      await send({ id: message.id ?? null, error: { code: -32600, message: 'Invalid Request' } }); return;
    }
    if (message.method === 'exit') { exited = true; return; }
    if (message.method === 'shutdown') { shutdown = true; await send({ id: message.id ?? null, result: null }); return; }
    if (shutdown) { if (message.id !== undefined) await send({ id: message.id, error: { code: -32600, message: 'Server is shut down' } }); return; }
    if (message.method === 'initialize') {
      await send({ id: message.id ?? null, result: { capabilities: { positionEncoding: 'utf-16', textDocumentSync: { openClose: true, change: 0, save: { includeText: false } } }, serverInfo: { name: 'TypeHTML persisted-snapshot Doctor', version: VERSION } } });
      return;
    }
    if (['initialized', 'textDocument/didOpen', 'textDocument/didSave', 'workspace/didChangeConfiguration'].includes(message.method)) { await publish(); return; }
    if (message.id !== undefined) await send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  };
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    while (!exited) {
      const split = buffer.indexOf('\r\n\r\n');
      if (split < 0) { if (buffer.length > 8192) throw new RangeError('LSP header exceeds bounds'); break; }
      if (split > 8192) throw new RangeError('LSP header exceeds bounds');
      const lengths = [...buffer.subarray(0, split).toString('ascii').matchAll(/^Content-Length:\s*([0-9]+)\s*$/gim)];
      if (lengths.length !== 1) throw new TypeError('LSP requires one Content-Length header');
      const length = Number(lengths[0]![1]);
      if (!Number.isSafeInteger(length) || length < 1 || length > MAX_MESSAGE_BYTES) throw new RangeError('LSP message exceeds bounds');
      if (buffer.length < split + 4 + length) break;
      const body = buffer.subarray(split + 4, split + 4 + length);
      buffer = buffer.subarray(split + 4 + length);
      let message: unknown;
      try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
      catch { await send({ id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      if (message === null || typeof message !== 'object' || Array.isArray(message)) { await send({ id: null, error: { code: -32600, message: 'Invalid Request' } }); continue; }
      await handle(message as RpcMessage);
    }
    if (exited) return;
  }
  if (buffer.length !== 0) throw new TypeError('incomplete LSP frame');
}
