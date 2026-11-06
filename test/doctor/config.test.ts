import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { loadBoundaryContract } from '../../src/contract/load.ts';
import { projectFormCheck } from '../../src/contract/project.ts';
import type { FormCheck } from '../../src/contract/types.ts';
import { loadDoctorConfig } from '../../src/doctor/config.ts';

async function withConfig(work: (fixture: {
  directory: string;
  configPath: string;
  projection: FormCheck;
  writeConfig: (overrides?: Record<string, unknown>) => Promise<void>;
  writeProjection: (value: FormCheck) => Promise<void>;
}) => Promise<void>): Promise<void> {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'typehtml-config-'));
  try {
    const sourcePath = join(directory, 'contract.json');
    await writeFile(sourcePath, await readFile(new URL('../../docs/design/v0.5/examples/order.boundary.json', import.meta.url)));
    const loaded = await loadBoundaryContract(sourcePath);
    const projection = projectFormCheck(loaded.contract, loaded.value, { sourcePath: 'contract.json', sourceSha256: loaded.sourceSha256 });
    const configPath = join(directory, 'doctor.json');
    const config = {
      format: 'boundary-doctor/0.5-draft', root: directory,
      inputs: [{ kind: 'form-projection', path: 'form-check.json' }],
      documents: [{ path: 'form.html', documentUrl: 'https://example.test/form', sourceKind: 'snapshot', executionAssumption: 'native',
        bindings: [{ formId: 'order', actionId: loaded.contract.id }],
      }],
    };
    const writeConfig = async (overrides: Record<string, unknown> = {}) => { await writeFile(configPath, JSON.stringify({ ...config, ...overrides })); };
    const writeProjection = async (value: FormCheck) => { await writeFile(join(directory, 'form-check.json'), JSON.stringify(value)); };
    await writeConfig();
    await writeProjection(projection);
    await work({ directory, configPath, projection, writeConfig, writeProjection });
  } finally {
    const actual = await realpath(directory);
    if (dirname(actual) !== parent || !basename(actual).startsWith('typehtml-config-')) throw new Error('refusing cleanup outside config fixture');
    await rm(actual, { recursive: true, force: true });
  }
}

