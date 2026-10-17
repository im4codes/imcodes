import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, WsClient } from '../src/ws-client.js';
import { loadFsLocalImagePreview } from '../src/fs-local-image-preview.js';

function createWsHarness(options: { throwOnRead?: Error; responseBeforeReturn?: ServerMessage } = {}) {
  const handlers = new Set<(message: ServerMessage) => void>();
  let sequence = 0;
  const fsReadFile = vi.fn((path: string, sessionName?: string) => {
    if (options.throwOnRead) throw options.throwOnRead;
    sequence += 1;
    const requestId = `read-${sequence}:${sessionName ?? 'owner'}:${path}`;
    if (options.responseBeforeReturn) {
      for (const handler of [...handlers]) handler(options.responseBeforeReturn);
    }
    return requestId;
  });
  const ws = {
    fsReadFile,
    onMessage: (handler: (message: ServerMessage) => void) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
  } as unknown as WsClient;
  const emit = (message: ServerMessage) => {
    for (const handler of [...handlers]) handler(message);
  };
  return { emit, fsReadFile, handlers, ws };
}

function imageResponse(requestId: string, overrides: Record<string, unknown> = {}): ServerMessage {
  return {
    type: 'fs.read_response',
    requestId,
    path: '/repo/docs/image.png',
    status: 'ok',
    encoding: 'base64',
    mimeType: 'image/png',
    content: 'cG5n',
    ...overrides,
  } as ServerMessage;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('loadFsLocalImagePreview', () => {
  it('matches the varying request id, preserves session scope, and removes its listener after success', async () => {
    const harness = createWsHarness();
    const promise = loadFsLocalImagePreview(harness.ws, '/repo/docs/image.png', {
      sessionName: 'deck_project_brain',
    });
    const requestId = harness.fsReadFile.mock.results[0].value;

    harness.emit(imageResponse('read-other:owner:/tmp/other.png'));
    expect(harness.handlers.size).toBe(1);
    harness.emit(imageResponse(requestId));

    await expect(promise).resolves.toEqual({
      dataUrl: 'data:image/png;base64,cG5n',
      alt: 'image.png',
    });
    expect(harness.fsReadFile).toHaveBeenCalledWith('/repo/docs/image.png', 'deck_project_brain');
    expect(harness.handlers.size).toBe(0);
    harness.emit(imageResponse(requestId));
    expect(harness.handlers.size).toBe(0);
  });

  it.each([
    ['error response', { status: 'error', error: 'forbidden_path' }],
    ['non-image MIME', { mimeType: 'text/plain' }],
    ['missing content', { content: undefined }],
    ['empty content', { content: '' }],
  ])('rejects %s and removes its listener', async (_label, overrides) => {
    const harness = createWsHarness();
    const promise = loadFsLocalImagePreview(harness.ws, '/repo/docs/image.png', {
      errorMessage: 'preview failed',
    });
    const requestId = harness.fsReadFile.mock.results[0].value;
    harness.emit(imageResponse(requestId, overrides));

    await expect(promise).rejects.toThrow('preview failed');
    expect(harness.handlers.size).toBe(0);
  });

  // tsk_5rf. 6a169ad3c made the daemon answer image previews with metadata plus a
  // download handle and no bytes, but this loader still only accepted base64, so
  // every streamed image fell through to the reject branch and the chat
  // thumbnail disappeared. The bytes must come over the authenticated chunked
  // download channel - never back through the WebSocket.
  it('resolves a streamed image preview through the authenticated download URL (tsk_5rf)', async () => {
    const harness = createWsHarness();
    const buildUrl = vi.fn(async (serverId: string, downloadId: string, sessionName?: string) => (
      `https://host/api/server/${serverId}/uploads/${downloadId}/download?sessionName=${sessionName ?? ''}`
    ));
    const promise = loadFsLocalImagePreview(harness.ws, '/repo/docs/image.png', {
      sessionName: 'deck_alpha_brain',
      serverId: 'srv-1',
      buildDownloadUrl: buildUrl,
    });
    const requestId = harness.fsReadFile.mock.results[0]?.value as string;
    harness.emit(imageResponse(requestId, {
      encoding: undefined,
      content: undefined,
      previewMode: 'stream',
      downloadId: 'dl-42',
    }));

    await expect(promise).resolves.toEqual({
      dataUrl: 'https://host/api/server/srv-1/uploads/dl-42/download?sessionName=deck_alpha_brain',
      alt: 'image.png',
    });
    expect(buildUrl).toHaveBeenCalledWith('srv-1', 'dl-42', 'deck_alpha_brain');
  });

  it('still rejects a streamed image preview that carries no download handle (tsk_5rf)', async () => {
    const harness = createWsHarness();
    const promise = loadFsLocalImagePreview(harness.ws, '/repo/docs/image.png', {
      serverId: 'srv-1',
      buildDownloadUrl: async () => 'https://host/never',
    });
    const requestId = harness.fsReadFile.mock.results[0]?.value as string;
    harness.emit(imageResponse(requestId, {
      encoding: undefined,
      content: undefined,
      previewMode: 'stream',
      downloadId: undefined,
    }));
    await expect(promise).rejects.toThrow();
  });

  it('cleans up when fsReadFile throws synchronously', async () => {
    const harness = createWsHarness({ throwOnRead: new Error('socket closed') });
    const promise = loadFsLocalImagePreview(harness.ws, '/repo/docs/image.png');

    await expect(promise).rejects.toThrow('socket closed');
    expect(harness.handlers.size).toBe(0);
  });

  it('times out once and removes the pending listener', async () => {
    vi.useFakeTimers();
    const harness = createWsHarness();
    const promise = loadFsLocalImagePreview(harness.ws, '/repo/docs/image.png', {
      timeoutMs: 250,
      timeoutMessage: 'preview timed out',
    });
    const rejection = expect(promise).rejects.toThrow('preview timed out');
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(harness.handlers.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(harness.handlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a synchronous empty-id response before fsReadFile returns its request id', async () => {
    vi.useFakeTimers();
    const harness = createWsHarness({ responseBeforeReturn: imageResponse('') });
    const promise = loadFsLocalImagePreview(harness.ws, '/repo/docs/image.png', {
      timeoutMs: 1,
      timeoutMessage: 'preview timed out',
    });
    const rejection = expect(promise).rejects.toThrow('preview timed out');

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(harness.handlers.size).toBe(0);
  });
});
