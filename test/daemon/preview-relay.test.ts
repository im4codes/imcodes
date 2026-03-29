import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  PREVIEW_BINARY_FRAME,
  PREVIEW_ERROR,
  PREVIEW_MSG,
  packPreviewBinaryFrame,
} from '../../shared/preview-types.js';
import { handlePreviewBinaryFrame, handlePreviewCommand } from '../../src/daemon/preview-relay.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function createServerLink() {
  return {
    send: vi.fn(),
    sendBinary: vi.fn(),
  };
}

describe('daemon preview relay', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rewrites host and strips origin/referer while forcing manual redirects', async () => {
    const serverLink = createServerLink();
    fetchMock.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: Readable.from([Buffer.from('ok')]),
    });

    handlePreviewCommand({
      type: PREVIEW_MSG.REQUEST,
      requestId: 'req-1',
      previewId: 'preview-1',
      port: 3000,
      method: 'POST',
      path: '/docs?q=1',
      headers: {
        host: 'public.example',
        origin: 'https://public.example',
        referer: 'https://public.example/app',
        'content-type': 'application/json',
      },
      hasBody: false,
    }, serverLink as never);

    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit & { duplex?: string }];
    expect(String(url)).toBe('http://127.0.0.1:3000/docs?q=1');
    expect(init.redirect).toBe('manual');
    expect((init.headers as Headers).get('host')).toBe('127.0.0.1:3000');
    expect((init.headers as Headers).get('origin')).toBeNull();
    expect((init.headers as Headers).get('referer')).toBeNull();
    expect((init.headers as Headers).get('accept-encoding')).toBe('identity');
  });

  it('emits upstream unreachable on fetch failure', async () => {
    const serverLink = createServerLink();
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3000'));

    handlePreviewCommand({
      type: PREVIEW_MSG.REQUEST,
      requestId: 'req-2',
      previewId: 'preview-2',
      port: 3000,
      method: 'GET',
      path: '/',
      headers: {},
      hasBody: false,
    }, serverLink as never);

    await new Promise((r) => setTimeout(r, 0));

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: PREVIEW_MSG.ERROR,
      requestId: 'req-2',
      code: PREVIEW_ERROR.UPSTREAM_UNREACHABLE,
    }));
  });

  it('enforces request byte limit on binary body frames', async () => {
    const serverLink = createServerLink();
    fetchMock.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      body: null,
    });

    handlePreviewCommand({
      type: PREVIEW_MSG.REQUEST,
      requestId: 'req-3',
      previewId: 'preview-3',
      port: 3000,
      method: 'POST',
      path: '/',
      headers: {},
      hasBody: true,
    }, serverLink as never);

    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    handlePreviewBinaryFrame(packPreviewBinaryFrame(PREVIEW_BINARY_FRAME.REQUEST_BODY, 'req-3', huge), serverLink as never);

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: PREVIEW_MSG.ERROR,
      requestId: 'req-3',
      code: PREVIEW_ERROR.LIMIT_EXCEEDED,
    }));
  });

  it('does not time out an sse-style upstream while chunks keep arriving before idle timeout', async () => {
    vi.useFakeTimers();
    const serverLink = createServerLink();
    fetchMock.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: Readable.from((async function* () {
        yield Buffer.from('data: one\n\n');
        await new Promise((r) => setTimeout(r, 110_000));
        yield Buffer.from('data: two\n\n');
      })()),
    });

    handlePreviewCommand({
      type: PREVIEW_MSG.REQUEST,
      requestId: 'req-sse',
      previewId: 'preview-sse',
      port: 3000,
      method: 'GET',
      path: '/events',
      headers: {},
      hasBody: false,
    }, serverLink as never);

    await vi.runAllTimersAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: PREVIEW_MSG.RESPONSE_START,
      requestId: 'req-sse',
      status: 200,
    }));
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: PREVIEW_MSG.RESPONSE_END,
      requestId: 'req-sse',
    }));
    expect(serverLink.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: PREVIEW_MSG.ERROR,
      requestId: 'req-sse',
      code: PREVIEW_ERROR.TIMEOUT,
    }));
  });
});
