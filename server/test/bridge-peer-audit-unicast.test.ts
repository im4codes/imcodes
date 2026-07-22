/**
 * Bridge-level peer-audit unicast focused tests.
 *
 * Verifies the WsBridge wiring (request path + daemon message path +
 * cleanup) delivers peer-audit responses ONLY to the originating browser
 * socket and never broadcasts. Default deny on missing routes.
 *
 * @vitest-environment node
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsBridge } from '../src/ws/bridge.js';
import { PEER_AUDIT_MESSAGES } from '../../shared/peer-audit.js';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';

// Auth path uses sha256Hex; mock so any token hashes to 'valid-hash' and
// the bridge accepts our hand-rolled authentication messages.
vi.mock('../src/security/crypto.js', () => ({
  sha256Hex: (_s: string) => 'valid-hash',
}));

vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void): void {
    if (this.closed) {
      callback?.(new Error('socket closed'));
      return;
    }
    this.sent.push(data);
    callback?.();
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close');
  }

  get sentStrings(): string[] {
    return this.sent.filter((s): s is string => typeof s === 'string');
  }
}

function makeDb(tokenHash = 'valid-hash') {
  return {
    queryOne: async () => ({ token_hash: tokenHash, node_role: 'full', revoked_at: null }),
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
    close: () => {},
  } as unknown as import('../src/db/client.js').Database;
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

describe('WsBridge peer-audit unicast routing', () => {
  let serverId: string;
  beforeEach(() => {
    serverId = `test-${Math.random().toString(36).slice(2)}`;
  });
  afterEach(() => {
    WsBridge.getAll().clear();
    vi.clearAllMocks();
  });

  function setupBridge() {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    const browserA = new MockWs();
    const browserB = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb() as never, {} as never);
    bridge.handleBrowserConnection(browserA as never, { id: 'user-a' } as never);
    bridge.handleBrowserConnection(browserB as never, { id: 'user-b' } as never);
    return { bridge, daemon, browserA, browserB };
  }

  it('reserves a route on browser request and unicasts the daemon reply to the originating browser only', async () => {
    const { bridge, daemon, browserA, browserB } = setupBridge();

    // Authenticate daemon.
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
    await flushAsync();
    expect(bridge.isAuthenticated).toBe(true);

    // Browser A sends peer_audit.list_candidates.
    const commandId = `peer_audit_${Math.random().toString(36).slice(2)}`;
    browserA.emit('message', JSON.stringify({
      type: DAEMON_COMMAND_TYPES.PEER_AUDIT_LIST_CANDIDATES,
      commandId,
      auditedSessionName: 'audited-x',
      auditedSessionInstanceId: 'audited-x-instance',
    }));
    await flushAsync();

    // Daemon receives the request verbatim.
    const daemonReceived = daemon.sentStrings.find((s) => s.includes('peer_audit.list_candidates'));
    expect(daemonReceived).toBeDefined();

    // Daemon sends the response.
    daemon.emit('message', JSON.stringify({
      type: PEER_AUDIT_MESSAGES.CANDIDATES,
      commandId,
      ok: true,
      list: { revision: 'r1', auditedSessionName: 'audited-x', auditedSessionInstanceId: 'audited-x-instance', candidates: [] },
    }));
    await flushAsync();

    // Browser A receives the response.
    const aReceived = browserA.sentStrings.find((s) => {
      try {
        const parsed = JSON.parse(s);
        return parsed.type === PEER_AUDIT_MESSAGES.CANDIDATES && parsed.commandId === commandId;
      } catch { return false; }
    });
    expect(aReceived).toBeDefined();

    // Browser B does NOT receive the response.
    const bReceived = browserB.sentStrings.find((s) => {
      try {
        const parsed = JSON.parse(s);
        return parsed.type === PEER_AUDIT_MESSAGES.CANDIDATES && parsed.commandId === commandId;
      } catch { return false; }
    });
    expect(bReceived).toBeUndefined();
  });

  it('drops a daemon reply with no matching route (default deny)', async () => {
    const { bridge, daemon, browserA } = setupBridge();
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
    await flushAsync();

    // Daemon sends a candidate response WITHOUT a browser request having reserved a route.
    daemon.emit('message', JSON.stringify({
      type: PEER_AUDIT_MESSAGES.CANDIDATES,
      commandId: 'never-reserved',
      ok: true,
      list: { revision: 'r1', auditedSessionName: 'x', auditedSessionInstanceId: 'y', candidates: [] },
    }));
    await flushAsync();

    const aReceived = browserA.sentStrings.find((s) => {
      try { return JSON.parse(s).commandId === 'never-reserved'; } catch { return false; }
    });
    expect(aReceived).toBeUndefined();
  });

  it('drops a late reply after the originating browser socket closes', async () => {
    const { bridge, daemon, browserA } = setupBridge();
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
    await flushAsync();

    const commandId = `peer_audit_${Math.random().toString(36).slice(2)}`;
    browserA.emit('message', JSON.stringify({
      type: DAEMON_COMMAND_TYPES.PEER_AUDIT_LIST_CANDIDATES,
      commandId,
      auditedSessionName: 'audited-x',
      auditedSessionInstanceId: 'audited-x-instance',
    }));
    await flushAsync();

    // Close browser A before daemon replies.
    browserA.close();
    await flushAsync();

    // Daemon now sends the response.
    daemon.emit('message', JSON.stringify({
      type: PEER_AUDIT_MESSAGES.CANDIDATES,
      commandId,
      ok: true,
      list: { revision: 'r1', auditedSessionName: 'audited-x', auditedSessionInstanceId: 'audited-x-instance', candidates: [] },
    }));
    await flushAsync();

    // Closed socket receives nothing because safeSend short-circuits on closed sockets.
    const aReceived = browserA.sentStrings.find((s) => {
      try { return JSON.parse(s).commandId === commandId; } catch { return false; }
    });
    expect(aReceived).toBeUndefined();
  });

  it('drops a reply whose daemon generation is stale (reconnect race)', async () => {
    const { bridge, daemon, browserA } = setupBridge();
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
    await flushAsync();

    const commandId = `peer_audit_${Math.random().toString(36).slice(2)}`;
    browserA.emit('message', JSON.stringify({
      type: DAEMON_COMMAND_TYPES.PEER_AUDIT_LIST_CANDIDATES,
      commandId,
      auditedSessionName: 'audited-x',
      auditedSessionInstanceId: 'audited-x-instance',
    }));
    await flushAsync();

    // Simulate daemon reconnect: open a new daemon WS that bumps the generation.
    const daemon2 = new MockWs();
    bridge.handleDaemonConnection(daemon2 as never, makeDb() as never, {} as never);
    daemon2.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
    await flushAsync();

    // Old daemon sends a late reply (it was queued on the network).
    daemon.emit('message', JSON.stringify({
      type: PEER_AUDIT_MESSAGES.CANDIDATES,
      commandId,
      ok: true,
      list: { revision: 'r1', auditedSessionName: 'audited-x', auditedSessionInstanceId: 'audited-x-instance', candidates: [] },
    }));
    await flushAsync();

    // Browser does not receive the stale reply (route was invalidated).
    const aReceived = browserA.sentStrings.find((s) => {
      try { return JSON.parse(s).commandId === commandId; } catch { return false; }
    });
    expect(aReceived).toBeUndefined();
  });

  it('drops a reply with mismatched commandId', async () => {
    const { bridge, daemon, browserA } = setupBridge();
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
    await flushAsync();

    const commandId = `peer_audit_${Math.random().toString(36).slice(2)}`;
    browserA.emit('message', JSON.stringify({
      type: DAEMON_COMMAND_TYPES.PEER_AUDIT_LIST_CANDIDATES,
      commandId,
      auditedSessionName: 'audited-x',
      auditedSessionInstanceId: 'audited-x-instance',
    }));
    await flushAsync();

    // Daemon replies with the wrong commandId.
    daemon.emit('message', JSON.stringify({
      type: PEER_AUDIT_MESSAGES.CANDIDATES,
      commandId: 'different-id',
      ok: true,
      list: { revision: 'r1', auditedSessionName: 'audited-x', auditedSessionInstanceId: 'audited-x-instance', candidates: [] },
    }));
    await flushAsync();

    const aReceived = browserA.sentStrings.find((s) => {
      try {
        const parsed = JSON.parse(s);
        return parsed.type === PEER_AUDIT_MESSAGES.CANDIDATES && parsed.commandId === 'different-id';
      } catch { return false; }
    });
    expect(aReceived).toBeUndefined();
  });

  it('offline daemon: returns daemon_unavailable synchronously without touching other browsers', async () => {
    const { browserA, browserB } = setupBridge();
    // Daemon never authenticates, so daemonWs is null/closed.

    const commandId = `peer_audit_${Math.random().toString(36).slice(2)}`;
    browserA.emit('message', JSON.stringify({
      type: DAEMON_COMMAND_TYPES.PEER_AUDIT_LIST_CANDIDATES,
      commandId,
      auditedSessionName: 'audited-x',
      auditedSessionInstanceId: 'audited-x-instance',
    }));
    await flushAsync();

    // Browser A receives an immediate daemon_unavailable error.
    const aReceived = browserA.sentStrings.find((s) => {
      try {
        const parsed = JSON.parse(s);
        return parsed.type === PEER_AUDIT_MESSAGES.CANDIDATES && parsed.commandId === commandId && parsed.ok === false && parsed.error === 'daemon_unavailable';
      } catch { return false; }
    });
    expect(aReceived).toBeDefined();

    // Browser B does not.
    const bReceived = browserB.sentStrings.find((s) => {
      try {
        const parsed = JSON.parse(s);
        return parsed.type === PEER_AUDIT_MESSAGES.CANDIDATES && parsed.commandId === commandId;
      } catch { return false; }
    });
    expect(bReceived).toBeUndefined();
  });

  it('consumes the route on first reply (second reply with same commandId drops)', async () => {
    const { bridge, daemon, browserA } = setupBridge();
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
    await flushAsync();

    const commandId = `peer_audit_${Math.random().toString(36).slice(2)}`;
    browserA.emit('message', JSON.stringify({
      type: DAEMON_COMMAND_TYPES.PEER_AUDIT_LIST_CANDIDATES,
      commandId,
      auditedSessionName: 'audited-x',
      auditedSessionInstanceId: 'audited-x-instance',
    }));
    await flushAsync();

    // First reply delivers.
    daemon.emit('message', JSON.stringify({
      type: PEER_AUDIT_MESSAGES.CANDIDATES,
      commandId,
      ok: true,
      list: { revision: 'r1', auditedSessionName: 'audited-x', auditedSessionInstanceId: 'audited-x-instance', candidates: [] },
    }));
    await flushAsync();
    const firstDelivery = browserA.sentStrings.filter((s) => {
      try { return JSON.parse(s).commandId === commandId; } catch { return false; }
    });
    expect(firstDelivery.length).toBe(1);

    // Second reply (replay) drops — the route was already consumed.
    daemon.emit('message', JSON.stringify({
      type: PEER_AUDIT_MESSAGES.CANDIDATES,
      commandId,
      ok: true,
      list: { revision: 'r1', auditedSessionName: 'audited-x', auditedSessionInstanceId: 'audited-x-instance', candidates: [] },
    }));
    await flushAsync();
    const secondDelivery = browserA.sentStrings.filter((s) => {
      try { return JSON.parse(s).commandId === commandId; } catch { return false; }
    });
    expect(secondDelivery.length).toBe(1); // still 1; the duplicate was dropped
  });
});