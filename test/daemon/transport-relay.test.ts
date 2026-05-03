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

const getSessionMock = vi.hoisted(() => vi.fn());

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

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
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
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../shared/agent-message.js';
import { TRANSPORT_EVENT, TRANSPORT_MSG } from '../../shared/transport-events.js';

// ── Mock provider factory ────────────────────────────────────────────────────

type DeltaCb = (sessionId: string, delta: MessageDelta) => void;
type CompleteCb = (sessionId: string, message: AgentMessage) => void;
type ErrorCb = (sessionId: string, error: { code: string; message: string; recoverable: boolean }) => void;
type ToolCb = (sessionId: string, tool: ToolCallEvent) => void;
type StatusCb = (sessionId: string, status: { status: string | null; label?: string | null }) => void;
type UsageCb = (sessionId: string, update: { usage?: Record<string, unknown>; model?: string }) => void;
type ApprovalCb = (sessionId: string, request: { id: string; description: string; tool?: string }) => void;

function makeMockProvider() {
  let deltaCb: DeltaCb | undefined;
  let completeCb: CompleteCb | undefined;
  let errorCb: ErrorCb | undefined;
  let toolCb: ToolCb | undefined;
  let statusCb: StatusCb | undefined;
  let usageCb: UsageCb | undefined;
  let approvalCb: ApprovalCb | undefined;

  return {
    provider: {
      onDelta: (cb: DeltaCb) => { deltaCb = cb; return () => { deltaCb = undefined; }; },
      onComplete: (cb: CompleteCb) => { completeCb = cb; return () => { completeCb = undefined; }; },
      onError: (cb: ErrorCb) => { errorCb = cb; return () => { errorCb = undefined; }; },
      onToolCall: (cb: ToolCb) => { toolCb = cb; },
      onStatus: (cb: StatusCb) => { statusCb = cb; return () => { statusCb = undefined; }; },
      onUsage: (cb: UsageCb) => { usageCb = cb; return () => { usageCb = undefined; }; },
      onApprovalRequest: (cb: ApprovalCb) => { approvalCb = cb; },
    } as unknown as TransportProvider,
    fireDelta: (sid: string, delta: MessageDelta) => deltaCb?.(sid, delta),
    fireComplete: (sid: string, msg: AgentMessage) => completeCb?.(sid, msg),
    fireError: (sid: string, err: { code: string; message: string; recoverable: boolean }) => errorCb?.(sid, err),
    fireTool: (sid: string, tool: ToolCallEvent) => toolCb?.(sid, tool),
    fireStatus: (sid: string, status: { status: string | null; label?: string | null }) => statusCb?.(sid, status),
    fireUsage: (sid: string, update: { usage?: Record<string, unknown>; model?: string }) => usageCb?.(sid, update),
    fireApproval: (sid: string, request: { id: string; description: string; tool?: string }) => approvalCb?.(sid, request),
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
    getSessionMock.mockReset();
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

    it('throttles streaming updates to at most one emit every 40ms and keeps the latest text', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-08T00:00:00.000Z'));

      const { provider, fireDelta } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-a', makeDelta({ messageId: 'msg-throttle', delta: 'a' }));
      fireDelta('sess-a', makeDelta({ messageId: 'msg-throttle', delta: 'ab' }));
      fireDelta('sess-a', makeDelta({ messageId: 'msg-throttle', delta: 'abc' }));

      expect(emitMock).toHaveBeenCalledTimes(1);
      expect(emitMock.mock.calls[0][2].text).toBe('a');

      vi.advanceTimersByTime(39);
      expect(emitMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(emitMock).toHaveBeenCalledTimes(2);
      expect(emitMock.mock.calls[1][2].text).toBe('abc');

      vi.useRealTimers();
    });

    it('does not let a new message flush an old throttled delta later', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-08T00:00:00.000Z'));

      const { provider, fireDelta } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-a', makeDelta({ messageId: 'msg-old', delta: 'old-a' }));
      fireDelta('sess-a', makeDelta({ messageId: 'msg-old', delta: 'old-ab' }));
      fireDelta('sess-a', makeDelta({ messageId: 'msg-new', delta: 'new-a' }));

      expect(emitMock.mock.calls.filter(c => c[1] === 'assistant.text')).toHaveLength(2);
      expect(emitMock.mock.calls[0][2].text).toBe('old-a');
      expect(emitMock.mock.calls[1][2].text).toBe('new-a');

      vi.advanceTimersByTime(500);
      const textCalls = emitMock.mock.calls.filter(c => c[1] === 'assistant.text');
      expect(textCalls).toHaveLength(2);
      expect(textCalls.map(c => c[2].text)).not.toContain('old-ab');

      vi.useRealTimers();
    });

    it('throttles independently per session', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-08T00:00:00.000Z'));

      const { provider, fireDelta } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-a', makeDelta({ messageId: 'msg-a', delta: 'A1' }));
      fireDelta('sess-a', makeDelta({ messageId: 'msg-a', delta: 'A2' }));
      fireDelta('sess-b', makeDelta({ messageId: 'msg-b', delta: 'B1' }));
      fireDelta('sess-b', makeDelta({ messageId: 'msg-b', delta: 'B2' }));

      expect(emitMock.mock.calls.filter(c => c[1] === 'assistant.text')).toHaveLength(2);
      vi.advanceTimersByTime(40);

      const textCalls = emitMock.mock.calls.filter(c => c[1] === 'assistant.text');
      expect(textCalls).toHaveLength(4);
      expect(textCalls.filter(c => c[0] === 'sess-a').map(c => c[2].text)).toEqual(['A1', 'A2']);
      expect(textCalls.filter(c => c[0] === 'sess-b').map(c => c[2].text)).toEqual(['B1', 'B2']);

      vi.useRealTimers();
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
    it('emits assistant.text with streaming false and uses message.content for final text', () => {
      const { provider, fireDelta, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-1', makeDelta({ messageId: 'msg-2', delta: 'part1 ' }));
      fireDelta('sess-1', makeDelta({ messageId: 'msg-2', delta: 'part2' }));
      emitMock.mockClear();

      fireComplete('sess-1', makeMessage({ id: 'msg-2', content: 'part1 part2' }));

      const textCall = emitMock.mock.calls.find(c => c[1] === 'assistant.text');
      expect(textCall).toBeDefined();
      expect(textCall![2].streaming).toBe(false);
      // Uses message.content as authoritative final text
      expect(textCall![2].text).toBe('part1 part2');
    });

    it('emits usage.update using current usage semantics when completion metadata includes model and usage', () => {
      const { provider, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireComplete('sess-1', makeMessage({
        id: 'msg-usage',
        metadata: {
          model: 'qwen3-coder-plus',
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 15,
            cache_read_input_tokens: 5,
          },
        },
      }));

      const usageCall = emitMock.mock.calls.find(c => c[1] === 'usage.update');
      expect(usageCall).toBeDefined();
      expect(usageCall![2]).toMatchObject({
        inputTokens: 115,
        cacheTokens: 5,
        model: 'qwen3-coder-plus',
      });
    });

    it('emits Codex SDK current-window context usage instead of cumulative billing usage', () => {
      const { provider, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireComplete('sess-1', makeMessage({
        id: 'msg-codex-usage',
        metadata: {
          model: 'gpt-5.4-mini',
          usage: {
            // CodexSdkProvider normalizes app-server tokenUsage.last into the
            // provider-neutral fields and keeps tokenUsage.total only as diagnostics.
            input_tokens: 9_000,
            cached_input_tokens: 3_000,
            cache_read_input_tokens: 3_000,
            output_tokens: 200,
            model_context_window: 258_400,
            codex_total_input_tokens: 140_000,
            codex_last_input_tokens: 12_000,
            codex_last_cached_input_tokens: 3_000,
          },
        },
      }));

      const usageCall = emitMock.mock.calls.find(c => c[1] === 'usage.update');
      expect(usageCall).toBeDefined();
      expect(usageCall![2]).toMatchObject({
        inputTokens: 9_000,
        cacheTokens: 3_000,
        model: 'gpt-5.4-mini',
        contextWindow: 258_400,
        contextWindowSource: 'provider',
      });
      expect(Number(usageCall![2].inputTokens) + Number(usageCall![2].cacheTokens)).toBe(12_000);
    });

    it('emits provider usage updates even when they arrive outside message completion', () => {
      const { provider, fireUsage } = makeMockProvider();
      wireProviderToRelay(provider);

      fireUsage('sess-1', {
        model: 'gpt-5.5',
        usage: {
          input_tokens: 42_000,
          cache_read_input_tokens: 8_000,
          cached_input_tokens: 8_000,
          model_context_window: 258_400,
        },
      });

      const usageCall = emitMock.mock.calls.find(c => c[1] === 'usage.update');
      expect(usageCall).toBeDefined();
      expect(usageCall![2]).toMatchObject({
        inputTokens: 42_000,
        cacheTokens: 8_000,
        model: 'gpt-5.5',
        contextWindow: 258_400,
        contextWindowSource: 'provider',
      });
    });

    it('honors Codex SDK provider effective window for GPT-5.5', () => {
      const { provider, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireComplete('sess-1', makeMessage({
        id: 'msg-codex-gpt55-usage',
        metadata: {
          model: 'gpt-5.5',
          usage: {
            input_tokens: 9_000,
            cached_input_tokens: 3_000,
            cache_read_input_tokens: 3_000,
            model_context_window: 258_400,
          },
        },
      }));

      const usageCall = emitMock.mock.calls.find(c => c[1] === 'usage.update');
      expect(usageCall).toBeDefined();
      expect(usageCall![2]).toMatchObject({
        inputTokens: 9_000,
        cacheTokens: 3_000,
        model: 'gpt-5.5',
        contextWindow: 258_400,
        contextWindowSource: 'provider',
      });
    });

    it('honors Codex SDK provider 1M context window when reported for GPT-5.5', () => {
      const { provider, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireComplete('sess-1', makeMessage({
        id: 'msg-codex-gpt55-usage-1m',
        metadata: {
          model: 'gpt-5.5',
          usage: {
            input_tokens: 9_000,
            cached_input_tokens: 3_000,
            cache_read_input_tokens: 3_000,
            model_context_window: 1_000_000,
          },
        },
      }));

      const usageCall = emitMock.mock.calls.find(c => c[1] === 'usage.update');
      expect(usageCall).toBeDefined();
      expect(usageCall![2]).toMatchObject({
        inputTokens: 9_000,
        cacheTokens: 3_000,
        model: 'gpt-5.5',
        contextWindow: 1_000_000,
        contextWindowSource: 'provider',
      });
    });

    it('uses the stored session model when Codex SDK usage omits model and honors 258k provider window for GPT-5.5', () => {
      getSessionMock.mockReturnValue({
        name: 'sess-1',
        activeModel: 'gpt-5.5',
      });
      const { provider, fireUsage } = makeMockProvider();
      wireProviderToRelay(provider);

      fireUsage('sess-1', {
        usage: {
          input_tokens: 185_000,
          cached_input_tokens: 5_000,
          model_context_window: 258_400,
        },
      });

      const usageCall = emitMock.mock.calls.find(c => c[1] === 'usage.update');
      expect(usageCall).toBeDefined();
      expect(usageCall![2]).toMatchObject({
        inputTokens: 185_000,
        cacheTokens: 5_000,
        model: 'gpt-5.5',
        contextWindow: 258_400,
        contextWindowSource: 'provider',
      });
    });

    it('uses the stored session model when usage omits both model and provider context window, using the API input-budget fallback for GPT-5.5', () => {
      getSessionMock.mockReturnValue({
        name: 'sess-1',
        modelDisplay: 'gpt-5.5',
      });
      const { provider, fireUsage } = makeMockProvider();
      wireProviderToRelay(provider);

      fireUsage('sess-1', {
        usage: {
          input_tokens: 9_000,
          cached_input_tokens: 0,
        },
      });

      const usageCall = emitMock.mock.calls.find(c => c[1] === 'usage.update');
      expect(usageCall).toBeDefined();
      expect(usageCall![2]).toMatchObject({
        inputTokens: 9_000,
        cacheTokens: 0,
        model: 'gpt-5.5',
        contextWindow: 922_000,
      });
    });

    it('uses the same stored session model fallback for non-GPT-5.5 models when usage omits model', () => {
      getSessionMock.mockReturnValue({
        name: 'sess-1',
        activeModel: 'qwen3-coder-next',
      });
      const { provider, fireUsage } = makeMockProvider();
      wireProviderToRelay(provider);

      fireUsage('sess-1', {
        usage: {
          input_tokens: 12_000,
          cached_input_tokens: 2_000,
        },
      });

      const usageCall = emitMock.mock.calls.find(c => c[1] === 'usage.update');
      expect(usageCall).toBeDefined();
      expect(usageCall![2]).toMatchObject({
        inputTokens: 12_000,
        cacheTokens: 2_000,
        model: 'qwen3-coder-next',
        contextWindow: 262_144,
      });
    });

    it('falls back to message.content when no accumulator exists', () => {
      const { provider, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireComplete('sess-1', makeMessage({ id: 'msg-no-acc', content: 'direct content' }));

      const textCall = emitMock.mock.calls.find(c => c[1] === 'assistant.text');
      expect(textCall![2].text).toBe('direct content');
      expect(textCall![2].streaming).toBe(false);
    });

    it('does not emit session.state on complete; runtime owns lifecycle transitions', () => {
      const { provider, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireComplete('sess-1', makeMessage({ id: 'msg-3' }));

      expect(emitMock.mock.calls.some(c => c[1] === 'session.state')).toBe(false);
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

    it('emits final completion immediately even when a throttled delta is pending', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-08T00:00:00.000Z'));

      const { provider, fireDelta, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-1', makeDelta({ messageId: 'msg-final', delta: 'a' }));
      fireDelta('sess-1', makeDelta({ messageId: 'msg-final', delta: 'ab' }));
      emitMock.mockClear();

      fireComplete('sess-1', makeMessage({ id: 'msg-final', content: 'final answer' }));

      const textCalls = emitMock.mock.calls.filter(c => c[1] === 'assistant.text');
      expect(textCalls).toHaveLength(1);
      expect(textCalls[0][2].text).toBe('final answer');
      expect(textCalls[0][2].streaming).toBe(false);

      vi.advanceTimersByTime(500);
      expect(emitMock.mock.calls.filter(c => c[1] === 'assistant.text')).toHaveLength(1);

      vi.useRealTimers();
    });

    it('completion still emits immediately when another session has a pending throttled delta', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-08T00:00:00.000Z'));

      const { provider, fireDelta, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-a', makeDelta({ messageId: 'msg-a', delta: 'A1' }));
      fireDelta('sess-a', makeDelta({ messageId: 'msg-a', delta: 'A2' }));
      emitMock.mockClear();

      fireComplete('sess-b', makeMessage({ id: 'msg-b', sessionId: 'sess-b', content: 'done-b' }));

      const textCalls = emitMock.mock.calls.filter(c => c[1] === 'assistant.text');
      expect(textCalls).toHaveLength(1);
      expect(textCalls[0][0]).toBe('sess-b');
      expect(textCalls[0][2].text).toBe('done-b');
      expect(textCalls[0][2].streaming).toBe(false);

      vi.useRealTimers();
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
    it('emits assistant.text with warning prefix before session.state', () => {
      const { provider, fireError } = makeMockProvider();
      wireProviderToRelay(provider);

      fireError('sess-err', { code: 'RATE_LIMITED', message: 'Too many requests', recoverable: true });

      // Should emit 2 timeline events: assistant.text + session.state
      const timelineCalls = emitMock.mock.calls;
      expect(timelineCalls.length).toBeGreaterThanOrEqual(2);

      // First emit: assistant.text with the warning message
      const textCall = timelineCalls.find(c => c[1] === 'assistant.text');
      expect(textCall).toBeDefined();
      expect(textCall![0]).toBe('sess-err');
      expect(textCall![2].text).toBe('⚠️ Error: Too many requests');
      expect(textCall![2].streaming).toBe(false);
    });

    it('emits session.state idle with error message', () => {
      const { provider, fireError } = makeMockProvider();
      wireProviderToRelay(provider);

      fireError('sess-err', { code: 'RATE_LIMITED', message: 'Too many requests', recoverable: true });

      const stateCall = emitMock.mock.calls.find(c => c[1] === 'session.state');
      expect(stateCall).toBeDefined();
      expect(stateCall![0]).toBe('sess-err');
      expect(stateCall![2].state).toBe('idle');
      expect(stateCall![2].error).toBe('Too many requests');
    });

    it('emits assistant.text BEFORE session.state (order matters for UI)', () => {
      const { provider, fireError } = makeMockProvider();
      wireProviderToRelay(provider);

      fireError('sess-err', { code: 'PROVIDER_ERROR', message: 'Overloaded', recoverable: true });

      const textIdx = emitMock.mock.calls.findIndex(c => c[1] === 'assistant.text');
      const stateIdx = emitMock.mock.calls.findIndex(c => c[1] === 'session.state');
      expect(textIdx).toBeGreaterThanOrEqual(0);
      expect(stateIdx).toBeGreaterThan(textIdx);
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

    it('includes error message in the warning text for different error types', () => {
      const { provider, fireError } = makeMockProvider();
      wireProviderToRelay(provider);

      fireError('sess-ai', { code: 'PROVIDER_ERROR', message: 'AI service overloaded', recoverable: true });

      const textCall = emitMock.mock.calls.find(c => c[1] === 'assistant.text');
      expect(textCall![2].text).toBe('⚠️ Error: AI service overloaded');
    });

    it('reuses the streaming eventId on error and preserves partial text', () => {
      const { provider, fireDelta, fireError } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-err', makeDelta({ messageId: 'msg-err', delta: 'partial answer' }));
      const deltaEventId = emitMock.mock.calls[0][3].eventId;
      emitMock.mockClear();

      fireError('sess-err', { code: 'PROVIDER_ERROR', message: 'boom', recoverable: true });

      const textCall = emitMock.mock.calls.find(c => c[1] === 'assistant.text');
      expect(textCall?.[3]?.eventId).toBe(deltaEventId);
      expect(textCall?.[2]?.streaming).toBe(false);
      expect(textCall?.[2]?.text).toBe('partial answer\n\n⚠️ Error: boom');
    });

    it('emits error immediately even when a throttled delta is pending and suppresses the delayed flush', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-08T00:00:00.000Z'));

      const { provider, fireDelta, fireError } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-err', makeDelta({ messageId: 'msg-err-2', delta: 'partial' }));
      fireDelta('sess-err', makeDelta({ messageId: 'msg-err-2', delta: 'partial+' }));
      emitMock.mockClear();

      fireError('sess-err', { code: 'PROVIDER_ERROR', message: 'boom-now', recoverable: true });

      const textCalls = emitMock.mock.calls.filter(c => c[1] === 'assistant.text');
      expect(textCalls).toHaveLength(1);
      expect(textCalls[0][2].text).toBe('partial+\n\n⚠️ Error: boom-now');
      expect(textCalls[0][2].streaming).toBe(false);

      vi.advanceTimersByTime(500);
      expect(emitMock.mock.calls.filter(c => c[1] === 'assistant.text')).toHaveLength(1);

      vi.useRealTimers();
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

  describe('onToolCall', () => {
    it('emits tool.call for running tools with stable eventId', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      fireTool('sess-tool', {
        id: 'tool-1',
        name: 'list_directory',
        status: 'running',
        input: { path: '/tmp' },
        detail: { kind: 'tool_use', input: { path: '/tmp' } },
      });

      const call = emitMock.mock.calls.find((c) => c[1] === 'tool.call');
      expect(call).toBeDefined();
      expect(call![0]).toBe('sess-tool');
      expect(call![2]).toEqual({ tool: 'list_directory', input: { path: '/tmp' }, detail: { kind: 'tool_use', input: { path: '/tmp' } } });
      expect(call![3].eventId).toBe('transport-tool:sess-tool:tool-1:call');
    });

    it('emits tool.result for completed tools with stable eventId', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      fireTool('sess-tool', {
        id: 'tool-1',
        name: 'list_directory',
        status: 'complete',
        output: 'done',
        detail: { kind: 'tool_result', output: 'done' },
      });

      const call = emitMock.mock.calls.find((c) => c[1] === 'tool.result');
      expect(call).toBeDefined();
      expect(call![0]).toBe('sess-tool');
      expect(call![2]).toEqual({ output: 'done', detail: { kind: 'tool_result', output: 'done' } });
      expect(call![3].eventId).toBe('transport-tool:sess-tool:tool-1:result');
    });

    it('normalizes codex-sdk fileChange payloads into hidden raw events plus file.change', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      fireTool('sess-codex', {
        id: 'tool-codex-1',
        name: 'fileChange',
        status: 'complete',
        detail: {
          kind: 'fileChange',
          input: {
            changes: [
              { path: 'src/a.ts', op: 'update', beforeText: 'a', afterText: 'b' },
              { path: 'src/b.ts', op: 'create', content: 'new file' },
            ],
          },
        },
      });

      const fileChange = emitMock.mock.calls.find((c) => c[1] === 'file.change');
      expect(fileChange).toBeDefined();
      expect(fileChange![0]).toBe('sess-codex');
      expect(fileChange![2].batch.provider).toBe('codex-sdk');
      expect(fileChange![2].batch.patches).toHaveLength(2);

      const toolCalls = emitMock.mock.calls.filter((c) => c[1] === 'tool.call');
      const toolResults = emitMock.mock.calls.filter((c) => c[1] === 'tool.result');
      expect(toolCalls[0][3].hidden).toBe(true);
      expect(toolResults[0][3].hidden).toBe(true);
      expect(appendMock).toHaveBeenCalled();
      expect(appendMock.mock.calls[0][1].hidden).toBe(true);
    });

    it('normalizes qwen structured write tools only when a stable file path exists', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      fireTool('sess-qwen', {
        id: 'tool-qwen-1',
        name: 'Write',
        status: 'complete',
        input: { file_path: 'src/qwen.ts', content: 'console.log(1);' },
        detail: { kind: 'tool_use', input: { file_path: 'src/qwen.ts', content: 'console.log(1);' } },
      });

      expect(emitMock.mock.calls.some((c) => c[1] === 'file.change')).toBe(true);
      const fileChange = emitMock.mock.calls.find((c) => c[1] === 'file.change');
      expect(fileChange![2].batch.provider).toBe('qwen');
      expect(fileChange![2].batch.patches[0]).toEqual(expect.objectContaining({
        filePath: 'src/qwen.ts',
        confidence: 'derived',
      }));
      expect(emitMock.mock.calls.find((c) => c[1] === 'tool.call')?.[3].hidden).toBe(true);
      expect(emitMock.mock.calls.find((c) => c[1] === 'tool.result')?.[3].hidden).toBe(true);
    });

    it('defers file-like transport tools until terminal success instead of rendering a visible running row', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      fireTool('sess-qwen', {
        id: 'tool-qwen-2',
        name: 'Write',
        status: 'running',
        input: { file_path: 'src/qwen.ts', content: 'console.log(1);' },
        detail: { kind: 'tool_use', input: { file_path: 'src/qwen.ts', content: 'console.log(1);' } },
      });

      expect(emitMock).not.toHaveBeenCalled();

      fireTool('sess-qwen', {
        id: 'tool-qwen-2',
        name: 'Write',
        status: 'complete',
        output: 'ok',
        detail: { kind: 'tool_result', output: 'ok' },
      });

      expect(emitMock.mock.calls.find((c) => c[1] === 'file.change')).toBeDefined();
      expect(emitMock.mock.calls.find((c) => c[1] === 'tool.call')?.[3]?.hidden).toBe(true);
      expect(emitMock.mock.calls.find((c) => c[1] === 'tool.result')?.[3]?.hidden).toBe(true);
    });

    it('falls back to visible raw rows when a deferred file-like transport tool ends in error', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      fireTool('sess-qwen', {
        id: 'tool-qwen-3',
        name: 'Write',
        status: 'running',
        input: { file_path: 'src/qwen.ts', content: 'console.log(1);' },
        detail: { kind: 'tool_use', input: { file_path: 'src/qwen.ts', content: 'console.log(1);' } },
      });

      fireTool('sess-qwen', {
        id: 'tool-qwen-3',
        name: 'Write',
        status: 'error',
        output: 'permission denied',
        detail: { kind: 'tool_result', output: 'permission denied' },
      });

      expect(emitMock.mock.calls.some((c) => c[1] === 'file.change')).toBe(false);
      expect(emitMock.mock.calls.find((c) => c[1] === 'tool.call')?.[3]?.hidden).not.toBe(true);
      expect(emitMock.mock.calls.find((c) => c[1] === 'tool.result')?.[3]?.hidden).not.toBe(true);
    });

    it('falls back to visible raw tool events when structured file normalization is unavailable', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      fireTool('sess-raw', {
        id: 'tool-raw-1',
        name: 'Bash',
        status: 'complete',
        input: { command: 'npm test' },
        detail: { kind: 'tool_use', input: { command: 'npm test' } },
      });

      const call = emitMock.mock.calls.find((c) => c[1] === 'tool.call');
      const result = emitMock.mock.calls.find((c) => c[1] === 'tool.result');
      expect(call?.[3]?.hidden).not.toBe(true);
      expect(result?.[3]?.hidden).not.toBe(true);
      expect(emitMock.mock.calls.some((c) => c[1] === 'file.change')).toBe(false);
    });
  });

  describe('onStatus', () => {
    it('emits agent.status into the timeline for provider status updates', () => {
      const { provider, fireStatus } = makeMockProvider();
      wireProviderToRelay(provider);

      fireStatus('sess-status', { status: 'compacting', label: 'Compacting conversation...' });

      expect(emitMock).toHaveBeenCalledWith(
        'sess-status',
        'agent.status',
        { status: 'compacting', label: 'Compacting conversation...' },
        expect.objectContaining({ source: 'daemon', confidence: 'high' }),
      );
    });

    it('emits unlabeled status updates so the frontend can clear stale status text', () => {
      const { provider, fireStatus } = makeMockProvider();
      wireProviderToRelay(provider);

      fireStatus('sess-status', { status: null, label: null });

      expect(emitMock).toHaveBeenCalledWith(
        'sess-status',
        'agent.status',
        { status: null, label: null },
        expect.objectContaining({ source: 'daemon', confidence: 'high' }),
      );
    });
  });

  describe('onApprovalRequest', () => {
    it('broadcasts approval requests to transport subscribers and caches them', async () => {
      const { provider, fireApproval } = makeMockProvider();
      wireProviderToRelay(provider);

      fireApproval('sess-approval', {
        id: 'approval-1',
        description: 'Allow file write',
        tool: 'shell',
      });
      await Promise.resolve();

      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        type: TRANSPORT_EVENT.CHAT_APPROVAL,
        sessionId: 'sess-approval',
        requestId: 'approval-1',
        description: 'Allow file write',
        tool: 'shell',
      }));
      expect(appendMock).toHaveBeenCalledWith('sess-approval', expect.objectContaining({
        type: TRANSPORT_EVENT.CHAT_APPROVAL,
        requestId: 'approval-1',
      }));
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
