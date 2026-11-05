#!/usr/bin/env bun
import { runDoctor, configErrorReport } from './doctor/analyze.ts';

function usage(): never {
  const report = configErrorReport('<cli>', 'usage: boundary doctor --config <doctor.config.json>');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] !== 'doctor') usage();
  let configPath: string | null = null;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === '--config') {
      configPath = args[index + 1] ?? null;
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
