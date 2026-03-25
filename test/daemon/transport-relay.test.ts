/**
 * Tests for src/daemon/transport-relay.ts
 *
 * Verifies that wireProviderToRelay correctly relays delta, complete, and error
 * callbacks from a TransportProvider to the server-link send function, and that
 * broadcastProviderStatus sends the expected shape (or is silent when no send
 * function is configured).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  setTransportRelaySend,
  wireProviderToRelay,
  broadcastProviderStatus,
} from '../../src/daemon/transport-relay.js';

import type { TransportProvider } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import { TRANSPORT_EVENT, TRANSPORT_MSG } from '../../shared/transport-events.js';

// ── Mock provider factory ───────────────────────────────────────────────────

type DeltaCb = (sessionId: string, delta: MessageDelta) => void;
type CompleteCb = (sessionId: string, message: AgentMessage) => void;
type ErrorCb = (sessionId: string, error: { code: string; message: string; recoverable: boolean }) => void;

function makeMockProvider() {
  let deltaCb: DeltaCb | undefined;
  let completeCb: CompleteCb | undefined;
  let errorCb: ErrorCb | undefined;

  return {
    provider: {
      onDelta: (cb: DeltaCb) => { deltaCb = cb; },
      onComplete: (cb: CompleteCb) => { completeCb = cb; },
      onError: (cb: ErrorCb) => { errorCb = cb; },
    } as unknown as TransportProvider,
    fireDelta: (sid: string, delta: MessageDelta) => deltaCb?.(sid, delta),
    fireComplete: (sid: string, msg: AgentMessage) => completeCb?.(sid, msg),
    fireError: (sid: string, err: { code: string; message: string; recoverable: boolean }) => errorCb?.(sid, err),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('transport-relay', () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn();
    setTransportRelaySend(send);
  });

  afterEach(() => {
    // Reset module-level sendToServer to a no-op to prevent leaks between tests.
    setTransportRelaySend(() => {});
  });

  // ── wireProviderToRelay ─────────────────────────────────────────────────

  describe('wireProviderToRelay', () => {
    it('relays delta events with correct chat.delta shape', () => {
      const { provider, fireDelta } = makeMockProvider();
      wireProviderToRelay(provider);

      const delta: MessageDelta = {
        messageId: 'msg-1',
        type: 'text',
        delta: 'hello ',
        role: 'assistant',
      };

      fireDelta('sess-1', delta);

      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith({
        type: TRANSPORT_EVENT.CHAT_DELTA,
        sessionId: 'sess-1',
        messageId: 'msg-1',
        delta: 'hello ',
        deltaType: 'text',
      });
    });

    it('relays complete events with correct chat.complete shape', () => {
      const { provider, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      const message: AgentMessage = {
        id: 'msg-2',
        sessionId: 'sess-1',
        kind: 'text',
        role: 'assistant',
        content: 'done',
        timestamp: Date.now(),
        status: 'complete',
      };

      fireComplete('sess-1', message);

      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith({
        type: TRANSPORT_EVENT.CHAT_COMPLETE,
        sessionId: 'sess-1',
        messageId: 'msg-2',
      });
    });

    it('relays error events with correct chat.error shape including code', () => {
      const { provider, fireError } = makeMockProvider();
      wireProviderToRelay(provider);

      const error = {
        code: 'RATE_LIMITED',
        message: 'Too many requests',
        recoverable: true,
      };

      fireError('sess-1', error);

      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith({
        type: TRANSPORT_EVENT.CHAT_ERROR,
        sessionId: 'sess-1',
        error: 'Too many requests',
        code: 'RATE_LIMITED',
      });
    });
  });

  // ── broadcastProviderStatus ─────────────────────────────────────────────

  describe('broadcastProviderStatus', () => {
    it('sends provider.status with correct shape', () => {
      broadcastProviderStatus('openclaw', true);

      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith({
        type: TRANSPORT_MSG.PROVIDER_STATUS,
        providerId: 'openclaw',
        connected: true,
      });
    });

    it('does nothing when sendToServer is not set', () => {
      // Clear the send function by setting a null-safe replacement,
      // then override to simulate "never called setTransportRelaySend".
      // The module guards with `if (!sendToServer)` so we need to set it
      // to something falsy. We use a cast to null to test the guard.
      setTransportRelaySend(null as unknown as (msg: Record<string, unknown>) => void);

      // Should not throw even though sendToServer is null.
      expect(() => broadcastProviderStatus('minimax', false)).not.toThrow();

      // The vi.fn() from beforeEach should not have been called.
      // (send was replaced by null via setTransportRelaySend)
      expect(send).not.toHaveBeenCalled();
    });
  });
});
