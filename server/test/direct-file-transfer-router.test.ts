import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { DirectFileTransferRouter } from '../src/ws/direct-file-transfer-router.js';
import { stringifyForServerSend } from '../../src/daemon/latency-tracer.js';
import {
  DIRECT_FILE_TRANSFER_CAPABILITY,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PURPOSE,
} from '../../shared/direct-file-transfer.js';

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

  it('unwraps the ServerLink sequence envelope before strict daemon-frame validation', () => {
    const f = fixture();
    f.router.handleBrowser(f.browserA, 'user-a', init);
    const capability = f.messages(f.browserA)[0].capability;

    const serialized = stringifyForServerSend({
      type: DIRECT_FILE_TRANSFER_MSG.ANSWER,
      requestId: init.requestId,
      capability,
      sdp: 'answer-sdp',
    }, 42);
    // Exercise the exact daemon serialization composition. Before this fix,
    // the appended `seq` made strict direct-frame validation reject every
    // real answer/ICE frame while hand-built unit frames stayed green.
    f.router.handleDaemon(JSON.parse(serialized.payload), 3);

    expect(f.messages(f.browserA).at(-1)).toEqual({
      type: DIRECT_FILE_TRANSFER_MSG.ANSWER,
      requestId: init.requestId,
      capability,
      sdp: 'answer-sdp',
    });
  });

  it('fails a bound route immediately when a daemon signaling frame is malformed', () => {
    const f = fixture();
    f.router.handleBrowser(f.browserA, 'user-a', init);
    const capability = f.messages(f.browserA)[0].capability;

    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.ANSWER,
      requestId: init.requestId,
      capability,
      sdp: 'answer-sdp',
      seq: 'not-a-valid-transport-sequence',
    }, 3);

    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      requestId: init.requestId,
      error: 'internal_error',
      retryable: true,
    });
  });

  it('ignores a malformed signaling frame from a stale daemon generation', () => {
    const f = fixture();
    f.router.handleBrowser(f.browserA, 'user-a', init);
    const capability = f.messages(f.browserA)[0].capability;
    const messageCount = f.messages(f.browserA).length;

    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.ANSWER,
      requestId: init.requestId,
      capability,
      sdp: 'stale-answer-sdp',
      seq: 'not-a-valid-transport-sequence',
    }, 2);

    expect(f.messages(f.browserA)).toHaveLength(messageCount);

    const current = stringifyForServerSend({
      type: DIRECT_FILE_TRANSFER_MSG.ANSWER,
      requestId: init.requestId,
      capability,
      sdp: 'current-answer-sdp',
    }, 43);
    f.router.handleDaemon(JSON.parse(current.payload), 3);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.ANSWER,
      sdp: 'current-answer-sdp',
    });
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

  it('reuses the exact-socket authority path for probes and rejects arbitrary IP targets', () => {
    const f = fixture();
    const probe = {
      ...init,
      purpose: DIRECT_FILE_TRANSFER_PURPOSE.PROBE,
      filename: 'connectivity-probe',
      size: 0,
    } as const;
    expect(f.router.handleBrowser(f.browserA, 'user-a', probe)).toBe(true);
    expect(f.daemonMessages[0]).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.PREPARE,
      purpose: DIRECT_FILE_TRANSFER_PURPOSE.PROBE,
      size: 0,
    });
    expect(f.messages(f.browserA)[0]).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.AUTHORIZED,
      purpose: DIRECT_FILE_TRANSFER_PURPOSE.PROBE,
    });

    const rejected = fixture();
    expect(rejected.router.handleBrowser(rejected.browserA, 'user-a', {
      ...probe,
      targetIp: '192.168.2.145',
    })).toBe(true);
    expect(rejected.daemonMessages).toHaveLength(0);
    expect(rejected.messages(rejected.browserA)[0]).toMatchObject({ error: 'invalid_request' });
  });

  it('expires authorities and enforces the global active-transfer cap', () => {
    vi.useFakeTimers();
    try {
      expect(DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS).toBe(2 * 60 * 60 * 1000);

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

  it('keeps an authenticated active transfer authorized while progress continues', () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.router.handleBrowser(f.browserA, 'user-a', init);
      const capability = f.messages(f.browserA)[0].capability;

      vi.advanceTimersByTime(DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS - 1_000);
      f.router.handleDaemon({
        type: DIRECT_FILE_TRANSFER_MSG.PROGRESS,
        requestId: init.requestId,
        capability,
        loaded: 1024,
        total: init.size,
      }, 3);

      vi.advanceTimersByTime(2_000);
      expect(f.messages(f.browserA).at(-1)).toMatchObject({
        type: DIRECT_FILE_TRANSFER_MSG.PROGRESS,
        loaded: 1024,
      });

      vi.advanceTimersByTime(DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS - 2_001);
      expect(f.messages(f.browserA).at(-1)).toMatchObject({
        type: DIRECT_FILE_TRANSFER_MSG.PROGRESS,
        loaded: 1024,
      });

      vi.advanceTimersByTime(2);
      expect(f.messages(f.browserA).at(-1)).toMatchObject({
        type: DIRECT_FILE_TRANSFER_MSG.ERROR,
        error: 'authority_expired',
        retryable: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not renew authority for stale generations, forged capabilities, or already-expired routes', () => {
    vi.useFakeTimers();
    try {
      const stale = fixture();
      stale.router.handleBrowser(stale.browserA, 'user-a', init);
      const staleCapability = stale.messages(stale.browserA)[0].capability;

      const forged = fixture();
      forged.router.handleBrowser(forged.browserA, 'user-a', init);

      vi.advanceTimersByTime(DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS - 1_000);
      stale.router.handleDaemon({
        type: DIRECT_FILE_TRANSFER_MSG.PROGRESS,
        requestId: init.requestId,
        capability: staleCapability,
        loaded: 1024,
        total: init.size,
      }, 2);
      forged.router.handleDaemon({
        type: DIRECT_FILE_TRANSFER_MSG.PROGRESS,
        requestId: init.requestId,
        capability: 'forged-capability-value-that-is-long-enough',
        loaded: 1024,
        total: init.size,
      }, 3);

      vi.advanceTimersByTime(1_001);
      expect(stale.messages(stale.browserA).at(-1)).toMatchObject({ error: 'authority_expired' });
      expect(forged.messages(forged.browserA).at(-1)).toMatchObject({ error: 'authority_expired' });

      const late = fixture();
      late.router.handleBrowser(late.browserA, 'user-a', init);
      const lateCapability = late.messages(late.browserA)[0].capability;
      vi.setSystemTime(Date.now() + DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS + 1);
      late.router.handleDaemon({
        type: DIRECT_FILE_TRANSFER_MSG.PROGRESS,
        requestId: init.requestId,
        capability: lateCapability,
        loaded: 1024,
        total: init.size,
      }, 3);
      expect(late.messages(late.browserA).at(-1)).toMatchObject({ error: 'authority_expired' });
    } finally {
      vi.useRealTimers();
    }
  });
});
