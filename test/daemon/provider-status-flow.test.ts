/**
 * Integration tests for the full transport provider status lifecycle:
 *
 *   connectProvider → broadcastProviderStatus → serverLink → bridge → browser
 *
 * Tests the daemon side of the flow: provider registry, transport relay,
 * race conditions, re-broadcast logic, and event relay through the send function.
 *
 * For bridge→browser tests, see server/test/bridge.test.ts (transport provider relay).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setTransportRelaySend,
  wireProviderToRelay,
  broadcastProviderStatus,
} from '../../src/daemon/transport-relay.js';
import {
  connectProvider,
  disconnectProvider,
  getProvider,
  getAllProviders,
  disconnectAll,
} from '../../src/agent/provider-registry.js';
import { TRANSPORT_EVENT, TRANSPORT_MSG } from '../../shared/transport-events.js';
import type { MessageDelta, AgentMessage } from '../../shared/agent-message.js';

// ── Mock the OpenClaw provider so we don't need a real WebSocket ──────────────

let mockDeltaCb: ((sid: string, d: MessageDelta) => void) | null = null;
let mockCompleteCb: ((sid: string, m: AgentMessage) => void) | null = null;
let mockErrorCb: ((sid: string, e: { code: string; message: string; recoverable: boolean }) => void) | null = null;

const mockProviderInstance = {
  id: 'openclaw',
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  send: vi.fn(),
  createSession: vi.fn().mockResolvedValue('oc-session-1'),
  endSession: vi.fn(),
  onDelta: vi.fn((cb: typeof mockDeltaCb) => { mockDeltaCb = cb; }),
  onComplete: vi.fn((cb: typeof mockCompleteCb) => { mockCompleteCb = cb; }),
  onError: vi.fn((cb: typeof mockErrorCb) => { mockErrorCb = cb; }),
};

vi.mock('../../src/agent/providers/openclaw.js', () => ({
  OpenClawProvider: vi.fn(() => ({
    ...mockProviderInstance,
    // Fresh callback registration per instance
    onDelta: vi.fn((cb: typeof mockDeltaCb) => { mockDeltaCb = cb; }),
    onComplete: vi.fn((cb: typeof mockCompleteCb) => { mockCompleteCb = cb; }),
    onError: vi.fn((cb: typeof mockErrorCb) => { mockErrorCb = cb; }),
  })),
}));

// Suppress logger output in tests
vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDelta(messageId = 'msg-1'): MessageDelta {
  return { messageId, type: 'text', delta: 'hello ', role: 'assistant' };
}

function makeMessage(id = 'msg-1'): AgentMessage {
  return {
    id,
    sessionId: 'oc-session-1',
    kind: 'text',
    role: 'assistant',
    content: 'done',
    timestamp: Date.now(),
    status: 'complete',
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('provider status end-to-end flow', () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn();
    setTransportRelaySend(send);
    vi.clearAllMocks();
    // Re-set send after clearAllMocks since clearAllMocks resets the vi.fn()
    send = vi.fn();
    setTransportRelaySend(send);
    mockDeltaCb = null;
    mockCompleteCb = null;
    mockErrorCb = null;
  });

  afterEach(async () => {
    await disconnectAll();
    setTransportRelaySend(() => {});
  });

  // ── Provider lifecycle ──────────────────────────────────────────────────

  describe('provider lifecycle', () => {
    it('connectProvider broadcasts provider.status connected=true', async () => {
      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });

      expect(send).toHaveBeenCalledWith({
        type: TRANSPORT_MSG.PROVIDER_STATUS,
        providerId: 'openclaw',
        connected: true,
      });
    });

    it('disconnectProvider broadcasts provider.status connected=false', async () => {
      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });
      send.mockClear();

      await disconnectProvider('openclaw');

      expect(send).toHaveBeenCalledWith({
        type: TRANSPORT_MSG.PROVIDER_STATUS,
        providerId: 'openclaw',
        connected: false,
      });
    });

    it('reconnecting a provider disconnects the old one first', async () => {
      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });
      send.mockClear();

      await connectProvider('openclaw', { url: 'ws://test2', token: 'tok2', agentId: 'a2' });

      // Should see: disconnect(false) then connect(true)
      const statusCalls = send.mock.calls
        .filter(([msg]: [Record<string, unknown>]) => msg.type === TRANSPORT_MSG.PROVIDER_STATUS);

      expect(statusCalls).toHaveLength(2);
      expect(statusCalls[0][0].connected).toBe(false);
      expect(statusCalls[1][0].connected).toBe(true);
    });

    it('getProvider returns provider after connect, undefined after disconnect', async () => {
      expect(getProvider('openclaw')).toBeUndefined();

      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });
      expect(getProvider('openclaw')).toBeDefined();

      await disconnectProvider('openclaw');
      expect(getProvider('openclaw')).toBeUndefined();
    });

    it('disconnectAll clears all providers', async () => {
      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });
      expect(getAllProviders()).toHaveLength(1);

      await disconnectAll();
      expect(getAllProviders()).toHaveLength(0);
    });

    it('disconnecting non-existent provider is a no-op', async () => {
      await disconnectProvider('nonexistent');
      expect(send).not.toHaveBeenCalled();
    });
  });

  // ── Re-broadcast on reconnect ─────────────────────────────────────────

  describe('re-broadcast on reconnect', () => {
    it('re-broadcasts all connected providers after serverLink opens', async () => {
      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });
      send.mockClear();

      // Simulate server-link open handler: re-broadcast all connected providers
      for (const p of getAllProviders()) {
        broadcastProviderStatus(p.id, true);
      }

      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith({
        type: TRANSPORT_MSG.PROVIDER_STATUS,
        providerId: 'openclaw',
        connected: true,
      });
    });

    it('re-broadcast after disconnect sends nothing', async () => {
      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });
      await disconnectProvider('openclaw');
      send.mockClear();

      for (const p of getAllProviders()) {
        broadcastProviderStatus(p.id, true);
      }

      expect(send).not.toHaveBeenCalled();
    });
  });

  // ── Race condition: autoReconnectProviders vs serverLink ────────────────

  describe('race condition handling', () => {
    it('broadcastProviderStatus is silent when sendToServer is null', () => {
      setTransportRelaySend(null as unknown as (msg: Record<string, unknown>) => void);
      expect(() => broadcastProviderStatus('openclaw', true)).not.toThrow();
      expect(send).not.toHaveBeenCalled();
    });

    it('provider status reaches server after late sendToServer setup', async () => {
      // Phase 1: serverLink not ready
      setTransportRelaySend(null as unknown as (msg: Record<string, unknown>) => void);
      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });
      expect(send).not.toHaveBeenCalled(); // dropped

      // Phase 2: serverLink opens → set send + re-broadcast
      setTransportRelaySend(send);
      for (const p of getAllProviders()) {
        broadcastProviderStatus(p.id, true);
      }

      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith({
        type: TRANSPORT_MSG.PROVIDER_STATUS,
        providerId: 'openclaw',
        connected: true,
      });
    });

    it('serverLink replacement clears old send, new one works', async () => {
      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });
      send.mockClear();

      // Simulate disconnect: set discard function (like server-link close handler)
      setTransportRelaySend(() => { /* discard */ });

      broadcastProviderStatus('openclaw', true);
      expect(send).not.toHaveBeenCalled(); // went to discard

      // Simulate new connection
      const send2 = vi.fn();
      setTransportRelaySend(send2);
      broadcastProviderStatus('openclaw', true);
      expect(send2).toHaveBeenCalledOnce();
    });
  });

  // ── Event relay through wireProviderToRelay ────────────────────────────

  describe('event relay to server', () => {
    it('wireProviderToRelay registers all three callbacks', async () => {
      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });

      expect(mockDeltaCb).toBeDefined();
      expect(mockCompleteCb).toBeDefined();
      expect(mockErrorCb).toBeDefined();
    });

    it('delta events relay with correct shape', async () => {
      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });
      send.mockClear();

      mockDeltaCb!('sess-1', makeDelta());

      expect(send).toHaveBeenCalledWith({
        type: TRANSPORT_EVENT.CHAT_DELTA,
        sessionId: 'sess-1',
        messageId: 'msg-1',
        delta: 'hello ',
        deltaType: 'text',
      });
    });

    it('complete events relay with correct shape', async () => {
      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });
      send.mockClear();

      mockCompleteCb!('sess-1', makeMessage());

      expect(send).toHaveBeenCalledWith({
        type: TRANSPORT_EVENT.CHAT_COMPLETE,
        sessionId: 'sess-1',
        messageId: 'msg-1',
      });
    });

    it('error events relay with correct shape', async () => {
      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });
      send.mockClear();

      mockErrorCb!('sess-1', { code: 'TIMEOUT', message: 'timed out', recoverable: true });

      expect(send).toHaveBeenCalledWith({
        type: TRANSPORT_EVENT.CHAT_ERROR,
        sessionId: 'sess-1',
        error: 'timed out',
        code: 'TIMEOUT',
      });
    });

    it('multiple rapid deltas all reach server in order', async () => {
      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });
      send.mockClear();

      const deltas = ['Hello', ' world', '!', ' How', ' are', ' you', '?'];
      for (const d of deltas) {
        mockDeltaCb!('sess-1', { messageId: 'msg-1', type: 'text', delta: d, role: 'assistant' });
      }

      const deltaCalls = send.mock.calls
        .filter(([msg]: [Record<string, unknown>]) => msg.type === TRANSPORT_EVENT.CHAT_DELTA);
      expect(deltaCalls).toHaveLength(deltas.length);
      expect(deltaCalls.map(([msg]: [Record<string, unknown>]) => msg.delta)).toEqual(deltas);
    });

    it('events from disconnect provider are safe (no crash on orphaned callbacks)', async () => {
      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });
      const savedDeltaCb = mockDeltaCb!;
      const savedCompleteCb = mockCompleteCb!;
      const savedErrorCb = mockErrorCb!;

      await disconnectProvider('openclaw');
      send.mockClear();

      // These callbacks are orphaned but should not crash
      expect(() => savedDeltaCb('sess-1', makeDelta())).not.toThrow();
      expect(() => savedCompleteCb('sess-1', makeMessage())).not.toThrow();
      expect(() => savedErrorCb('sess-1', { code: 'X', message: 'x', recoverable: false })).not.toThrow();

      // Events still reach send (relay doesn't know provider was disconnected)
      expect(send).toHaveBeenCalledTimes(3);
    });
  });

  // ── Full lifecycle scenario ────────────────────────────────────────────

  describe('full lifecycle scenario', () => {
    it('connect → stream deltas → complete → disconnect produces correct message sequence', async () => {
      // 1. Connect provider
      await connectProvider('openclaw', { url: 'ws://test', token: 'tok', agentId: 'a1' });

      // 2. Stream some deltas
      mockDeltaCb!('sess-1', { messageId: 'msg-1', type: 'text', delta: 'Hello', role: 'assistant' });
      mockDeltaCb!('sess-1', { messageId: 'msg-1', type: 'text', delta: ' world', role: 'assistant' });

      // 3. Complete
      mockCompleteCb!('sess-1', makeMessage());

      // 4. Disconnect
      await disconnectProvider('openclaw');

      // Verify full sequence
      const types = send.mock.calls.map(([msg]: [Record<string, unknown>]) => msg.type);
      expect(types).toEqual([
        TRANSPORT_MSG.PROVIDER_STATUS,   // connect → true
        TRANSPORT_EVENT.CHAT_DELTA,       // delta 1
        TRANSPORT_EVENT.CHAT_DELTA,       // delta 2
        TRANSPORT_EVENT.CHAT_COMPLETE,    // complete
        TRANSPORT_MSG.PROVIDER_STATUS,   // disconnect → false
      ]);

      // Verify connect/disconnect bookends
      expect(send.mock.calls[0][0].connected).toBe(true);
      expect(send.mock.calls[4][0].connected).toBe(false);
    });
  });
});
