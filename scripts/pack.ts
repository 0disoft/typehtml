import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, 'artifacts'), { recursive: true });
const result = Bun.spawnSync([process.execPath, 'pm', 'pack', '--ignore-scripts', '--quiet', '--destination', join(root, 'artifacts')], {
  cwd: root, stdout: 'inherit', stderr: 'inherit',
});
process.exitCode = result.exitCode;
