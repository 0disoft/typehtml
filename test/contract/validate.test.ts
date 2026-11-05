import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { readStrictJson } from '../../src/contract/strict-json.ts';
import { loadBoundaryContract, loadFormCheck } from '../../src/contract/load.ts';
import { computeBehaviorSha256 } from '../../src/contract/behavior.ts';
import { projectFormCheck, projectStartFormCheck } from '../../src/contract/project.ts';
import { ContractValidationError, validateBoundaryContract, validateFormCheck } from '../../src/contract/validate.ts';
import type { JsonObject } from '../../src/contract/strict-json.ts';

const design = new URL('../../docs/design/v0.5/', import.meta.url);
const contractPath = fileURLToPath(new URL('examples/order.boundary.json', design));
const generatedPath = fileURLToPath(new URL('examples/form-check.generated.json', design));
const startPath = fileURLToPath(new URL('examples/start-form-check.generated.json', design));

function clone(value: JsonObject): any {
  return JSON.parse(JSON.stringify(value));
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'NO_ERROR';
  } catch (error) {
    if (error instanceof ContractValidationError) return error.code;
    throw error;
  }
}

describe('boundary contract validation and projection', () => {
  test('loads the published order contract', async () => {
    const loaded = await loadBoundaryContract(contractPath);
    expect(loaded.contract.id).toBe('orders.createDraft');
    expect(loaded.contract.input.schema.required).toEqual(['productId', 'quantity']);
    expect(loaded.contract.http.path).toBe('/actions/orders/create-draft');
    expect(loaded.sourceSha256).toBe('8d28473d4cc7141575930268c4843ea6e487ff560d379e206c38b1512050cf4e');
    expect(loaded.behaviorSha256).toBe('54f41ad4f93d68a25db8148f355e0dd6becc6db23005c24e93930d9b847e0c66');
  });

  test('projects the design form-check without inventing runtime coverage', async () => {
    const loaded = await loadBoundaryContract(contractPath);
    const projected = projectFormCheck(loaded.contract, loaded.value, {
      sourcePath: 'examples/order.boundary.json',
      sourceSha256: loaded.sourceSha256,
      generator: 'validation/generate_reference_types.py',
    });
    const expected = await readStrictJson(generatedPath);
    expect(projected.action).toEqual((expected as any).action);
    expect(projected.input).toEqual((expected as any).input);
    expect(projected.protocolFields).toEqual((expected as any).protocolFields);
    expect(projected.source).toEqual((expected as any).source);
    expect(projected.format).toBe('boundary-form-check/0.2-draft');
    expect(projected.status).toBe('generated-design-reference-not-product-output');
  });

  test('projects the begin/start form with only the declared fields', async () => {
    const loaded = await loadBoundaryContract(contractPath);
    const projected = projectStartFormCheck(loaded.contract, loaded.value, {
      sourcePath: 'examples/order.boundary.json',
      sourceSha256: loaded.sourceSha256,
      generator: 'validation/generate_reference_types.py',
    });
    const expected = await readStrictJson(startPath);
    expect(projected.action).toEqual((expected as any).action);
    expect(projected.input).toEqual((expected as any).input);
    expect(projected.protocolFields).toEqual((expected as any).protocolFields);
    expect(projected.source).toEqual((expected as any).source);
  });

  test('rejects unknown keys at the contract boundary', async () => {
    const loaded = await loadBoundaryContract(contractPath);
    const bad = clone(loaded.value);
    bad.extra = true;
    expect(codeOf(() => validateBoundaryContract(bad))).toBe('UNKNOWN_KEY');
  });

  test('rejects unsupported schema keywords instead of ignoring them', async () => {
    const loaded = await loadBoundaryContract(contractPath);
    const bad = clone(loaded.value);
    bad.input.schema.properties.productId.minItems = 1;
    expect(codeOf(() => validateBoundaryContract(bad))).toBe('UNSUPPORTED_KEYWORD');
  });

  test('rejects codecs that do not match the field type', async () => {
    const loaded = await loadBoundaryContract(contractPath);
    const bad = clone(loaded.value);
    bad.input.codecs.quantity = 'text';
    expect(codeOf(() => validateBoundaryContract(bad))).toBe('CODEC_TYPE_MISMATCH');
  });

  test('rejects non-canonical HTTP paths', async () => {
    const loaded = await loadBoundaryContract(contractPath);
    const bad = clone(loaded.value);
    bad.http.path = 'actions/orders/create-draft';
    expect(codeOf(() => validateBoundaryContract(bad))).toBe('INVALID_PATH');
    bad.http.path = '/a/../b';
    expect(codeOf(() => validateBoundaryContract(bad))).toBe('INVALID_PATH');
  });

  test('rejects server-owned fields that are also input fields', async () => {
    const loaded = await loadBoundaryContract(contractPath);
    const bad = clone(loaded.value);
    bad.serverOwnedFields.push('productId');
    expect(codeOf(() => validateBoundaryContract(bad))).toBe('SERVER_OWNED_INPUT_CONFLICT');
  });

  test('rejects missing codecs', async () => {
    const loaded = await loadBoundaryContract(contractPath);
    const bad = clone(loaded.value);
    delete bad.input.codecs.quantity;
    expect(codeOf(() => validateBoundaryContract(bad))).toBe('MISSING_CODEC');
  });

  test('validates the generated form-check and rejects a bad source hash', async () => {
    const loaded = await loadFormCheck(generatedPath);
    expect(loaded.formCheck.action.id).toBe('orders.createDraft');
    const bad = clone(loaded.value);
    bad.source.sha256 = 'not-a-hash';
    expect(codeOf(() => validateFormCheck(bad))).toBe('INVALID_SHA256');
  });

  test('behavior digest excludes page presentation data', async () => {
    const loaded = await loadBoundaryContract(contractPath);
    const before = computeBehaviorSha256(loaded.value);
    const changed = clone(loaded.value);
    changed.page.path = '/orders/newer';
    changed.headers.contentSecurityPolicy = "default-src 'none'";
    expect(computeBehaviorSha256(changed)).toBe(before);
  });
});
