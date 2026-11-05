import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readStrictJson } from '../../src/contract/strict-json.ts';
import { computeBehaviorSha256, sourceSha256 } from '../../src/contract/behavior.ts';

const contractPath = new URL('../../docs/design/v0.5/examples/order.boundary.json', import.meta.url);

describe('boundary-behavior/1', () => {
  test('matches the published behavior digest for the design example', async () => {
    const bytes = await readFile(contractPath);
    const contract = await readStrictJson(fileURLToPath(contractPath));
    expect(sourceSha256(bytes)).toBe('8d28473d4cc7141575930268c4843ea6e487ff560d379e206c38b1512050cf4e');
    expect(computeBehaviorSha256(contract as any)).toBe('54f41ad4f93d68a25db8148f355e0dd6becc6db23005c24e93930d9b847e0c66');
  });
});
