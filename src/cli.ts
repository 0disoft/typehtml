#!/usr/bin/env node
import { runDoctor, configErrorReport } from './doctor/analyze.ts';
import { VERSION } from './version.ts';
import { formatDoctorReport, type DoctorOutputFormat } from './doctor/format.ts';

const HELP = `TypeHTML ${VERSION}

Usage:
  typehtml init <directory> [--runtime bun|node] [--package-manager bun|npm] [--package-source <local.tgz>]
  typehtml doctor --config <file> [--format json|text|sarif] [--watch]
  typehtml capture --config <file> --out-dir <new-directory>
  typehtml catalog --config <file> --out-dir <new-directory>
  typehtml lsp --config <file>
  typehtml generate --form <file> --out-dir <directory> [--root <directory>] [--check]
  typehtml generate --contract <file> --out-dir <directory> [--root <directory>] [--check]
  typehtml --help
  typehtml --version

The CLI runs on Node.js 22+ or Bun 1.4+. The generated starter server requires Bun 1.4+.
init writes files only; it does not install dependencies or start a server.
`;

function usage(): never {
  const report = configErrorReport('<cli>', 'usage: typehtml init <directory> [--runtime bun|node] [--package-manager bun|npm] [--package-source <local.tgz>] | typehtml doctor --config <file> | typehtml generate --form <file> --out-dir <directory> [--root <directory>] [--check]');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) {
    process.stdout.write(HELP);
    return;
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0]!)) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args[0] === 'catalog') {
    const values = new Map<string, string>();
    for (let index = 1; index < args.length; index++) {
      const flag = args[index]!;
      const value = args[++index];
      if (!['--config', '--out-dir'].includes(flag) || values.has(flag) || value === undefined || value.startsWith('--')) usage();
      values.set(flag, value);
    }
    if (!values.has('--config') || !values.has('--out-dir')) usage();
    try {
      const { writeFormCatalog } = await import('./catalog/files.ts');
      process.stdout.write(`${JSON.stringify(await writeFormCatalog({ configPath: values.get('--config')!, directory: values.get('--out-dir')! }))}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ format: 'typehtml-catalog/1', status: 'error', message: error instanceof Error ? error.message : 'catalog failed' })}\n`);
      process.exitCode = 2;
    }
    return;
  }
  if (args[0] === 'capture') {
    let configPath: string | undefined;
    let directory: string | undefined;
    const seen = new Set<string>();
    for (let index = 1; index < args.length; index++) {
      const flag = args[index]!;
      if (seen.has(flag)) usage();
      seen.add(flag);
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) usage();
      if (flag === '--config') configPath = value;
      else if (flag === '--out-dir') directory = value;
      else usage();
    }
    if (configPath === undefined || directory === undefined) usage();
    try {
      const { readStrictJson } = await import('./contract/strict-json.ts');
      const { collectRenderedHtml, writeRenderedCollection } = await import('./doctor/capture.ts');
      const { dirname, resolve } = await import('node:path');
      const value = await readStrictJson(configPath);
      if (value === null || typeof value !== 'object' || Array.isArray(value) || value.format !== 'typehtml-capture/1') throw new TypeError('unsupported capture config');
      const allowed = new Set(['format', 'root', 'inputs', 'selections', 'allowedOrigins', 'timeoutMs', 'concurrency', 'maxBytes', 'maxTotalBytes', 'maxSnapshots']);
      for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`unknown capture option: ${key}`);
      const { format: _, root: configuredRoot, inputs, ...capture } = value;
      if (configuredRoot !== undefined && typeof configuredRoot !== 'string') throw new TypeError('capture root must be a path');
      if (!Array.isArray(inputs) || inputs.some((input) => input === null || typeof input !== 'object' || Array.isArray(input) || input.kind !== 'form-projection' || typeof input.path !== 'string')) throw new TypeError('capture inputs must be form projections');
      const root = resolve(configuredRoot ?? dirname(resolve(configPath)));
      const collection = await collectRenderedHtml(capture as unknown as Parameters<typeof collectRenderedHtml>[0]);
      const result = await writeRenderedCollection(collection, { directory, root, inputs: inputs as unknown as Parameters<typeof writeRenderedCollection>[1]['inputs'] });
      process.stdout.write(`${JSON.stringify({ format: collection.format, configPath: result.configPath, snapshots: collection.snapshots.length, applicationCompleteness: 'not-evaluated' })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ format: 'typehtml-rendered-snapshots/1', status: 'error', message: error instanceof Error ? error.message : 'capture failed' })}\n`);
      process.exitCode = 2;
    }
    return;
  }
  if (args[0] === 'init') {
    let directory: string | undefined;
    let packageManager: 'bun' | 'npm' = 'bun';
    let runtime: 'bun' | 'node' = 'bun';
    let packageSource: string | undefined;
    let selectedManager = false;
    let selectedRuntime = false;
    for (let index = 1; index < args.length; index++) {
      const argument = args[index]!;
      if (argument === '--runtime') {
        if (selectedRuntime) usage();
        selectedRuntime = true;
        const value = args[++index];
        if (value !== 'bun' && value !== 'node') usage();
        runtime = value;
      } else if (argument === '--package-manager') {
        if (selectedManager) usage();
        selectedManager = true;
        const value = args[++index];
        if (value !== 'bun' && value !== 'npm') usage();
        packageManager = value;
      } else if (argument === '--package-source') {
        if (packageSource !== undefined) usage();
        const value = args[++index];
        if (value === undefined || value === '' || value.startsWith('--')) usage();
        packageSource = value;
      } else if (argument.startsWith('-') || directory !== undefined) {
        usage();
      } else {
        directory = argument;
      }
    }
    if (directory === undefined || directory === '') usage();
    try {
      const { initProject } = await import('./init.ts');
      process.stdout.write(`${JSON.stringify(await initProject({ directory, packageManager, packageSource, runtime }), null, 2)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ format: 'typehtml-init/1', status: 'error', message: error instanceof Error ? error.message : 'starter creation failed' })}\n`);
      process.exitCode = 2;
    }
    return;
  }
  if (args[0] === 'generate') {
    const { generateFiles } = await import('./generate.ts');
    let contractPath: string | undefined;
    let outDir: string | undefined;
    let rootDir: string | undefined;
    let check = false;
    const seen = new Set<string>();
    for (let index = 1; index < args.length; index++) {
      const flag = args[index]!;
      if (seen.has(flag)) usage();
      seen.add(flag);
      if (flag === '--check') { check = true; continue; }
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) usage();
      if (flag === '--contract' || flag === '--form') {
        if (contractPath !== undefined) usage();
        contractPath = value;
      }
      else if (flag === '--out-dir') outDir = value;
      else if (flag === '--root') rootDir = value;
      else usage();
    }
    if (contractPath === undefined || outDir === undefined) usage();
    try {
      const result = await generateFiles({ contractPath, outDir, rootDir, check });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.status === 'stale' ? 1 : 0;
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ format: 'boundary-generation/1', status: 'error', message: error instanceof Error ? error.message : 'generation failed' })}\n`);
      process.exitCode = 2;
    }
    return;
  }
  if (args.length === 0 || !['doctor', 'lsp'].includes(args[0]!)) usage();
  let configPath: string | null = null;
  let format: DoctorOutputFormat = 'json';
  let watch = false;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]!;
    if (seen.has(flag)) usage();
    seen.add(flag);
    if (flag === '--watch' && args[0] === 'doctor') { watch = true; continue; }
    if (flag === '--format' && args[0] === 'doctor') {
      const value = args[++index];
      if (value !== 'json' && value !== 'text' && value !== 'sarif') usage();
      format = value;
      continue;
    }
    if (args[index] === '--config') {
      if (configPath !== null) usage();
      configPath = args[index + 1] ?? null;
      if (configPath === null || configPath.startsWith('--')) usage();
      index += 1;
    } else {
      usage();
    }
  }
  if (configPath === null) usage();
  if (args[0] === 'lsp') {
    const { runDoctorLanguageServer } = await import('./doctor/lsp.ts');
    try { await runDoctorLanguageServer(configPath, process.stdin, process.stdout); }
    catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'language server failed'}\n`); process.exitCode = 2; }
    return;
  }
  if (watch) {
    const { watchDoctor } = await import('./doctor/watch.ts');
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try { await watchDoctor(configPath, { signal: controller.signal, onReport: (report) => {
      process.stdout.write(formatDoctorReport(report, format));
      process.exitCode = report.exitCode;
    } }); }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    return;
  }
  const report = await runDoctor(configPath);
  process.stdout.write(formatDoctorReport(report, format));
  process.exit(report.exitCode);
}

await main();
