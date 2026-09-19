/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatFileTransferContentRange } from '@shared/transport/file-transfer.js';

const FILE = new TextEncoder().encode('0123456789abcdefghij');

/** A body that delivers `bytes` and then either ends or breaks mid-stream. */
function body(bytes: Uint8Array, breakAfter = false): ReadableStream<Uint8Array> {
  let delivered = false;
  return new ReadableStream({
    pull(controller) {
      if (!delivered) {
        delivered = true;
        controller.enqueue(bytes);
        return;
      }
      if (breakAfter) controller.error(new TypeError('network error'));
      else controller.close();
    },
  });
}

function full(bytes: Uint8Array, breakAfter = false): Response {
  return new Response(body(bytes, breakAfter), {
    status: 200,
    headers: { 'Content-Length': String(FILE.length) },
  });
}

function partial(start: number, bytes: Uint8Array, breakAfter = false, total = FILE.length): Response {
  return new Response(body(bytes, breakAfter), {
    status: 206,
    headers: {
      'Content-Length': String(total - start),
      'Content-Range': formatFileTransferContentRange(start, total),
    },
  });
}

function sink(): { written: () => string; write: (data: BufferSource) => Promise<void> } {
  const chunks: Uint8Array[] = [];
  return {
    write: async (data) => {
      chunks.push(new Uint8Array(data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer.slice(
        (data as ArrayBufferView).byteOffset,
        (data as ArrayBufferView).byteOffset + (data as ArrayBufferView).byteLength,
      )));
    },
    written: () => new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))),
  };
}

function rangeOf(call: unknown[]): string | null {
  return new Headers((call[1] as RequestInit | undefined)?.headers).get('Range');
}

describe('HTTP attachment download resume', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function run(pending: Promise<void>): Promise<void> {
    let settled = false;
    void pending.finally(() => { settled = true; }).catch(() => undefined);
    for (let step = 0; step < 200 && !settled; step += 1) {
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(500);
    }
    return pending;
  }

  it('continues from the last written byte after the stream breaks, twice', async () => {
    fetchMock
      .mockResolvedValueOnce(full(FILE.subarray(0, 7), true))
      .mockResolvedValueOnce(partial(7, FILE.subarray(7, 12), true))
      .mockResolvedValueOnce(partial(12, FILE.subarray(12)));
    const { streamAttachmentDownloadToWritable } = await import('../src/api.js');
    const out = sink();
    const progress: Array<[number, number | null]> = [];

    await run(streamAttachmentDownloadToWritable('srv', 'abc', out, undefined, undefined, (p) => {
      progress.push([p.loadedBytes, p.totalBytes]);
    }));

    expect(out.written()).toBe('0123456789abcdefghij');
    expect(fetchMock.mock.calls.map(rangeOf)).toEqual([null, 'bytes=7-', 'bytes=12-']);
    expect(progress.at(-1)).toEqual([20, 20]);
  });

  it('resumes after a response that ends cleanly but short', async () => {
    fetchMock
      .mockResolvedValueOnce(full(FILE.subarray(0, 5)))
      .mockResolvedValueOnce(partial(5, FILE.subarray(5)));
    const { streamAttachmentDownloadToWritable } = await import('../src/api.js');
    const out = sink();
    await run(streamAttachmentDownloadToWritable('srv', 'abc', out));
    expect(out.written()).toBe('0123456789abcdefghij');
    expect(fetchMock.mock.calls.map(rangeOf)).toEqual([null, 'bytes=5-']);
  });

  it('retries a node that is briefly offline before the first byte', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"daemon_offline"}', { status: 503 }))
      .mockResolvedValueOnce(full(FILE));
    const { streamAttachmentDownloadToWritable } = await import('../src/api.js');
    const out = sink();
    await run(streamAttachmentDownloadToWritable('srv', 'abc', out));
    expect(out.written()).toBe('0123456789abcdefghij');
  });

  it('refuses to splice in a different file', async () => {
    fetchMock
      .mockResolvedValueOnce(full(FILE.subarray(0, 7), true))
      .mockResolvedValueOnce(partial(7, FILE.subarray(7), false, 30));
    const { streamAttachmentDownloadToWritable } = await import('../src/api.js');
    await expect(run(streamAttachmentDownloadToWritable('srv', 'abc', sink())))
      .rejects.toMatchObject({ status: 206 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after repeated interruptions that make no progress', async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError('network error'); });
    const { ATTACHMENT_DOWNLOAD_RESUME, streamAttachmentDownloadToWritable } = await import('../src/api.js');
    await expect(run(streamAttachmentDownloadToWritable('srv', 'abc', sink()))).rejects.toThrow('network error');
    expect(fetchMock).toHaveBeenCalledTimes(ATTACHMENT_DOWNLOAD_RESUME.MAX_ATTEMPTS_WITHOUT_PROGRESS + 1);
  });

  it('does not resume a failed write to disk', async () => {
    fetchMock.mockResolvedValue(full(FILE));
    const { streamAttachmentDownloadToWritable } = await import('../src/api.js');
    const failing = { write: vi.fn(async () => { throw new DOMException('disk full', 'QuotaExceededError'); }) };
    await expect(run(streamAttachmentDownloadToWritable('srv', 'abc', failing))).rejects.toThrow('disk full');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
