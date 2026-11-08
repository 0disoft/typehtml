import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject, type PackageManager } from '../src/init.ts';

const args = process.argv.slice(2);
if (args.includes('--help') || args.length === 0) {
  console.log('node create-typehtml.mjs <directory> [--package-manager bun|npm]');
} else {
  try {
    const directory = args.shift()!;
    let packageManager: PackageManager = 'npm';
    if (args.length !== 0) {
      if (args.length !== 2 || args[0] !== '--package-manager' || !['bun', 'npm'].includes(args[1]!)) throw new TypeError('expected --package-manager bun|npm');
      packageManager = args[1] as PackageManager;
    }
    if (directory.startsWith('-')) throw new TypeError('expected a target directory');
    const packageSource = resolve(dirname(fileURLToPath(import.meta.url)), 'typehtml.tgz');
    console.log(JSON.stringify(await initProject({ directory, packageManager, packageSource }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
