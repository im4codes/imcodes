import { FS_GENERIC_ERROR_CODES } from '../../../shared/fs-error-codes.js';

export class PayloadTooLargeError extends Error {
  constructor() {
    super(FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE);
    this.name = 'PayloadTooLargeError';
  }
}

export async function readStreamBytesBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onExceed?: () => void,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        onExceed?.();
        await reader.cancel('payload_too_large').catch(() => {});
        throw new PayloadTooLargeError();
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

export async function readResponseBytesBounded(
  res: Response,
  maxBytes: number,
  controller?: AbortController,
): Promise<Buffer> {
  const contentLengthHeader = res.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      controller?.abort('payload_too_large');
      await res.body?.cancel?.('payload_too_large').catch(() => {});
      throw new PayloadTooLargeError();
    }
  }
  if (res.body) {
    return readStreamBytesBounded(res.body, maxBytes, () => controller?.abort('payload_too_large'));
  }
  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  if (buf.length > maxBytes) {
    throw new PayloadTooLargeError();
  }
  return buf;
}
