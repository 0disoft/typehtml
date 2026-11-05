import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile, lstat, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, basename, isAbsolute, sep } from 'node:path';
import { createArtifactBundle } from './generate-artifacts.ts';
import { readBoundedJsonBytes } from './contract/strict-json.ts';
import { sourceSha256 } from './contract/behavior.ts';

export type GenerateOptions = Readonly<{ contractPath: string; outDir: string; rootDir?: string; check?: boolean }>;
export type GenerationResult = Readonly<{
  format: 'boundary-generation/1';
  status: 'current' | 'stale' | 'written';
  files: readonly string[];
}>;

const FILES = ['order-contract.ts', 'form-types.ts', 'form-definition.ts', 'form-check.generated.json', 'start-form-check.generated.json', 'contract-digests.generated.json'] as const;

/** Replace only a dedicated generated directory, preserving unrelated files by refusing mixed output. */
export async function generateFiles(options: GenerateOptions): Promise<GenerationResult> {
  const sourcePath = await realpath(resolve(options.contractPath));
  const outDir = resolve(options.outDir);
  const rootDir = await realpath(resolve(options.rootDir ?? process.cwd()));
  const designDir = resolve(rootDir, 'docs/design');
  const designRelative = relative(designDir, outDir);
  if (isContained(designRelative)) {
    throw new Error('design snapshots are immutable; choose a generated output directory');
  }
  const sourceRelative = relative(outDir, sourcePath);
  if (isContained(sourceRelative)) {
    throw new Error('the authoritative source must be outside the generated output directory');
  }
  const sourceFromRoot = relative(rootDir, sourcePath);
  if (!isContained(sourceFromRoot)) throw new Error('authoritative source is outside --root');
  const artifacts = await createArtifactBundle(sourcePath, sourceFromRoot.replaceAll('\\', '/'));
  const stale: string[] = [];
  for (const [file, content] of artifacts.files) {
    try {
      if (await readFile(resolve(outDir, file), 'utf8') !== content) stale.push(file);
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
  let actualDesign = designDir;
  try { actualDesign = await realpath(designDir); } catch (error) { if (!isMissing(error)) throw error; }
  const actualRelative = relative(actualDesign, actualOut);
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
    for (const [file, content] of artifacts.files) await writeFile(resolve(stage, file), content);
    if (sourceSha256(await readBoundedJsonBytes(sourcePath)) !== artifacts.sourceSha256) {
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
    return { format: 'boundary-generation/1', status: 'written', files: [...artifacts.files.keys()] };
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
