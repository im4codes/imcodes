/**
 * Tests for src/daemon/transport-relay.ts
 *
 * The relay was rewritten to emit through timelineEmitter (same bus as
 * CC/Codex/Gemini JSONL watchers) instead of sending raw WS messages.
 * These tests verify that wireProviderToRelay correctly maps provider
 * callbacks to timeline events, and that broadcastProviderStatus still
 * uses the sendToServer channel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks (must be hoisted before any imports) ───────────────────────

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: vi.fn(),
  },
}));

vi.mock('../../src/daemon/transport-history.js', () => ({
  appendTransportEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock resolveSessionName to return identity mapping (providerSid === sessionName for tests)
vi.mock('../../src/agent/session-manager.js', () => ({
  resolveSessionName: (providerSid: string) => providerSid,
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import {
  setTransportRelaySend,
  wireProviderToRelay,
  emitTransportUserMessage,
  broadcastProviderStatus,
} from '../../src/daemon/transport-relay.js';

import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { appendTransportEvent } from '../../src/daemon/transport-history.js';

import type { TransportProvider } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import { TRANSPORT_MSG } from '../../shared/transport-events.js';

// ── Mock provider factory ────────────────────────────────────────────────────

type DeltaCb = (sessionId: string, delta: MessageDelta) => void;
type CompleteCb = (sessionId: string, message: AgentMessage) => void;
type ErrorCb = (sessionId: string, error: { code: string; message: string; recoverable: boolean }) => void;

function makeMockProvider() {
  let deltaCb: DeltaCb | undefined;
  let completeCb: CompleteCb | undefined;
  let errorCb: ErrorCb | undefined;

  return {
    provider: {
      onDelta: (cb: DeltaCb) => { deltaCb = cb; return () => { deltaCb = undefined; }; },
      onComplete: (cb: CompleteCb) => { completeCb = cb; return () => { completeCb = undefined; }; },
      onError: (cb: ErrorCb) => { errorCb = cb; return () => { errorCb = undefined; }; },
    } as unknown as TransportProvider,
    fireDelta: (sid: string, delta: MessageDelta) => deltaCb?.(sid, delta),
    fireComplete: (sid: string, msg: AgentMessage) => completeCb?.(sid, msg),
    fireError: (sid: string, err: { code: string; message: string; recoverable: boolean }) => errorCb?.(sid, err),
  };
}

function makeDelta(overrides: Partial<MessageDelta> = {}): MessageDelta {
  return {
    messageId: 'msg-1',
    type: 'text',
    delta: 'hello ',
    role: 'assistant',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'msg-1',
    sessionId: 'sess-1',
    kind: 'text',
    role: 'assistant',
    content: 'hello world',
    timestamp: Date.now(),
    status: 'complete',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('transport-relay (timeline-emitter based)', () => {
  let send: ReturnType<typeof vi.fn>;
  let emitMock: ReturnType<typeof vi.fn>;
  let appendMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn();
    setTransportRelaySend(send);

    emitMock = vi.mocked(timelineEmitter.emit);
    appendMock = vi.mocked(appendTransportEvent);
    emitMock.mockClear();
    appendMock.mockClear();
  });

  afterEach(() => {
    setTransportRelaySend(() => {});
  });

  // ── wireProviderToRelay — onDelta ────────────────────────────────────────

  describe('onDelta', () => {
    it('accumulates text and emits assistant.text with streaming true', () => {
      const { provider, fireDelta } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-a', makeDelta({ messageId: 'msg-x', delta: 'hi ' }));

      expect(emitMock).toHaveBeenCalledOnce();
      const [sessionId, type, payload] = emitMock.mock.calls[0];
      expect(sessionId).toBe('sess-a');
      expect(type).toBe('assistant.text');
      expect(payload.streaming).toBe(true);
      expect(payload.text).toBe('hi ');
    });

    it('uses stable eventId format transport:{sessionId}:{messageId}', () => {
      const { provider, fireDelta } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-a', makeDelta({ messageId: 'msg-abc', delta: 'yo' }));

      const opts = emitMock.mock.calls[0][3];
      expect(opts.eventId).toBe('transport:sess-a:msg-abc');
    });

    it('multiple deltas accumulate text correctly', () => {
      const { provider, fireDelta } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-a', makeDelta({ messageId: 'msg-1', delta: 'foo ' }));
      fireDelta('sess-a', makeDelta({ messageId: 'msg-1', delta: 'bar ' }));
      fireDelta('sess-a', makeDelta({ messageId: 'msg-1', delta: 'baz' }));

      expect(emitMock).toHaveBeenCalledTimes(3);

      // First delta: "foo "
      expect(emitMock.mock.calls[0][2].text).toBe('foo ');
      // Second delta: "foo bar "
      expect(emitMock.mock.calls[1][2].text).toBe('foo bar ');
      // Third delta: "foo bar baz"
      expect(emitMock.mock.calls[2][2].text).toBe('foo bar baz');
    });

    it('uses the same stable eventId across multiple deltas for the same message', () => {
      const { provider, fireDelta } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-a', makeDelta({ messageId: 'msg-stable', delta: 'a' }));
      fireDelta('sess-a', makeDelta({ messageId: 'msg-stable', delta: 'b' }));

      const id1 = emitMock.mock.calls[0][3].eventId;
      const id2 = emitMock.mock.calls[1][3].eventId;
      expect(id1).toBe('transport:sess-a:msg-stable');
      expect(id2).toBe('transport:sess-a:msg-stable');
    });

    it('does NOT cache to JSONL via appendTransportEvent', () => {
      const { provider, fireDelta } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-a', makeDelta({ messageId: 'msg-1', delta: 'hello' }));

      expect(appendMock).not.toHaveBeenCalled();
    });

    it('does NOT call sendToServer', () => {
      const { provider, fireDelta } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-a', makeDelta({ messageId: 'msg-1', delta: 'hello' }));

      expect(send).not.toHaveBeenCalled();
    });

    it('keeps separate accumulators for different sessions', () => {
      const { provider, fireDelta } = makeMockProvider();
      wireProviderToRelay(provider);

      // Use unique messageIds to avoid accumulator bleed from prior tests
      fireDelta('sess-aa', makeDelta({ messageId: 'msg-separate-a', delta: 'A' }));
      fireDelta('sess-bb', makeDelta({ messageId: 'msg-separate-b', delta: 'B' }));

      // sess-aa accumulator should only have 'A', sess-bb only 'B'
      const sessACall = emitMock.mock.calls.find(c => c[0] === 'sess-aa');
      const sessBCall = emitMock.mock.calls.find(c => c[0] === 'sess-bb');
      expect(sessACall![2].text).toBe('A');
      expect(sessBCall![2].text).toBe('B');
    });
  });

  // ── wireProviderToRelay — onComplete ─────────────────────────────────────

  describe('onComplete', () => {
    it('emits assistant.text with streaming false and final accumulated text', () => {
      const { provider, fireDelta, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-1', makeDelta({ messageId: 'msg-2', delta: 'part1 ' }));
      fireDelta('sess-1', makeDelta({ messageId: 'msg-2', delta: 'part2' }));
      emitMock.mockClear();

      fireComplete('sess-1', makeMessage({ id: 'msg-2', content: 'fallback' }));

      const textCall = emitMock.mock.calls.find(c => c[1] === 'assistant.text');
      expect(textCall).toBeDefined();
      expect(textCall![2].streaming).toBe(false);
      // Should use accumulated text, not message.content fallback
      expect(textCall![2].text).toBe('part1 part2');
    });

    it('falls back to message.content when no accumulator exists', () => {
      const { provider, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireComplete('sess-1', makeMessage({ id: 'msg-no-acc', content: 'direct content' }));

      const textCall = emitMock.mock.calls.find(c => c[1] === 'assistant.text');
      expect(textCall![2].text).toBe('direct content');
      expect(textCall![2].streaming).toBe(false);
    });

    it('emits session.state idle after the assistant.text event', () => {
      const { provider, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireComplete('sess-1', makeMessage({ id: 'msg-3' }));

      const stateCall = emitMock.mock.calls.find(c => c[1] === 'session.state');
      expect(stateCall).toBeDefined();
      expect(stateCall![2].state).toBe('idle');

      // session.state must be emitted AFTER assistant.text
      const textIdx = emitMock.mock.calls.findIndex(c => c[1] === 'assistant.text');
      const stateIdx = emitMock.mock.calls.findIndex(c => c[1] === 'session.state');
      expect(stateIdx).toBeGreaterThan(textIdx);
    });

    it('uses the same stable eventId as the streaming deltas', () => {
      const { provider, fireDelta, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-1', makeDelta({ messageId: 'msg-4', delta: 'hi' }));
      const deltaEventId = emitMock.mock.calls[0][3].eventId;
      emitMock.mockClear();

      fireComplete('sess-1', makeMessage({ id: 'msg-4' }));

      const textCall = emitMock.mock.calls.find(c => c[1] === 'assistant.text');
      expect(textCall![3].eventId).toBe(deltaEventId);
      expect(textCall![3].eventId).toBe('transport:sess-1:msg-4');
    });

    it('caches to JSONL via appendTransportEvent with type assistant.text', async () => {
      const { provider, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireComplete('sess-1', makeMessage({ id: 'msg-5', content: 'done' }));

      // appendTransportEvent is called with void (fire-and-forget), wait a tick
      await Promise.resolve();

      expect(appendMock).toHaveBeenCalledOnce();
      const [sessionId, event] = appendMock.mock.calls[0];
      expect(sessionId).toBe('sess-1');
      expect(event.type).toBe('assistant.text');
      expect(event.sessionId).toBe('sess-1');
      expect(typeof event.text).toBe('string');
    });

    it('clears the accumulator after completion (no leak to next message)', () => {
      const { provider, fireDelta, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-1', makeDelta({ messageId: 'msg-6', delta: 'first' }));
      fireComplete('sess-1', makeMessage({ id: 'msg-6' }));
      emitMock.mockClear();

      // New message same id starts fresh
      fireDelta('sess-1', makeDelta({ messageId: 'msg-6', delta: 'new' }));

      const textCall = emitMock.mock.calls.find(c => c[1] === 'assistant.text');
      // After completion, the accumulator was deleted — new delta starts from scratch
      expect(textCall![2].text).toBe('new');
    });
  });

  // ── wireProviderToRelay — onError ────────────────────────────────────────

  describe('onError', () => {
    it('emits session.state idle with error message', () => {
      const { provider, fireError } = makeMockProvider();
      wireProviderToRelay(provider);

      fireError('sess-err', { code: 'RATE_LIMITED', message: 'Too many requests', recoverable: true });

      expect(emitMock).toHaveBeenCalledOnce();
      const [sessionId, type, payload] = emitMock.mock.calls[0];
      expect(sessionId).toBe('sess-err');
      expect(type).toBe('session.state');
      expect(payload.state).toBe('idle');
      expect(payload.error).toBe('Too many requests');
    });

    it('caches to JSONL via appendTransportEvent with type session.error', async () => {
      const { provider, fireError } = makeMockProvider();
      wireProviderToRelay(provider);

      fireError('sess-err', { code: 'PROVIDER_ERROR', message: 'Provider down', recoverable: false });

      await Promise.resolve();

      expect(appendMock).toHaveBeenCalledOnce();
      const [sessionId, event] = appendMock.mock.calls[0];
      expect(sessionId).toBe('sess-err');
      expect(event.type).toBe('session.error');
      expect(event.error).toBe('Provider down');
      expect(event.code).toBe('PROVIDER_ERROR');
    });

    it('does NOT call sendToServer', () => {
      const { provider, fireError } = makeMockProvider();
      wireProviderToRelay(provider);

      fireError('sess-err', { code: 'AUTH_FAILED', message: 'Bad token', recoverable: false });

      expect(send).not.toHaveBeenCalled();
    });
  });

  // ── emitTransportUserMessage ─────────────────────────────────────────────

  describe('emitTransportUserMessage', () => {
    it('emits user.message through timeline emitter', () => {
      emitTransportUserMessage('sess-u', 'hello from user');

      const userMsgCall = emitMock.mock.calls.find(c => c[1] === 'user.message');
      expect(userMsgCall).toBeDefined();
      expect(userMsgCall![0]).toBe('sess-u');
      expect(userMsgCall![2].text).toBe('hello from user');
    });

    it('caches user.message to JSONL via appendTransportEvent', async () => {
      emitTransportUserMessage('sess-u', 'cached message');

      await Promise.resolve();

      expect(appendMock).toHaveBeenCalledOnce();
      const [sessionId, event] = appendMock.mock.calls[0];
      expect(sessionId).toBe('sess-u');
      expect(event.type).toBe('user.message');
      expect(event.text).toBe('cached message');
      expect(event.sessionId).toBe('sess-u');
    });

    it('emits with daemon source and high confidence', () => {
      emitTransportUserMessage('sess-u', 'test');

      const call = emitMock.mock.calls.find(c => c[1] === 'user.message');
      const opts = call![3];
      expect(opts.source).toBe('daemon');
      expect(opts.confidence).toBe('high');
    });
  });

  // ── broadcastProviderStatus ──────────────────────────────────────────────

  describe('broadcastProviderStatus', () => {
    it('sends provider.status with correct shape via sendToServer', () => {
      broadcastProviderStatus('openclaw', true);

      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith({
        type: TRANSPORT_MSG.PROVIDER_STATUS,
        providerId: 'openclaw',
        connected: true,
      });
    });

    it('sends connected: false correctly', () => {
      broadcastProviderStatus('minimax', false);

      expect(send).toHaveBeenCalledWith({
        type: TRANSPORT_MSG.PROVIDER_STATUS,
        providerId: 'minimax',
        connected: false,
      });
    });

    it('does nothing when sendToServer is not set', () => {
      setTransportRelaySend(null as unknown as (msg: Record<string, unknown>) => void);

      expect(() => broadcastProviderStatus('minimax', false)).not.toThrow();
      expect(send).not.toHaveBeenCalled();
    });

    it('does NOT emit through timelineEmitter', () => {
      broadcastProviderStatus('openclaw', true);

      expect(emitMock).not.toHaveBeenCalled();
    });
  });
});

// ── useTimeline same-ID replacement (logic extracted for unit testing) ───────
//
// NOTE: The actual `useTimeline` hook (web/src/hooks/useTimeline.ts) is tested
// in a jsdom environment through web/test/. However, the same-eventId replacement
// logic it uses (appendEvent) can be tested here as a pure function to verify
// the core invariant: an event with an existing eventId replaces the prior version
// rather than being appended as a duplicate.

describe('same-eventId replacement semantics (appendEvent logic)', () => {
  /** Reproduces the appendEvent function from useTimeline */
  function appendEvent(
    prev: Array<{ eventId: string; payload: Record<string, unknown> }>,
    event: { eventId: string; payload: Record<string, unknown> },
  ) {
    // Fast path: check last 10 events for same-ID replacement
    for (let i = prev.length - 1; i >= Math.max(0, prev.length - 10); i--) {
      if (prev[i].eventId === event.eventId) {
        const updated = [...prev];
        updated[i] = event;
        return updated;
      }
    }
    return [...prev, event];
  }

  it('replaces an existing event when eventId matches (streaming typewriter effect)', () => {
    const initial = [
      { eventId: 'transport:sess:msg-1', payload: { text: 'hello ', streaming: true } },
    ];
    const updated = appendEvent(initial, {
      eventId: 'transport:sess:msg-1',
      payload: { text: 'hello world', streaming: true },
    });

    expect(updated).toHaveLength(1);
    expect(updated[0].payload.text).toBe('hello world');
  });

  it('replaces streaming event with final (streaming: false) event at same position', () => {
    const initial = [
      { eventId: 'other-evt', payload: { text: 'previous' } },
      { eventId: 'transport:sess:msg-1', payload: { text: 'partial', streaming: true } },
    ];
    const final = appendEvent(initial, {
      eventId: 'transport:sess:msg-1',
      payload: { text: 'complete answer', streaming: false },
    });

    expect(final).toHaveLength(2);
    expect(final[1].payload.text).toBe('complete answer');
    expect(final[1].payload.streaming).toBe(false);
    // The event stays at the same index — does not move to end
    expect(final[0].eventId).toBe('other-evt');
  });

  it('appends a new event when eventId is not in the last 10 events', () => {
    const initial = [
      { eventId: 'evt-a', payload: { text: 'a' } },
    ];
    const result = appendEvent(initial, {
      eventId: 'evt-b',
      payload: { text: 'b' },
    });

    expect(result).toHaveLength(2);
    expect(result[1].eventId).toBe('evt-b');
  });

  it('does not duplicate when same eventId arrives multiple times', () => {
    const stableId = 'transport:sess:msg-stream';
    let state: Array<{ eventId: string; payload: Record<string, unknown> }> = [];

    state = appendEvent(state, { eventId: stableId, payload: { text: 'a', streaming: true } });
    state = appendEvent(state, { eventId: stableId, payload: { text: 'ab', streaming: true } });
    state = appendEvent(state, { eventId: stableId, payload: { text: 'abc', streaming: false } });

    expect(state).toHaveLength(1);
    expect(state[0].payload.text).toBe('abc');
    expect(state[0].payload.streaming).toBe(false);
  });

  it('appends a new event with a different eventId after a streaming sequence', () => {
    const stableId = 'transport:sess:msg-1';
    let state: Array<{ eventId: string; payload: Record<string, unknown> }> = [];

    state = appendEvent(state, { eventId: stableId, payload: { text: 'hello', streaming: false } });
    state = appendEvent(state, {
      eventId: 'transport:sess:msg-2',
      payload: { text: 'new message', streaming: true },
    });

    expect(state).toHaveLength(2);
    expect(state[0].eventId).toBe(stableId);
    expect(state[1].eventId).toBe('transport:sess:msg-2');
  });
});
