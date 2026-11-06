import { describe, expect, test } from 'bun:test';
import { readLspFrames } from '../../src/doctor/lsp-frames.ts';

async function decode(chunks: readonly Uint8Array[]): Promise<string[]> {
  const input = async function* () { yield* chunks; };
  const output: string[] = [];
  for await (const frame of readLspFrames(input())) output.push(frame.toString('utf8'));
  return output;
}
function packet(body: string): Buffer { return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); }

describe('bounded LSP frame reader', () => {
  test('reads coalesced messages and fragmented UTF-8 without retaining a prior body', async () => {
    const messages = ['{"text":"😀"}', '{"id":2}', '{"id":3}'];
    const input = Buffer.concat(messages.map(packet));
    expect(await decode(Array.from({ length: input.length }, (_, index) => input.subarray(index, index + 1)))).toEqual(messages);
    expect(await decode([input])).toEqual(messages);
  });

  test.each([1_048_575, 1_048_576, 1_048_577])('retains the inclusive message-byte limit at %i', async (size) => {
    const message = 'x'.repeat(size);
    const pending = decode([packet(message)]);
    if (size <= 1_048_576) expect((await pending)[0]?.length).toBe(size);
    else await expect(pending).rejects.toThrow('message exceeds bounds');
  });

  test.each([8_191, 8_192, 8_193])('retains the inclusive header-byte limit at %i', async (size) => {
    const prefix = 'Content-Length: 1\r\nX-Test: ';
    const header = prefix + 'x'.repeat(size - prefix.length);
    const pending = decode([Buffer.from(`${header}\r\n\r\na`)]);
    if (size <= 8_192) expect(await pending).toEqual(['a']);
    else await expect(pending).rejects.toThrow('header exceeds bounds');
  });

  test('rejects invalid, duplicate and truncated frames before producing a body', async () => {
    for (const invalid of ['Content-Length: 0\r\n\r\n', 'Content-Length: 1\r\nContent-Length: 1\r\n\r\na', 'Content-Length: 2\r\n\r\na', 'Content-Length: 1\r\n\r', 'X-Test: a\r\n\r\na']) {
      await expect(decode([Buffer.from(invalid)])).rejects.toThrow();
    }
    expect(await decode([])).toEqual([]);
  });
});
