import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, '.typehtml', `build-${crypto.randomUUID()}`);
const dist = join(root, 'dist');
const backup = join(root, '.typehtml', `dist-${crypto.randomUUID()}`);
function assertBuildPath(path: string): void {
  const rel = relative(root, resolve(path));
  if (rel !== 'dist' && !rel.startsWith(`.typehtml${sep}build-`) && !rel.startsWith(`.typehtml${sep}dist-`)) {
    throw new Error('build output escaped the dedicated workspace directories');
  }
}
for (const path of [stage, dist, backup]) assertBuildPath(path);
await mkdir(stage, { recursive: true });
try {
  const result = Bun.spawnSync([process.execPath, join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.build.json'), '--outDir', stage], {
    cwd: root, stdout: 'inherit', stderr: 'inherit',
  });
  if (result.exitCode !== 0) throw new Error(`declaration/JavaScript build failed (${result.exitCode})`);
  await rewriteDeclarationTree(stage);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const { VERSION } = await import('../src/version.ts');
  if (manifest.version !== VERSION) throw new Error('package.json and CLI VERSION disagree');
  await copyFile(join(root, 'docs/design/v0.5/examples/order.boundary.json'), join(stage, 'reference/order.boundary.json'));
  await chmod(join(stage, 'cli.js'), 0o755);
  let backedUp = false;
  try { await rename(dist, backup); backedUp = true; } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  try { await rename(stage, dist); } catch (error) {
    if (backedUp) await rename(backup, dist);
    throw error;
  }
  if (backedUp) await rm(backup, { recursive: true, force: true });
  console.log(`Built ${manifest.name}@${manifest.version}: ESM JavaScript and declarations`);
} finally {
  await rm(stage, { recursive: true, force: true });
}

async function rewriteDeclarationTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await rewriteDeclarationTree(path);
    else if (entry.name.endsWith('.d.ts')) {
      const source = await readFile(path, 'utf8');
      const rewritten = rewriteDeclarationImports(source);
      if (rewritten !== source) await writeFile(path, rewritten);
    }
  }
}

/** tsc rewrites executable imports but retains .ts in declarations. Rewrite module strings only. */
function rewriteDeclarationImports(source: string): string {
  let index = 0;
  let copied = 0;
  let output = '';
  while (index < source.length) {
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    const quote = source[index];
    if (quote !== "'" && quote !== '"' && quote !== '`') { index++; continue; }
    const start = index++;
    while (index < source.length && source[index] !== quote) {
      index += source[index] === '\\' ? 2 : 1;
    }
    const value = source.slice(start + 1, index);
    const before = source.slice(Math.max(0, start - 32), start);
    if (quote !== '`' && /(?:\bfrom|\bimport\s*\()\s*$/.test(before) && /^\.{1,2}\/[^\\]*\.ts$/.test(value)) {
      output += source.slice(copied, start + 1) + value.slice(0, -3) + '.js';
      copied = index;
    }
    index++;
  }
  return output + source.slice(copied);
}