describe('Doctor config phases and error precedence', () => {
  it('retains normalized defaults and current-working-directory root resolution', async () => {
    await withConfig(async ({ directory, configPath, writeConfig }) => {
      await writeConfig({ root: relative(process.cwd(), directory) });
      const loaded = await loadDoctorConfig(configPath);
      expect(loaded.baseDir).toBe(resolve(directory));
      expect(loaded.config.root).toBe(relative(process.cwd(), directory));
      expect(loaded.formChecks.size).toBe(1);
      expect(loaded.sourceIssues.size).toBe(0);
      expect(loaded.config.documents[0]?.bindings[0]).toEqual({
        formId: 'order', actionId: 'orders.createDraft', required: true,
        submitterPolicy: 'enumerate-native', constraintMismatchSeverity: 'warning',
      });
      expect(loaded.config.releaseRequiresCompleteDeclaredBoundary).toBe(true);
      expect(loaded.config.releaseRequiredRuleGroups).toEqual(['binding', 'target', 'supply', 'cardinality']);
    });
  });

  it('validates input kinds before trying an unreadable root or invalid documents', async () => {
    await withConfig(async ({ directory, configPath, writeConfig }) => {
      await writeConfig({ root: join(directory, 'missing'), inputs: [{ kind: 'unsupported' }], documents: false });
      await expect(loadDoctorConfig(configPath)).rejects.toMatchObject({ code: 'CONFIG_INPUT_KIND' });
    });
  });

  it('loads projections before parsing documents or audit policy', async () => {
    await withConfig(async ({ configPath, writeConfig }) => {
      await writeConfig({ inputs: [{ kind: 'form-projection', path: 'missing.json' }], documents: false, audit: false });
      await expect(loadDoctorConfig(configPath)).rejects.toMatchObject({ code: 'CONFIG_INPUT_UNREADABLE' });
    });
  });

  it('retains a loaded projection and records ordinary source failure as incomplete', async () => {
    await withConfig(async ({ configPath, projection, writeProjection }) => {
      await writeProjection({ ...projection, source: { ...projection.source, path: 'missing-source.json' } });
      const loaded = await loadDoctorConfig(configPath);
      expect(loaded.formChecks.has(projection.action.id)).toBe(true);
      expect(loaded.sourceIssues.get(projection.action.id)).toContain('missing-source.json');
    });
  });

  it('treats a source path escape as fatal before invalid document parsing', async () => {
    await withConfig(async ({ configPath, projection, writeConfig, writeProjection }) => {
      await writeProjection({ ...projection, source: { ...projection.source, path: '../escaped.json' } });
      await writeConfig({ documents: false });
      await expect(loadDoctorConfig(configPath)).rejects.toMatchObject({ code: 'CONFIG_PATH_ESCAPE' });
    });
  });

  it('still detects duplicate actions after recording a source verification failure', async () => {
    await withConfig(async ({ configPath, projection, writeConfig, writeProjection }) => {
      await writeProjection({ ...projection, source: { ...projection.source, path: 'missing-source.json' } });
      await writeConfig({ inputs: [{ kind: 'form-projection', path: 'form-check.json' }, { kind: 'form-projection', path: 'form-check.json' }], documents: false });
      await expect(loadDoctorConfig(configPath)).rejects.toMatchObject({ code: 'CONFIG_DUPLICATE_ACTION' });
    });
  });

  it.each([
    [{ bindings: [{ formId: 7, submitterPolicy: 'unsupported' }], documentUrl: 'invalid' }, 'CONFIG_SUBMITTER_POLICY', 'unsupported submitterPolicy'],
    [{ bindings: [{ formId: 7 }], documentUrl: 'invalid' }, 'CONFIG_INVALID', '$.documents[0].bindings[0].formId must be a non-empty string'],
    [{ bindings: [{ formId: 'order', actionId: 'orders.createDraft' }], documentUrl: 'invalid' }, 'CONFIG_DOCUMENT_URL', 'invalid documentUrl: invalid'],
  ])('keeps binding and URL validation before document path: %j', async (document, code, message) => {
    await withConfig(async ({ configPath, writeConfig }) => {
      await writeConfig({ documents: [document], audit: false });
      await expect(loadDoctorConfig(configPath)).rejects.toMatchObject({ code, message });
    });
  });

  it.each([
    [[], 'CONFIG_DOCUMENTS'],
    [[{ path: 'form.html', documentUrl: 'https://example.test/', sourceKind: 'snapshot', executionAssumption: 'native', bindings: [] }], 'CONFIG_ZERO_BINDINGS'],
  ])('validates document presence and binding count before audit: %j', async (documents, code) => {
    await withConfig(async ({ configPath, writeConfig }) => {
      await writeConfig({ documents, audit: false });
      await expect(loadDoctorConfig(configPath)).rejects.toMatchObject({ code });
    });
  });

  it('validates required rule groups before the completeness flag', async () => {
    await withConfig(async ({ configPath, writeConfig }) => {
      await writeConfig({ audit: { releaseRequiresCompleteDeclaredBoundary: 'invalid', releaseRequiredRuleGroups: ['invalid'] } });
      await expect(loadDoctorConfig(configPath)).rejects.toMatchObject({ code: 'CONFIG_RULE_GROUP' });
    });
  });

  it('preserves explicit audit values and required-group order', async () => {
    await withConfig(async ({ configPath, writeConfig }) => {
      await writeConfig({ audit: { releaseRequiresCompleteDeclaredBoundary: false, releaseRequiredRuleGroups: ['constraints', 'binding', 'constraints'] } });
      const loaded = await loadDoctorConfig(configPath);
      expect(loaded.config.releaseRequiresCompleteDeclaredBoundary).toBe(false);
      expect(loaded.config.releaseRequiredRuleGroups).toEqual(['constraints', 'binding', 'constraints']);
    });
  });
});
