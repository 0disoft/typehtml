import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBoundaryContract, loadFormCheck } from '../../src/contract/load.ts';
import { DEFAULT_MAX_BYTES, type JsonObject } from '../../src/contract/strict-json.ts';
import { computeBehaviorSha256, sourceSha256 } from '../../src/contract/behavior.ts';
import { validateBusinessInput } from '../../src/runtime/input.ts';

const documents = [
  ['boundary', 'order.boundary.json', loadBoundaryContract],
  ['form check', 'form-check.generated.json', loadFormCheck],
] as const;

function inputProperties(value: JsonObject): JsonObject {
  return ((value.input as JsonObject).schema as JsonObject).properties as JsonObject;
}

describe('bounded contract loaders', () => {
  test.each(documents)('keeps the loaded %s and its raw JSON immutable and coherent', async (_name, fixture, load) => {
    const path = fileURLToPath(new URL(`../../docs/design/v0.5/examples/${fixture}`, import.meta.url));
    const loaded = await load(path);
    const document = 'contract' in loaded ? loaded.contract : loaded.formCheck;
    const rawQuantity = inputProperties(loaded.value).quantity as JsonObject;
    const original = JSON.stringify(loaded.value);
    const invalid = { productId: 'p_100', quantity: '21' };
    expect(validateBusinessInput(document.input, invalid).ok).toBe(false);

    expect(Reflect.set(rawQuantity, 'maximum', 21)).toBe(false);
    expect(Reflect.set(document.input.schema.properties.quantity!, 'maximum', 21)).toBe(false);
    expect(Reflect.set(document.input.schema.required, 'length', 0)).toBe(false);
    expect(Reflect.deleteProperty(document.input.schema.properties, 'quantity')).toBe(false);
    expect(Reflect.set(document.input.codecs, 'quantity', 'text')).toBe(false);
    expect(Reflect.set(loaded, 'value', {})).toBe(false);
    expect(JSON.stringify(loaded.value)).toBe(original);
    expect(validateBusinessInput(document.input, invalid).ok).toBe(false);
    if ('contract' in loaded) {
      expect(Reflect.set(loaded, 'behaviorSha256', 'changed')).toBe(false);
      expect(computeBehaviorSha256(loaded.value)).toBe(loaded.behaviorSha256);
      expect(sourceSha256(await readFile(path))).toBe(loaded.sourceSha256);
    } else {
      expect(Reflect.set(loaded.formCheck.source, 'behaviorSha256', 'changed')).toBe(false);
      expect(Reflect.set(loaded.formCheck.protocolFields, 'length', 0)).toBe(false);
    }

    // Callers can still edit an explicit copy without changing the loaded snapshot.
    const editable = structuredClone(loaded.value);
    expect(Reflect.set(inputProperties(editable).quantity as JsonObject, 'maximum', 21)).toBe(true);
    expect(JSON.stringify(loaded.value)).toBe(original);
  });

  test.each(documents)('protects nested enum arrays in both loaded %s views', async (_name, fixture, load) => {
    const directory = await mkdtemp(join(tmpdir(), 'typehtml-contract-enum-'));
    try {
      const value = JSON.parse(await readFile(new URL(`../../docs/design/v0.5/examples/${fixture}`, import.meta.url), 'utf8')) as JsonObject;
      const quantity = inputProperties(value).quantity as JsonObject;
      quantity.enum = [1, 2];
      const path = join(directory, 'enum.json');
      await writeFile(path, JSON.stringify(value));
      const loaded = await load(path);
      const document = 'contract' in loaded ? loaded.contract : loaded.formCheck;
      const enumValues = document.input.schema.properties.quantity!.enum!;
      const rawEnum = (inputProperties(loaded.value).quantity as JsonObject).enum as number[];

      expect(Reflect.set(enumValues, '0', 20)).toBe(false);
      expect(Reflect.set(rawEnum, 'length', 0)).toBe(false);
      expect(enumValues).toEqual([1, 2]);
      expect(validateBusinessInput(document.input, { productId: 'p_100', quantity: '20' }).ok).toBe(false);
      if ('contract' in loaded) expect(computeBehaviorSha256(loaded.value)).toBe(loaded.behaviorSha256);
      expect(Object.isFrozen(value)).toBe(false);
      expect(Object.isFrozen(quantity.enum)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects oversized files before JSON parsing for either input kind', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'typehtml-contract-load-'));
    try {
      const path = join(directory, 'oversized.json');
      await writeFile(path, Buffer.alloc(DEFAULT_MAX_BYTES + 1, 0x20));
      for (const load of [loadBoundaryContract, loadFormCheck]) {
        await expect(load(path)).rejects.toMatchObject({ code: 'JSON_TOO_LARGE' });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('does not let exponent or decimal spellings bypass integer-only contract reading', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'typehtml-contract-number-'));
    try {
      const boundary = await readFile(new URL('../../docs/design/v0.5/examples/order.boundary.json', import.meta.url), 'utf8');
      const projection = await readFile(new URL('../../docs/design/v0.5/examples/form-check.generated.json', import.meta.url), 'utf8');
      const path = join(directory, 'number.json');
      await writeFile(path, boundary.replace('"operationRevision": 2', '"operationRevision": 2e0'));
      await expect(loadBoundaryContract(path)).rejects.toMatchObject({ code: 'UNSUPPORTED_JSON_NUMBER' });
      await writeFile(path, projection.replace('"minimum": 1', '"minimum": 1.0'));
      await expect(loadFormCheck(path)).rejects.toMatchObject({ code: 'UNSUPPORTED_JSON_NUMBER' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
