import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath, stat } from 'node:fs/promises';

export interface DoctorSettings { doctorConfig?: unknown; cliPath?: unknown; nodePath?: unknown }
export interface LaunchPlan { root: string; command: string; args: readonly string[]; config: string; cli: string }

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f]/u.test(value)) throw new Error(`${label} must be a nonempty path without control characters.`);
  return value;
}

function workspacePath(root: string, value: unknown, label: string): string {
  const name = nonempty(value, label);
  if (isAbsolute(name)) throw new Error(`${label} must be relative to the workspace folder.`);
  const absolute = resolve(root, name);
  const offset = relative(root, absolute);
  if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error(`${label} must stay inside the workspace folder.`);
  return absolute;
}

/** Empty config and untrusted/virtual folders never resolve or launch workspace code. */
export function createLaunchPlan(root: string, trusted: boolean, scheme: string, settings: DoctorSettings): LaunchPlan | null {
  if (!trusted || scheme !== 'file' || settings.doctorConfig === undefined || settings.doctorConfig === '') return null;
  const config = workspacePath(root, settings.doctorConfig, 'typehtml.doctorConfig');
  const cli = workspacePath(root, settings.cliPath ?? 'node_modules/@0disoft/typehtml/dist/cli.js', 'typehtml.cliPath');
  const command = nonempty(settings.nodePath ?? 'node', 'typehtml.nodePath');
  return { root, command, args: Object.freeze([cli, 'lsp', '--config', config]), config, cli };
}

/** Resolve filesystem links before executing code or opening the configured input. */
export async function validateLaunchFiles(plan: LaunchPlan): Promise<LaunchPlan> {
  const [root, cli, config] = await Promise.all([realpath(plan.root), realpath(plan.cli), realpath(plan.config)]);
  for (const file of [cli, config]) {
    const offset = relative(root, file);
    if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error('TypeHTML CLI and configuration must resolve inside the workspace folder, including filesystem links.');
    if (!(await stat(file)).isFile()) throw new Error(`Expected a file: ${file}`);
  }
  return { ...plan, root, cli, config, args: Object.freeze([cli, 'lsp', '--config', config]) };
}
