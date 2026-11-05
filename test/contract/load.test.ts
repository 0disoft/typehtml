import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBoundaryContract, loadFormCheck } from '../../src/contract/load.ts';
import { DEFAULT_MAX_BYTES } from '../../src/contract/strict-json.ts';

describe('bounded contract loaders', () => {
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
