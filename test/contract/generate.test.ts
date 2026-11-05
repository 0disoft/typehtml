import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateContractArtifacts } from '../../src/contract/generate.ts';
import { loadBoundaryContract, loadFormCheck } from '../../src/contract/load.ts';
import { computeBehaviorSha256 } from '../../src/contract/behavior.ts';
import { verifyFormCheckSource } from '../../src/contract/project.ts';

const design = new URL('../../docs/design/v0.5/', import.meta.url);
const contractPath = fileURLToPath(new URL('examples/order.boundary.json', design));

describe('authoritative contract data generation', () => {
  test('derives both exact projections and digest metadata deterministically', async () => {
    const loaded = await loadBoundaryContract(contractPath);
    const options = {
      sourcePath: 'examples/order.boundary.json',
      sourceSha256: loaded.sourceSha256,
      generator: 'validation/generate_reference_types.py',
    };
    const generated = generateContractArtifacts(loaded, options);
    expect(generateContractArtifacts(loaded, options)).toEqual(generated);
    expect(generated.formCheck).toEqual((await loadFormCheck(fileURLToPath(new URL('examples/form-check.generated.json', design)))).formCheck);
    expect(generated.startFormCheck).toEqual((await loadFormCheck(fileURLToPath(new URL('examples/start-form-check.generated.json', design)))).formCheck);
    expect(generated.digests.behaviorSha256).toBe(loaded.behaviorSha256);
    expect(generated.types).toContain(`// Source SHA256: ${loaded.sourceSha256}`);
    expect(generated.types).toContain('// Source JSON Pointer: /page/viewSchema');
  });

  test('generated types compile and reject wrong wire types, missing required fields and private fields', async () => {
    const loaded = await loadBoundaryContract(contractPath);
    const value = structuredClone(loaded.value) as any;
    value.input.schema.properties.note = { type: 'string', enum: ['quoted"value', 'line\nvalue'] };
    value.input.codecs.note = 'text';
    const changed = { ...loaded, value, behaviorSha256: computeBehaviorSha256(value) };
    const generated = generateContractArtifacts(changed, {
      sourcePath: 'examples/order.boundary.json',
      sourceSha256: changed.sourceSha256,
    });
    const directory = await mkdtemp(join(tmpdir(), 'typehtml-generated-types-'));
    try {
      const fixture = `${generated.types}
const input: OrderInput = { productId: 'p', quantity: 1 };
const optional: OrderInput = { ...input, note: 'line\\nvalue' };
// @ts-expect-error wire strings are not decoded integer values
const wrongWire: OrderInput = { productId: 'p', quantity: '1' };
// @ts-expect-error required input field is absent
const missing: OrderInput = { productId: 'p' };
// @ts-expect-error finite enum values remain literal types
const wrongEnum: OrderInput = { ...input, note: 'other' };
const receipt: PublicReceipt = { orderId: 'draft_1', state: 'draft', totalMinor: 1, currency: 'KRW' };
// @ts-expect-error private fields are not part of the public type
const privateReceipt: PublicReceipt = { ...receipt, tenantId: 'private' };
// @ts-expect-error const values remain literal types
const wrongCurrency: PublicReceipt = { ...receipt, currency: 'USD' };
const page: OrderPageView = { productId: 'p', productName: 'name', unitPriceMinor: 1, currency: 'KRW', productRevision: 1 };
`;
      await writeFile(join(directory, 'generated.ts'), fixture);
      await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: 'ES2022', types: [] },
        files: ['generated.ts'],
      }));
      const result = Bun.spawnSync([
        process.execPath,
        fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url)),
        '--project', join(directory, 'tsconfig.json'),
      ]);
      expect(new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).toBe('');
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('source verification rejects stale and forged exact projections', async () => {
    const loaded = await loadBoundaryContract(contractPath);
    const generated = generateContractArtifacts(loaded, {
      sourcePath: 'examples/order.boundary.json', sourceSha256: loaded.sourceSha256,
    });
    expect(() => verifyFormCheckSource(generated.formCheck, loaded)).not.toThrow();
    expect(() => verifyFormCheckSource(generated.startFormCheck, loaded)).not.toThrow();
    const stale = structuredClone(generated.formCheck) as any;
    stale.source.sha256 = 'a'.repeat(64);
    expect(() => verifyFormCheckSource(stale, loaded)).toThrow('source bytes have changed');
    const forged = structuredClone(generated.formCheck) as any;
    forged.input.schema.properties.quantity.maximum = 200;
    expect(() => verifyFormCheckSource(forged, loaded)).toThrow('input does not match');
    const changedBehavior = structuredClone(generated.formCheck) as any;
    changedBehavior.source.behaviorSha256 = 'b'.repeat(64);
    expect(() => verifyFormCheckSource(changedBehavior, loaded)).toThrow('behavior digest');
  });
});
