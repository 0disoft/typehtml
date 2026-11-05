#!/usr/bin/env node
import { runDoctor, configErrorReport } from './doctor/analyze.ts';
import { VERSION } from './version.ts';

const HELP = `TypeHTML ${VERSION}

Usage:
  typehtml init <directory> [--package-manager bun|npm]
  typehtml doctor --config <file>
  typehtml generate --form <file> --out-dir <directory> [--root <directory>] [--check]
  typehtml generate --contract <file> --out-dir <directory> [--root <directory>] [--check]
  typehtml --help
  typehtml --version

The CLI runs on Node.js 22+ or Bun 1.4+. The generated starter server requires Bun 1.4+.
init writes files only; it does not install dependencies or start a server.
`;

function usage(): never {
  const report = configErrorReport('<cli>', 'usage: typehtml init <directory> [--package-manager bun|npm] | typehtml doctor --config <file> | typehtml generate --form <file> --out-dir <directory> [--root <directory>] [--check]');
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
  if (args[0] === 'init') {
    let directory: string | undefined;
    let packageManager: 'bun' | 'npm' = 'bun';
    let selectedManager = false;
    for (let index = 1; index < args.length; index++) {
      const argument = args[index]!;
      if (argument === '--package-manager') {
        if (selectedManager) usage();
        selectedManager = true;
        const value = args[++index];
        if (value !== 'bun' && value !== 'npm') usage();
        packageManager = value;
      } else if (argument.startsWith('-') || directory !== undefined) {
        usage();
      } else {
        directory = argument;
      }
    }
    if (directory === undefined || directory === '') usage();
    try {
      const { initProject } = await import('./init.ts');
      process.stdout.write(`${JSON.stringify(await initProject({ directory, packageManager }), null, 2)}\n`);
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
  if (args.length === 0 || args[0] !== 'doctor') usage();
  let configPath: string | null = null;
  for (let index = 1; index < args.length; index += 1) {
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
  const report = await runDoctor(configPath);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.exitCode);
}

await main();
