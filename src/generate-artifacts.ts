import { generateContractArtifacts, generateSchemaType } from './contract/generate.ts';
import { loadBoundaryContract } from './contract/load.ts';
import { readStrictJson } from './contract/strict-json.ts';
import { FORM_FORMAT, loadForm, projectForm } from './form/index.ts';

export interface ArtifactBundle {
  readonly sourceSha256: string;
  readonly files: ReadonlyMap<string, string>;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Static data artifacts only. Neither manifest format imports application code. */
export async function createArtifactBundle(sourcePath: string, sourceLabel: string): Promise<ArtifactBundle> {
  const value = await readStrictJson(sourcePath, { integerOnly: true });
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && value.format === FORM_FORMAT) {
    const loaded = await loadForm(sourcePath);
    const projection = projectForm(loaded.form, { sourcePath: sourceLabel, sourceSha256: loaded.sourceSha256 });
    const header = `// GENERATED from ${sourceLabel}; do not edit.\n// Source SHA256: ${loaded.sourceSha256}\n`;
    const types = header + generateSchemaType('FormInput', loaded.form.input.schema, '/input') +
      generateSchemaType('FormOutput', loaded.form.output, '/output');
    const definition = `${header}import { defineForm } from '@0disoft/typehtml';\n\nexport const form = defineForm(${JSON.stringify(loaded.form.definition, null, 2)} as const);\n`;
    return { sourceSha256: loaded.sourceSha256, files: new Map([
      ['form-definition.ts', definition], ['form-types.ts', types],
      ['form-check.generated.json', json(projection)],
      ['contract-digests.generated.json', json({ format: 'typehtml-form-digests/1', sourceSha256: loaded.sourceSha256, behaviorSha256: loaded.form.behaviorSha256 })],
    ]) };
  }
  const loaded = await loadBoundaryContract(sourcePath);
  const artifacts = generateContractArtifacts(loaded, { sourcePath: sourceLabel, sourceSha256: loaded.sourceSha256 });
  return { sourceSha256: loaded.sourceSha256, files: new Map([
    ['order-contract.ts', artifacts.types], ['form-check.generated.json', json(artifacts.formCheck)],
    ['start-form-check.generated.json', json(artifacts.startFormCheck)], ['contract-digests.generated.json', json(artifacts.digests)],
  ]) };
}
