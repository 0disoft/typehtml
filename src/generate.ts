import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile, lstat, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, basename, isAbsolute, sep } from 'node:path';
import { generateContractArtifacts } from './contract/generate.ts';
import { loadBoundaryContract } from './contract/load.ts';

export type GenerateOptions = Readonly<{ contractPath: string; outDir: string; rootDir?: string; check?: boolean }>;
export type GenerationResult = Readonly<{
  format: 'boundary-generation/1';
  status: 'current' | 'stale' | 'written';
  files: readonly string[];
}>;

const FILES = ['order-contract.ts', 'form-check.generated.json', 'start-form-check.generated.json', 'contract-digests.generated.json'] as const;

/** Replace only a dedicated generated directory, preserving unrelated files by refusing mixed output. */
export async function generateFiles(options: GenerateOptions): Promise<GenerationResult> {
  const sourcePath = await realpath(resolve(options.contractPath));
  const outDir = resolve(options.outDir);
  const designDir = resolve(import.meta.dir, '../docs/design');
  const designRelative = relative(designDir, outDir);
  if (isContained(designRelative)) {
    throw new Error('design snapshots are immutable; choose a generated output directory');
  }
  const sourceRelative = relative(outDir, sourcePath);
  if (isContained(sourceRelative)) {
    throw new Error('the authoritative source must be outside the generated output directory');
  }
  const rootDir = await realpath(resolve(options.rootDir ?? process.cwd()));
  const sourceFromRoot = relative(rootDir, sourcePath);
  if (!isContained(sourceFromRoot)) throw new Error('authoritative source is outside --root');
  const loaded = await loadBoundaryContract(sourcePath);
  const artifacts = generateContractArtifacts(loaded, {
    sourcePath: sourceFromRoot.replaceAll('\\', '/'), sourceSha256: loaded.sourceSha256,
  });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const content = [artifacts.types, json(artifacts.formCheck), json(artifacts.startFormCheck), json(artifacts.digests)];
  const stale: string[] = [];
  for (const [index, file] of FILES.entries()) {
    try {
      if (await readFile(resolve(outDir, file), 'utf8') !== content[index]) stale.push(file);
    } catch (error) {
      if (!isMissing(error)) throw error;
      stale.push(file);
    }
  }
  if (options.check) return { format: 'boundary-generation/1', status: stale.length === 0 ? 'current' : 'stale', files: stale };
  if (stale.length === 0) return { format: 'boundary-generation/1', status: 'current', files: [] };

  await mkdir(dirname(outDir), { recursive: true });
  // Resolve the parent so an output symlink cannot redirect replacement into the design snapshot.
  const actualParent = await realpath(dirname(outDir));
  const actualOut = resolve(actualParent, basename(outDir));
  if (isContained(relative(actualOut, sourcePath))) {
    throw new Error('the authoritative source resolves inside the generated output directory');
  }
  const actualRelative = relative(await realpath(designDir), actualOut);
  if (isContained(actualRelative)) {
    throw new Error('generated output resolves into an immutable design snapshot');
  }
  let exists = true;
  try {
    if (!(await lstat(outDir)).isDirectory() || (await lstat(outDir)).isSymbolicLink()) {
      throw new Error('generated output must be a dedicated real directory');
    }
    const entries = await readdir(outDir, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || !(FILES as readonly string[]).includes(entry.name))) {
      throw new Error('generated output contains unrelated files; choose a dedicated directory');
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    exists = false;
  }
  const stage = resolve(actualParent, `.typehtml-generate-${crypto.randomUUID()}`);
  const backup = resolve(actualParent, `.typehtml-backup-${crypto.randomUUID()}`);
  await mkdir(stage);
  let backedUp = false;
  try {
    for (const [index, file] of FILES.entries()) await writeFile(resolve(stage, file), content[index]!);
    if ((await loadBoundaryContract(sourcePath)).sourceSha256 !== loaded.sourceSha256) {
      throw new Error('authoritative contract changed during generation; retry');
    }
    if (exists) { await rename(outDir, backup); backedUp = true; }
    try {
      await rename(stage, outDir);
    } catch (error) {
      if (backedUp) { await rename(backup, outDir); backedUp = false; }
      throw error;
    }
    if (backedUp) await removeGeneratedDirectory(backup);
    return { format: 'boundary-generation/1', status: 'written', files: [...FILES] };
  } finally {
    await removeGeneratedDirectory(stage);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isContained(relativePath: string): boolean {
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

async function removeGeneratedDirectory(path: string): Promise<void> {
  for (const file of FILES) await rm(resolve(path, file), { force: true });
  try { await rmdir(path); } catch (error) { if (!isMissing(error)) throw error; }
}
