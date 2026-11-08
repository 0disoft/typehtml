import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject, type PackageManager } from '../src/init.ts';

const args = process.argv.slice(2);
if (args.includes('--help') || args.length === 0) {
  console.log('node create-typehtml.mjs <directory> [--package-manager bun|npm] [--runtime node|bun]');
} else {
  try {
    const directory = args.shift()!;
    let packageManager: PackageManager = 'npm';
    let runtime: 'node' | 'bun' = 'node';
    const seen = new Set<string>();
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index]!;
      const value = args[index + 1];
      if (seen.has(flag)) throw new TypeError(`duplicate option: ${flag}`);
      seen.add(flag);
      if (flag === '--package-manager' && (value === 'bun' || value === 'npm')) packageManager = value;
      else if (flag === '--runtime' && (value === 'bun' || value === 'node')) runtime = value;
      else throw new TypeError('expected --package-manager bun|npm or --runtime node|bun');
    }
    if (directory.startsWith('-')) throw new TypeError('expected a target directory');
    const packageSource = resolve(dirname(fileURLToPath(import.meta.url)), 'typehtml.tgz');
    console.log(JSON.stringify(await initProject({ directory, packageManager, packageSource, runtime }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
