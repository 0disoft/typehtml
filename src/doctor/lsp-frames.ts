const MAX_HEADER_BYTES = 8_192;
const MAX_MESSAGE_BYTES = 1_024 * 1_024;

function contentLength(header: Buffer): number {
  const lengths = [...header.toString('ascii').matchAll(/^Content-Length:\s*([0-9]+)\s*$/gim)];
  if (lengths.length !== 1) throw new TypeError('LSP requires one Content-Length header');
  const length = Number(lengths[0]![1]);
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_MESSAGE_BYTES) throw new RangeError('LSP message exceeds bounds');
  return length;
}

/** Each body is allocated once and each incoming byte is copied at most once, even in tiny chunks. */
export async function* readLspFrames(input: AsyncIterable<Uint8Array | string>): AsyncGenerator<Buffer> {
  const header = Buffer.allocUnsafe(MAX_HEADER_BYTES + 4);
  let headerSize = 0;
  let body: Buffer | null = null;
  let bodySize = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    let offset = 0;
    while (offset < bytes.length) {
      if (body === null) {
        header[headerSize++] = bytes[offset++]!;
        if (headerSize >= 4 && header[headerSize - 4] === 13 && header[headerSize - 3] === 10 && header[headerSize - 2] === 13 && header[headerSize - 1] === 10) {
          body = Buffer.allocUnsafe(contentLength(header.subarray(0, headerSize - 4)));
          headerSize = 0;
        } else if (headerSize >= header.length) throw new RangeError('LSP header exceeds bounds');
        continue;
      }
      const count = Math.min(body.length - bodySize, bytes.length - offset);
      body.set(bytes.subarray(offset, offset + count), bodySize);
      bodySize += count;
      offset += count;
      if (bodySize === body.length) {
        yield body;
        body = null;
        bodySize = 0;
      }
    }
  }
  if (headerSize !== 0 || body !== null) throw new TypeError('incomplete LSP frame');
}
