#!/usr/bin/env bun
import { runDoctor, configErrorReport } from './doctor/analyze.ts';

function usage(): never {
  const report = configErrorReport('<cli>', 'usage: boundary doctor --config <file> | boundary generate --contract <file> --out-dir <directory> [--root <directory>] [--check]');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
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
      if (flag === '--contract') contractPath = value;
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
