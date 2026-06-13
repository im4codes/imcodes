import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  PREVIEW_BINARY_FRAME,
  PREVIEW_ERROR,
  PREVIEW_MSG,
  packPreviewBinaryFrame,
} from '../../shared/preview-types.js';
import { handlePreviewBinaryFrame, handlePreviewCommand } from '../../src/daemon/preview-relay.js';
import { isStreamingResponse } from '../../shared/preview-stream-policy.js';

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

  it('exempts a streaming (SSE) response from the cumulative byte cap', async () => {
    // Load the relay + shared limits with a tiny MAX_RESPONSE_BYTES so we can
    // overshoot it cheaply. isStreamingResponse must classify text/event-stream
    // as streaming and therefore skip the cumulative byte-cap abort.
    const prev = process.env.PREVIEW_MAX_RESPONSE_BYTES;
    process.env.PREVIEW_MAX_RESPONSE_BYTES = '8';
    vi.resetModules();
    try {
      const relay = await import('../../src/daemon/preview-relay.js');
      const types = await import('../../shared/preview-types.js');
      const serverLink = createServerLink();
      fetchMock.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: Readable.from([
          Buffer.from('data: one two three four\n\n'), // > 8 bytes
          Buffer.from('data: five six seven eight\n\n'),
        ]),
      });

      relay.handlePreviewCommand({
        type: types.PREVIEW_MSG.REQUEST,
        requestId: 'req-stream',
        previewId: 'preview-stream',
        port: 3000,
        method: 'GET',
        path: '/events',
        headers: {},
        hasBody: false,
      }, serverLink as never);

      await new Promise((r) => setTimeout(r, 0));

      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: types.PREVIEW_MSG.RESPONSE_END,
        requestId: 'req-stream',
      }));
      expect(serverLink.send).not.toHaveBeenCalledWith(expect.objectContaining({
        type: types.PREVIEW_MSG.ERROR,
        requestId: 'req-stream',
        code: types.PREVIEW_ERROR.LIMIT_EXCEEDED,
      }));
      // All body chunks were forwarded despite exceeding the 8-byte cap.
      expect(serverLink.sendBinary).toHaveBeenCalledTimes(2);
    } finally {
      if (prev === undefined) delete process.env.PREVIEW_MAX_RESPONSE_BYTES;
      else process.env.PREVIEW_MAX_RESPONSE_BYTES = prev;
      vi.resetModules();
    }
  });

  it('exempts a charset-qualified streaming (SSE) response from the cumulative byte cap (T-TE-charset.1)', async () => {
    // The shared classifier strips `;charset=...` and lowercases via contentTypeOf,
    // so a charset-qualified SSE content-type must still classify as streaming and
    // therefore skip the cumulative byte-cap abort. Assert the classifier directly
    // for explicitness, then exercise the daemon relay end-to-end.
    expect(isStreamingResponse({ 'content-type': 'text/event-stream;charset=utf-8' })).toBe(true);
    expect(isStreamingResponse({ 'content-type': 'application/x-ndjson; charset=utf-8' })).toBe(true);

    const prev = process.env.PREVIEW_MAX_RESPONSE_BYTES;
    process.env.PREVIEW_MAX_RESPONSE_BYTES = '8';
    vi.resetModules();
    try {
      const relay = await import('../../src/daemon/preview-relay.js');
      const types = await import('../../shared/preview-types.js');
      const serverLink = createServerLink();
      fetchMock.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        // charset-qualified SSE MIME → still streaming → byte cap must NOT apply.
        headers: new Headers({ 'content-type': 'text/event-stream;charset=utf-8' }),
        body: Readable.from([
          Buffer.from('data: one two three four\n\n'), // > 8 bytes
          Buffer.from('data: five six seven eight\n\n'),
        ]),
      });

      relay.handlePreviewCommand({
        type: types.PREVIEW_MSG.REQUEST,
        requestId: 'req-stream-charset',
        previewId: 'preview-stream-charset',
        port: 3000,
        method: 'GET',
        path: '/events',
        headers: {},
        hasBody: false,
      }, serverLink as never);

      await new Promise((r) => setTimeout(r, 0));

      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: types.PREVIEW_MSG.RESPONSE_END,
        requestId: 'req-stream-charset',
      }));
      // A cumulative size that would trip MAX_RESPONSE_BYTES for a non-stream is
      // NOT a LIMIT_EXCEEDED for the charset-qualified SSE response.
      expect(serverLink.send).not.toHaveBeenCalledWith(expect.objectContaining({
        type: types.PREVIEW_MSG.ERROR,
        requestId: 'req-stream-charset',
        code: types.PREVIEW_ERROR.LIMIT_EXCEEDED,
      }));
      // All body chunks were forwarded despite exceeding the 8-byte cap.
      expect(serverLink.sendBinary).toHaveBeenCalledTimes(2);
    } finally {
      if (prev === undefined) delete process.env.PREVIEW_MAX_RESPONSE_BYTES;
      else process.env.PREVIEW_MAX_RESPONSE_BYTES = prev;
      vi.resetModules();
    }
  });

  it('still aborts a non-streaming response that exceeds the cumulative byte cap', async () => {
    const prev = process.env.PREVIEW_MAX_RESPONSE_BYTES;
    process.env.PREVIEW_MAX_RESPONSE_BYTES = '8';
    vi.resetModules();
    try {
      const relay = await import('../../src/daemon/preview-relay.js');
      const types = await import('../../shared/preview-types.js');
      const serverLink = createServerLink();
      fetchMock.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        // Plain text, no chunked / streaming MIME → NOT streaming → byte cap applies.
        headers: new Headers({ 'content-type': 'text/plain', 'content-length': '100' }),
        body: Readable.from([
          Buffer.from('0123456789'), // 10 bytes > 8-byte cap
        ]),
      });

      relay.handlePreviewCommand({
        type: types.PREVIEW_MSG.REQUEST,
        requestId: 'req-nonstream',
        previewId: 'preview-nonstream',
        port: 3000,
        method: 'GET',
        path: '/big',
        headers: {},
        hasBody: false,
      }, serverLink as never);

      await new Promise((r) => setTimeout(r, 0));

      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: types.PREVIEW_MSG.ERROR,
        requestId: 'req-nonstream',
        code: types.PREVIEW_ERROR.LIMIT_EXCEEDED,
      }));
      expect(serverLink.send).not.toHaveBeenCalledWith(expect.objectContaining({
        type: types.PREVIEW_MSG.RESPONSE_END,
        requestId: 'req-nonstream',
      }));
    } finally {
      if (prev === undefined) delete process.env.PREVIEW_MAX_RESPONSE_BYTES;
      else process.env.PREVIEW_MAX_RESPONSE_BYTES = prev;
      vi.resetModules();
    }
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
