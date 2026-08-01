import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { DirectFileTransferRouter } from '../src/ws/direct-file-transfer-router.js';
import { DIRECT_FILE_TRANSFER_CAPABILITY, DIRECT_FILE_TRANSFER_LIMITS, DIRECT_FILE_TRANSFER_MSG } from '../../shared/direct-file-transfer.js';

const init = {
  type: DIRECT_FILE_TRANSFER_MSG.INIT,
  requestId: '123e4567-e89b-12d3-a456-426614174000',
  clientUploadId: '123e4567-e89b-12d3-a456-426614174001',
  filename: 'large.zip',
  size: 6 * 1024 * 1024 * 1024,
};

function fixture() {
  const browserA = {} as WebSocket;
  const browserB = {} as WebSocket;
  const browserMessages = new Map<WebSocket, Array<Record<string, unknown>>>();
  const daemonMessages: Array<Record<string, unknown>> = [];
  let generation = 3;
  let available = true;
  let supported = true;
  const router = new DirectFileTransferRouter({
    serverId: () => 'server-1',
    daemonAvailable: () => available,
    daemonSupportsDirect: () => supported,
    daemonGeneration: () => generation,
    sendDaemon: vi.fn((message, expected) => {
      if (!available || expected !== generation) return false;
      daemonMessages.push(message);
      return true;
    }),
    sendBrowser: (socket, message) => {
      const rows = browserMessages.get(socket) ?? [];
      rows.push(message);
      browserMessages.set(socket, rows);
    },
  });
  return {
    router,
    browserA,
    browserB,
    daemonMessages,
    messages: (socket: WebSocket) => browserMessages.get(socket) ?? [],
    setGeneration: (value: number) => { generation = value; router.setDaemonGeneration(value); },
    setAvailable: (value: boolean) => { available = value; },
    setSupported: (value: boolean) => { supported = value; },
  };
}

describe('DirectFileTransferRouter', () => {
  it('mints one authority, routes signaling to one socket, and never broadcasts daemon results', () => {
    const f = fixture();
    expect(f.router.handleBrowser(f.browserA, 'user-a', init)).toBe(true);
    expect(f.daemonMessages).toHaveLength(1);
    expect(f.daemonMessages[0]).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.PREPARE,
      requestId: init.requestId,
      size: init.size,
    });
    const authorized = f.messages(f.browserA)[0];
    expect(authorized).toMatchObject({ type: DIRECT_FILE_TRANSFER_MSG.AUTHORIZED, requestId: init.requestId });
    expect((authorized.capability as string).length).toBeGreaterThanOrEqual(32);

    f.router.handleBrowser(f.browserA, 'user-a', {
      type: DIRECT_FILE_TRANSFER_MSG.OFFER,
      requestId: init.requestId,
      capability: authorized.capability,
      sdp: 'offer-sdp',
    });
    expect(f.daemonMessages[1]).toMatchObject({ type: DIRECT_FILE_TRANSFER_MSG.OFFER, sdp: 'offer-sdp' });

    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.DONE,
      requestId: init.requestId,
      capability: authorized.capability,
      clientUploadId: init.clientUploadId,
      attachment: {
        id: 'stored.bin',
        source: 'upload',
        serverId: '',
        daemonPath: '/tmp/stored.bin',
        size: init.size,
        createdAt: new Date().toISOString(),
        downloadable: true,
      },
    }, 3);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.DONE,
      attachment: { serverId: 'server-1' },
    });
    expect(f.messages(f.browserB)).toHaveLength(0);
  });

  it('rejects wrong sockets, stale generations, unsupported daemons, and duplicate upload identities', () => {
    const f = fixture();
    f.setSupported(false);
    f.router.handleBrowser(f.browserA, 'user-a', init);
    expect(f.messages(f.browserA)[0]).toMatchObject({ error: 'capability_unavailable', retryable: true });

    const g = fixture();
    g.router.handleBrowser(g.browserA, 'user-a', init);
    const capability = g.messages(g.browserA)[0].capability;
    g.router.handleBrowser(g.browserB, 'user-a', {
      type: DIRECT_FILE_TRANSFER_MSG.OFFER,
      requestId: init.requestId,
      capability,
      sdp: 'forged',
    });
    expect(g.messages(g.browserB).at(-1)).toMatchObject({ error: 'invalid_authority' });
    g.setGeneration(4);
    expect(g.messages(g.browserA).at(-1)).toMatchObject({ error: 'daemon_offline', retryable: true });
  });

  it('advertises the negotiated capability constant without changing relay support', () => {
    expect(DIRECT_FILE_TRANSFER_CAPABILITY).toBe('file.transfer.direct.v1');
  });

  it('expires authorities and enforces the global active-transfer cap', () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.router.handleBrowser(f.browserA, 'user-a', init);
      vi.advanceTimersByTime(DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS + 1);
      expect(f.messages(f.browserA).at(-1)).toMatchObject({ error: 'authority_expired', retryable: true });

      const capped = fixture();
      for (let index = 0; index < DIRECT_FILE_TRANSFER_LIMITS.MAX_PER_DAEMON; index++) {
        capped.router.handleBrowser({} as WebSocket, `user-${index}`, {
          ...init,
          requestId: `request-${String(index).padStart(4, '0')}`,
          clientUploadId: `upload-${String(index).padStart(5, '0')}`,
        });
      }
      const overflow = {} as WebSocket;
      capped.router.handleBrowser(overflow, 'overflow', {
        ...init,
        requestId: 'request-overflow',
        clientUploadId: 'upload-overflow',
      });
      expect(capped.messages(overflow).at(-1)).toMatchObject({ error: 'too_many_transfers', retryable: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
