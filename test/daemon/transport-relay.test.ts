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
  __testing__ as relayTesting,
} from '../../src/daemon/transport-relay.js';

import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { appendTransportEvent } from '../../src/daemon/transport-history.js';

import {
  PROVIDER_ERROR_CODES,
  SDK_TURN_LOST_RECOVERY_CLASSIFIERS,
  SDK_TURN_LOST_RECOVERY_PHASES,
  SDK_TURN_LOST_RECOVERY_REASON,
  SDK_TURN_LOST_RECOVERY_STATUS,
  SDK_TURN_LOST_REPLAY_DECISIONS,
  sanitizeSdkTurnLostRecoveryMetadata,
  isSdkTurnLostRecovery,
  type TransportProvider,
} from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../shared/agent-message.js';
import { TRANSPORT_EVENT, TRANSPORT_MSG } from '../../shared/transport-events.js';
import { SESSION_CONTROL_METADATA_COMMAND_FIELD } from '../../shared/session-control-commands.js';
import type { SdkSubagentDetail } from '../../shared/sdk-subagent-status.js';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_SCHEMA_VERSION,
  SDK_SUBAGENT_STATUS,
} from '../../shared/sdk-subagent-status.js';

// ── Mock provider factory ────────────────────────────────────────────────────

type DeltaCb = (sessionId: string, delta: MessageDelta) => void;
type CompleteCb = (sessionId: string, message: AgentMessage) => void;
type MockProviderError = { code: string; message: string; recoverable: boolean; details?: unknown };
type ErrorCb = (sessionId: string, error: MockProviderError) => void;
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
    fireError: (sid: string, err: MockProviderError) => errorCb?.(sid, err),
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

function makeSdkSubagentDetail(overrides: {
  summary?: string;
  input?: SdkSubagentDetail['input'];
  output?: string;
  raw?: unknown;
  meta?: Partial<SdkSubagentDetail['meta']>;
} = {}): SdkSubagentDetail {
  return {
    kind: SDK_SUBAGENT_DETAIL_KIND,
    summary: overrides.summary ?? 'Working in child agent',
    ...(overrides.input !== undefined ? { input: overrides.input } : {}),
    ...(overrides.output !== undefined ? { output: overrides.output } : {}),
    ...(overrides.raw !== undefined ? { raw: overrides.raw } : {}),
    meta: {
      isSdkSubagent: true,
      schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
      provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
      canonicalKey: 'claude:sess-sdk:task-1',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
      taskId: 'task-1',
      ...overrides.meta,
    },
  };
}

function makeSdkTurnLostDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reason: SDK_TURN_LOST_RECOVERY_REASON,
    localSessionKey: 'sess-lost',
    sessionName: 'sess-lost',
    providerId: 'codex-sdk',
    providerSessionId: 'sess-lost',
    threadId: 'thread-1',
    turnId: 'turn-1',
    activityGeneration: 7,
    leaseStartedAt: 1_800_000_000_000,
    lastStrongActivityAt: 1_800_000_010_000,
    heartbeatStartedAt: 1_800_000_060_000,
    heartbeatCompletedAt: 1_800_000_060_120,
    heartbeatDurationMs: 120,
    silenceDurationMs: 50_000,
    heartbeatFailureCount: 1,
    classifier: SDK_TURN_LOST_RECOVERY_CLASSIFIERS.IDLE_MISSING_TURN,
    attempt: 1,
    correlationId: 'sdk-turn-lost-correlation-1',
    replayDecision: SDK_TURN_LOST_REPLAY_DECISIONS.PENDING,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('transport-relay (timeline-emitter based)', () => {
  let send: ReturnType<typeof vi.fn>;
  let emitMock: ReturnType<typeof vi.fn>;
  let appendMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Clear module-global per-session relay state so a prior test's in-flight
    // message can't leak a finalize emit into the next test.
    relayTesting.resetRelayState();
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

    it('finalizes the previous message (full text, streaming:false) when messageId changes', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-08T00:00:00.000Z'));

      const { provider, fireDelta } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-a', makeDelta({ messageId: 'msg-old', delta: 'old-a' }));   // emits streaming:true 'old-a'
      fireDelta('sess-a', makeDelta({ messageId: 'msg-old', delta: 'old-ab' }));  // throttled (buffered)
      fireDelta('sess-a', makeDelta({ messageId: 'msg-new', delta: 'new-a' }));   // boundary → finalize msg-old

      const textCalls = emitMock.mock.calls.filter(c => c[1] === 'assistant.text');
      // 1) live 'old-a' (streaming), 2) finalize 'old-ab' (streaming:false — the
      //    buffered tail must NOT be lost), 3) live 'new-a' (streaming).
      expect(textCalls).toHaveLength(3);
      expect(textCalls[0][2]).toMatchObject({ text: 'old-a', streaming: true });
      expect(textCalls[1][2]).toMatchObject({ text: 'old-ab', streaming: false });
      expect(textCalls[2][2]).toMatchObject({ text: 'new-a', streaming: true });
      // The finalized previous message is persisted (written to the timeline store).
      expect(appendMock.mock.calls.some(c => c[1]?.type === 'assistant.text' && c[1]?.text === 'old-ab')).toBe(true);

      // No DUPLICATE finalize/flush of the stale buffered update later.
      vi.advanceTimersByTime(500);
      const after = emitMock.mock.calls.filter(c => c[1] === 'assistant.text');
      expect(after).toHaveLength(3);

      vi.useRealTimers();
    });

    it('persists EVERY message of a multi-message turn (codex agentMessage-per-tool-round)', () => {
      // Regression: codex emits multiple agentMessage items per turn (one per
      // tool round), each a new messageId. The relay only finalized the LAST
      // message (via onComplete); earlier messages stayed streaming:true and
      // never reached the timeline store, so they vanished on refresh — the
      // user got a push notification + live ctx but a blank/partial timeline.
      const { provider, fireDelta, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      // Message 1 (before a tool round) — cumulative deltas.
      fireDelta('sess-multi', makeDelta({ messageId: 'item-1', delta: 'Let me check.' }));
      // Message 2 (after the tool round) — new messageId.
      fireDelta('sess-multi', makeDelta({ messageId: 'item-2', delta: 'The answer is 42.' }));
      // Turn completes on the last message.
      fireComplete('sess-multi', makeMessage({ id: 'item-2', content: 'The answer is 42.' }));

      // Both messages must be PERSISTED (streaming:false) to the timeline store.
      const persisted = appendMock.mock.calls
        .filter(c => c[1]?.type === 'assistant.text')
        .map(c => c[1]?.text);
      expect(persisted).toContain('Let me check.');   // finalized at the item-1→item-2 boundary
      expect(persisted).toContain('The answer is 42.'); // finalized by onComplete

      // Each persisted under its own stable eventId (separate bubbles).
      const finals = emitMock.mock.calls
        .filter(c => c[1] === 'assistant.text' && c[2]?.streaming === false);
      expect(finals.map(c => c[3]?.eventId)).toEqual(
        expect.arrayContaining(['transport:sess-multi:item-1', 'transport:sess-multi:item-2']),
      );
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

    it('does not render provider compact control completions as assistant text', () => {
      const { provider, fireComplete } = makeMockProvider();
      wireProviderToRelay(provider);

      fireComplete('sess-1', makeMessage({
        id: 'msg-compact',
        kind: 'system',
        role: 'system',
        content: 'Context compressed.',
        metadata: { [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact' },
      }));

      expect(emitMock.mock.calls.filter(c => c[1] === 'assistant.text')).toHaveLength(0);
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

    it('emits session.state error with error message', () => {
      const { provider, fireError } = makeMockProvider();
      wireProviderToRelay(provider);

      fireError('sess-err', { code: 'RATE_LIMITED', message: 'Too many requests', recoverable: true });

      const stateCall = emitMock.mock.calls.find(c => c[1] === 'session.state');
      expect(stateCall).toBeDefined();
      expect(stateCall![0]).toBe('sess-err');
      expect(stateCall![2].state).toBe('error');
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

    it('preserves partial streamed content on CANCELLED and persists it (no truncation on Esc/stop)', async () => {
      const { provider, fireDelta, fireError } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-cancelled', makeDelta({ messageId: 'msg-cancelled', delta: 'partial before stop' }));
      emitMock.mockClear();
      appendMock.mockClear();

      fireError('sess-cancelled', { code: PROVIDER_ERROR_CODES.CANCELLED, message: 'Cancelled', recoverable: true });
      await Promise.resolve();

      // The accumulated streamed text must be preserved (with a cancel marker),
      // NOT replaced by only the cancel notice — that was the "suddenly loses a
      // big chunk" bug when pressing Esc/stop mid-stream.
      const textCall = emitMock.mock.calls.find(c => c[1] === 'assistant.text');
      expect(textCall).toBeDefined();
      expect(textCall![0]).toBe('sess-cancelled');
      expect(textCall![2]).toMatchObject({
        text: 'partial before stop\n\n⚠️ Turn cancelled',
        streaming: false,
        memoryExcluded: true,
      });
      // A clean cancel must NOT emit a session error state.
      expect(emitMock.mock.calls.some(c => c[1] === 'session.state')).toBe(false);
      // The partial must be persisted (落盘) so it survives refresh/reconnect.
      const appended = appendMock.mock.calls.find(c => c[1]?.type === 'assistant.text');
      expect(appended?.[1]).toMatchObject({
        type: 'assistant.text',
        sessionId: 'sess-cancelled',
        text: 'partial before stop\n\n⚠️ Turn cancelled',
      });
    });

    it('CANCELLED with no streamed content shows only the cancel notice and does not persist', async () => {
      const { provider, fireError } = makeMockProvider();
      wireProviderToRelay(provider);
      emitMock.mockClear();
      appendMock.mockClear();

      fireError('sess-cancel-empty', { code: PROVIDER_ERROR_CODES.CANCELLED, message: 'Cancelled', recoverable: true });
      await Promise.resolve();

      const textCall = emitMock.mock.calls.find(c => c[1] === 'assistant.text');
      expect(textCall![2]).toMatchObject({
        text: '⚠️ Turn cancelled: Cancelled',
        streaming: false,
        memoryExcluded: true,
      });
      // Nothing streamed → nothing to persist.
      expect(appendMock.mock.calls.some(c => c[1]?.type === 'assistant.text')).toBe(false);
      expect(emitMock.mock.calls.some(c => c[1] === 'session.state')).toBe(false);
    });

    it('recognizes typed sdk_turn_lost with a machine-readable helper, not message parsing', () => {
      const details = makeSdkTurnLostDetails({
        rawThreadRead: { prompt: 'SECRET_PROMPT_SHOULD_NOT_PROJECT' },
        error: 'UNBOUNDED_ERROR_SHOULD_NOT_PROJECT',
      });
      const error = {
        code: PROVIDER_ERROR_CODES.SDK_TURN_LOST,
        message: 'any human text can change',
        recoverable: true,
        details,
      };

      expect(isSdkTurnLostRecovery(error)).toBe(true);
      expect(isSdkTurnLostRecovery({
        ...error,
        message: 'a completely different localized message',
      })).toBe(true);
      expect(isSdkTurnLostRecovery({
        code: PROVIDER_ERROR_CODES.SDK_TURN_LOST,
        message: 'sdk_turn_lost',
        recoverable: true,
        details: { classifier: SDK_TURN_LOST_RECOVERY_CLASSIFIERS.IDLE_MISSING_TURN },
      })).toBe(false);

      const sanitized = sanitizeSdkTurnLostRecoveryMetadata(details);
      expect(sanitized).toMatchObject({
        reason: SDK_TURN_LOST_RECOVERY_REASON,
        classifier: SDK_TURN_LOST_RECOVERY_CLASSIFIERS.IDLE_MISSING_TURN,
        correlationId: 'sdk-turn-lost-correlation-1',
      });
      expect(JSON.stringify(sanitized)).not.toContain('SECRET_PROMPT_SHOULD_NOT_PROJECT');
      expect(JSON.stringify(sanitized)).not.toContain('UNBOUNDED_ERROR_SHOULD_NOT_PROJECT');
    });

    it('emits a privacy-safe detected phase for recoverable sdk_turn_lost and no generic final error', async () => {
      const { provider, fireDelta, fireError } = makeMockProvider();
      wireProviderToRelay(provider);

      fireDelta('sess-lost', makeDelta({ messageId: 'msg-lost', delta: 'partial before heartbeat' }));
      emitMock.mockClear();

      fireError('sess-lost', {
        code: PROVIDER_ERROR_CODES.SDK_TURN_LOST,
        message: 'Raw provider error SECRET_PROMPT_SHOULD_NOT_PROJECT',
        recoverable: true,
        details: makeSdkTurnLostDetails({
          rawThreadRead: { prompt: 'SECRET_PROMPT_SHOULD_NOT_PROJECT' },
          toolInput: 'SECRET_TOOL_INPUT_SHOULD_NOT_PROJECT',
          env: { OPENAI_API_KEY: 'SECRET_ENV_SHOULD_NOT_PROJECT' },
        }),
      });
      await Promise.resolve();

      expect(emitMock.mock.calls.some(c => c[1] === 'assistant.text')).toBe(false);
      expect(emitMock.mock.calls.some(c => c[1] === 'session.state' && c[2]?.state === 'error')).toBe(false);

      const phaseCall = emitMock.mock.calls.find(c => c[1] === 'agent.status');
      expect(phaseCall).toBeDefined();
      expect(phaseCall![0]).toBe('sess-lost');
      expect(phaseCall![2]).toMatchObject({
        status: SDK_TURN_LOST_RECOVERY_STATUS,
        phase: SDK_TURN_LOST_RECOVERY_PHASES.DETECTED,
        reason: SDK_TURN_LOST_RECOVERY_REASON,
        correlationId: 'sdk-turn-lost-correlation-1',
        recovery: {
          reason: SDK_TURN_LOST_RECOVERY_REASON,
          classifier: SDK_TURN_LOST_RECOVERY_CLASSIFIERS.IDLE_MISSING_TURN,
          replayDecision: SDK_TURN_LOST_REPLAY_DECISIONS.PENDING,
        },
      });
      expect(phaseCall![3]).toMatchObject({
        eventId: 'transport-recovery:sess-lost:sdk-turn-lost-correlation-1:detected',
      });

      const projected = JSON.stringify([phaseCall![2], appendMock.mock.calls]);
      expect(projected).not.toContain('SECRET_PROMPT_SHOULD_NOT_PROJECT');
      expect(projected).not.toContain('SECRET_TOOL_INPUT_SHOULD_NOT_PROJECT');
      expect(projected).not.toContain('SECRET_ENV_SHOULD_NOT_PROJECT');
      expect(projected).not.toContain('Raw provider error');
      expect(appendMock).toHaveBeenCalledWith('sess-lost', expect.objectContaining({
        type: 'agent.status',
        status: SDK_TURN_LOST_RECOVERY_STATUS,
        phase: SDK_TURN_LOST_RECOVERY_PHASES.DETECTED,
      }));
    });

    it('drops recovery phases with conflicting provider session metadata instead of guessing ownership', () => {
      const { provider, fireError } = makeMockProvider();
      wireProviderToRelay(provider);

      const sharedProviderSessionId = 'ambiguous-provider-session-id';
      const details = makeSdkTurnLostDetails({
        providerSessionId: sharedProviderSessionId,
        correlationId: 'correlation-shared-provider-sid',
      });

      fireError('owner-a', {
        code: PROVIDER_ERROR_CODES.SDK_TURN_LOST,
        message: 'lost',
        recoverable: true,
        details,
      });
      fireError('owner-a', {
        code: PROVIDER_ERROR_CODES.SDK_TURN_LOST,
        message: 'lost duplicate',
        recoverable: true,
        details,
      });
      fireError('owner-b', {
        code: PROVIDER_ERROR_CODES.SDK_TURN_LOST,
        message: 'lost',
        recoverable: true,
        details: makeSdkTurnLostDetails({
          providerSessionId: sharedProviderSessionId,
          correlationId: 'correlation-shared-provider-sid',
        }),
      });

      const phases = emitMock.mock.calls.filter(c => c[1] === 'agent.status');
      expect(phases).toHaveLength(0);
      expect(emitMock.mock.calls.some(c => c[0] === sharedProviderSessionId)).toBe(false);
    });

    it('emits explicit recovery phase metadata for recovering/recovered/failed without generic error state', () => {
      const phases = [
        SDK_TURN_LOST_RECOVERY_PHASES.RECOVERING,
        SDK_TURN_LOST_RECOVERY_PHASES.RECOVERED,
        SDK_TURN_LOST_RECOVERY_PHASES.FAILED,
      ];

      for (const phase of phases) {
        const emitted = relayTesting.emitSdkTurnLostRecoveryPhaseForTest('sess-phase', makeSdkTurnLostDetails({
          localSessionKey: 'sess-phase',
          sessionName: 'sess-phase',
          phase,
          correlationId: `corr-${phase}`,
          replayDecision: phase === SDK_TURN_LOST_RECOVERY_PHASES.FAILED
            ? SDK_TURN_LOST_REPLAY_DECISIONS.FAILED
            : SDK_TURN_LOST_REPLAY_DECISIONS.SAFE_REPLAY,
        }));
        expect(emitted).toBe(true);
      }

      const phaseCalls = emitMock.mock.calls.filter(c => c[1] === 'agent.status');
      expect(phaseCalls.map(c => c[2].phase)).toEqual(phases);
      expect(phaseCalls.map(c => c[2].status)).toEqual([
        SDK_TURN_LOST_RECOVERY_STATUS,
        SDK_TURN_LOST_RECOVERY_STATUS,
        SDK_TURN_LOST_RECOVERY_STATUS,
      ]);
      expect(emitMock.mock.calls.some(c => c[1] === 'assistant.text' && String(c[2].text).includes('⚠️ Error'))).toBe(false);
      expect(emitMock.mock.calls.some(c => c[1] === 'session.state' && c[2].state === 'error')).toBe(false);
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
      expect(call![2]).toEqual({ toolCallId: 'tool-1', tool: 'list_directory', input: { path: '/tmp' }, detail: { kind: 'tool_use', input: { path: '/tmp' } } });
      expect(call![3].eventId).toBe('transport-tool:sess-tool:tool-1:call');
      expect(call![3].hidden).not.toBe(true);
      expect(appendMock).toHaveBeenCalledWith('sess-tool', expect.objectContaining({
        type: 'tool.call',
        toolCallId: 'tool-1',
        tool: 'list_directory',
      }));
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
      expect(call![2]).toMatchObject({
        sessionId: 'sess-tool',
        toolCallId: 'tool-1',
        terminalStatus: 'succeeded',
        terminalReason: 'provider_result',
        synthetic: false,
        source: 'app_server_jsonrpc',
        decisionReason: 'provider_result',
        idempotencyKey: expect.stringContaining('tool-1:succeeded:provider_result'),
        output: 'done',
        detail: { kind: 'tool_result', output: 'done' },
      });
      expect(call![3].eventId).toBe('transport-tool:sess-tool:tool-1:result');
      expect(call![3].hidden).not.toBe(true);
    });

    it('preserves canonical lifecycle terminal metadata from provider tool events', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      fireTool('sess-tool', {
        id: 'tool-1',
        name: 'WebSearch',
        status: 'complete',
        output: 'done',
        terminalStatus: 'cancelled',
        terminalReason: 'user_cancelled',
        terminalSynthetic: true,
        terminalSource: 'daemon_synthetic',
        terminalDecisionReason: 'local_stop',
        terminalIdempotencyKey: 'codex-terminal:sess-tool:session:sess-tool:1:tool:tool-1:cancelled:user_cancelled',
        activityGeneration: { scope: 'session', sessionName: 'sess-tool', generation: 1 },
        turnId: 'turn-1',
        lifecycleItemKind: 'web_search',
      });

      const call = emitMock.mock.calls.find((c) => c[1] === 'tool.result');
      expect(call?.[2]).toMatchObject({
        sessionId: 'sess-tool',
        toolCallId: 'tool-1',
        terminalStatus: 'cancelled',
        terminalReason: 'user_cancelled',
        synthetic: true,
        source: 'daemon_synthetic',
        decisionReason: 'local_stop',
        idempotencyKey: 'codex-terminal:sess-tool:session:sess-tool:1:tool:tool-1:cancelled:user_cancelled',
        activityGeneration: { scope: 'session', sessionName: 'sess-tool', generation: 1 },
        turnId: 'turn-1',
        itemKind: 'web_search',
      });
      expect(appendMock).toHaveBeenCalledWith('sess-tool', expect.objectContaining({
        type: 'tool.result',
        terminalStatus: 'cancelled',
        terminalReason: 'user_cancelled',
        synthetic: true,
        source: 'daemon_synthetic',
        decisionReason: 'local_stop',
        idempotencyKey: 'codex-terminal:sess-tool:session:sess-tool:1:tool:tool-1:cancelled:user_cancelled',
      }));
    });

    it('emits a visible checklist tool.call for completed-only update_plan snapshots', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      fireTool('sess-plan', {
        id: 'todo-1',
        name: 'update_plan',
        status: 'complete',
        input: {
          plan: [
            { content: '梳理登录需求', status: 'completed' },
            { content: '实现登录表单', status: 'pending' },
          ],
        },
        detail: {
          kind: 'plan',
          summary: 'Plan',
          input: {
            plan: [
              { content: '梳理登录需求', status: 'completed' },
              { content: '实现登录表单', status: 'pending' },
            ],
          },
        },
      });

      const call = emitMock.mock.calls.find((c) => c[1] === 'tool.call');
      const result = emitMock.mock.calls.find((c) => c[1] === 'tool.result');
      expect(call).toBeDefined();
      expect(call![0]).toBe('sess-plan');
      expect(call![2]).toMatchObject({
        toolCallId: 'todo-1',
        tool: 'update_plan',
        input: {
          plan: [
            { content: '梳理登录需求', status: 'completed' },
            { content: '实现登录表单', status: 'pending' },
          ],
        },
      });
      expect(call![3]).toMatchObject({
        eventId: 'transport-tool:sess-plan:todo-1:call',
      });
      expect(call![3].hidden).not.toBe(true);
      expect(result?.[3]).toMatchObject({
        eventId: 'transport-tool:sess-plan:todo-1:result',
      });
      expect(result?.[2]).toMatchObject({
        toolCallId: 'todo-1',
        terminalStatus: 'succeeded',
        terminalReason: 'provider_result',
      });
      expect(appendMock).toHaveBeenCalledWith('sess-plan', expect.objectContaining({
        type: 'tool.call',
        toolCallId: 'todo-1',
        tool: 'update_plan',
      }));
    });

    it('emits hidden tool.call for running SDK sub-agent snapshots', async () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      const detail = makeSdkSubagentDetail({
        input: { action: 'start' },
        meta: {
          canonicalKey: 'claude:sess-sdk:task-running',
          normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
          active: true,
          terminal: false,
          taskId: 'task-running',
        },
      });

      fireTool('sess-sdk', {
        id: 'sdk-task-running',
        name: 'Task',
        status: 'running',
        input: { action: 'start' },
        detail,
      });
      await Promise.resolve();

      const call = emitMock.mock.calls.find((c) => c[1] === 'tool.call');
      expect(call).toBeDefined();
      expect(call![0]).toBe('sess-sdk');
      expect(call![2]).toMatchObject({
        tool: 'Task',
        input: { action: 'start' },
        detail: {
          kind: SDK_SUBAGENT_DETAIL_KIND,
          meta: { canonicalKey: 'claude:sess-sdk:task-running' },
        },
      });
      expect(call![3]).toMatchObject({
        eventId: 'transport-tool:sess-sdk:sdk-task-running:call',
        hidden: true,
      });
      expect(appendMock).not.toHaveBeenCalled();
      expect(emitMock.mock.calls.some((c) => c[1] === 'file.change')).toBe(false);
    });

    it('emits hidden tool.result for terminal SDK sub-agent snapshots and preserves canonicalKey', async () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      const canonicalKey = 'claude:sess-sdk:task-terminal';
      const runningDetail = makeSdkSubagentDetail({
        meta: {
          canonicalKey,
          normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
          active: true,
          terminal: false,
          taskId: 'task-terminal',
        },
      });
      const terminalDetail = makeSdkSubagentDetail({
        output: 'complete',
        meta: {
          canonicalKey,
          normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
          active: false,
          terminal: true,
          taskId: 'task-terminal',
        },
      });

      fireTool('sess-sdk', {
        id: 'sdk-task-terminal',
        name: 'Task',
        status: 'running',
        detail: runningDetail,
      });
      fireTool('sess-sdk', {
        id: 'sdk-task-terminal',
        name: 'Task',
        status: 'complete',
        output: 'complete',
        detail: terminalDetail,
      });
      await Promise.resolve();

      const call = emitMock.mock.calls.find((c) => c[1] === 'tool.call');
      const result = emitMock.mock.calls.find((c) => c[1] === 'tool.result');
      expect(call?.[3]?.hidden).toBe(true);
      expect(result?.[3]?.hidden).toBe(true);
      expect(call?.[2]).toMatchObject({ toolCallId: 'sdk-task-terminal' });
      expect(result?.[2]).toMatchObject({
        toolCallId: 'sdk-task-terminal',
        terminalStatus: 'succeeded',
        terminalReason: 'provider_result',
      });
      expect(call?.[2]?.detail?.meta?.canonicalKey).toBe(canonicalKey);
      expect(result?.[2]?.detail?.meta?.canonicalKey).toBe(canonicalKey);
      expect(result?.[2]).toMatchObject({
        output: 'complete',
        detail: {
          kind: SDK_SUBAGENT_DETAIL_KIND,
          meta: {
            canonicalKey,
            normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
            active: false,
            terminal: true,
          },
        },
      });
      expect(appendMock).not.toHaveBeenCalled();
    });

    it('drops malformed SDK sub-agent details instead of rendering them as ordinary tools', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      fireTool('sess-sdk', {
        id: 'sdk-task-malformed',
        name: 'Task',
        status: 'running',
        detail: {
          kind: SDK_SUBAGENT_DETAIL_KIND,
          raw: { prompt: 'SECRET_PROMPT' },
          meta: {
            isSdkSubagent: true,
            schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
            provider: 'unknown-provider',
            providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
            canonicalKey: 'claude:sess-sdk:task-malformed',
            normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
            active: true,
            terminal: false,
          },
        },
      });

      expect(emitMock.mock.calls.some((c) => c[1] === 'tool.call' || c[1] === 'tool.result')).toBe(false);
      expect(appendMock).not.toHaveBeenCalled();
    });

    it('emits hidden tool.result for errored SDK sub-agent snapshots without a visible call', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      fireTool('sess-sdk', {
        id: 'sdk-task-error',
        name: 'Task',
        status: 'error',
        output: 'failed',
        detail: makeSdkSubagentDetail({
          meta: {
            canonicalKey: 'claude:sess-sdk:task-error',
            normalizedStatus: SDK_SUBAGENT_STATUS.ERROR,
            active: false,
            terminal: true,
            taskId: 'task-error',
          },
        }),
      });

      expect(emitMock.mock.calls.some((c) => c[1] === 'tool.call')).toBe(false);
      const result = emitMock.mock.calls.find((c) => c[1] === 'tool.result');
      expect(result).toBeDefined();
      expect(result![2]).toMatchObject({
        toolCallId: 'sdk-task-error',
        terminalStatus: 'errored',
        terminalReason: 'provider_error',
        error: 'error',
        detail: {
          kind: SDK_SUBAGENT_DETAIL_KIND,
          meta: {
            canonicalKey: 'claude:sess-sdk:task-error',
            normalizedStatus: SDK_SUBAGENT_STATUS.ERROR,
          },
        },
      });
      expect(JSON.stringify(result![2])).not.toContain('failed');
      expect(result![3].hidden).toBe(true);
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
      expect(emitMock.mock.calls.some((c) => c[1] === 'tool.call' || c[1] === 'tool.result')).toBe(false);
      expect(appendMock).not.toHaveBeenCalled();
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

  // ── wireProviderToRelay — onToolCall: AskUserQuestion ────────────────────
  describe('onToolCall AskUserQuestion', () => {
    const askInput = {
      questions: [{
        question: 'Pick an approach',
        header: 'Approach',
        multiSelect: false,
        options: [
          { label: 'A', description: 'first' },
          { label: 'B', description: 'second' },
        ],
      }],
    };

    it('emits ask.question (not a raw tool.call) once the call completes with its input', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      // Input streams in incrementally — the completed call carries the questions.
      fireTool('sess-a', { id: 'tu-1', name: 'AskUserQuestion', status: 'complete', input: askInput });

      const askCalls = emitMock.mock.calls.filter((c) => c[1] === 'ask.question');
      const toolCalls = emitMock.mock.calls.filter((c) => c[1] === 'tool.call');
      expect(toolCalls).toHaveLength(0); // no raw "> AskUserQuestion {...}" line
      expect(askCalls).toHaveLength(1);
      const [sessionId, , payload, meta] = askCalls[0];
      expect(sessionId).toBe('sess-a');
      expect(payload.toolUseId).toBe('tu-1');
      expect(payload.questions).toEqual(askInput.questions);
      expect(payload.waitMs).toBe(60_000); // ASK_QUESTION_WAIT_MS — drives the web countdown
      expect(meta.eventId).toBe('transport-ask:sess-a:tu-1');
    });

    it('does NOT emit at running (input not streamed yet) — avoids an empty card', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      fireTool('sess-a', { id: 'tu-2', name: 'AskUserQuestion', status: 'running', input: undefined });

      expect(emitMock).not.toHaveBeenCalled();
    });

    it('does not emit when the completed call carries no questions', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      fireTool('sess-a', { id: 'tu-3', name: 'AskUserQuestion', status: 'complete', input: {} });

      expect(emitMock).not.toHaveBeenCalled();
    });

    it('wraps a flat single-question input shape', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      const flat = { question: 'Pick', header: 'H', multiSelect: false, options: [{ label: 'A', description: 'a' }] };
      fireTool('sess-a', { id: 'tu-4', name: 'AskUserQuestion', status: 'complete', input: flat });

      const askCalls = emitMock.mock.calls.filter((c) => c[1] === 'ask.question');
      expect(askCalls).toHaveLength(1);
      expect(askCalls[0][2].questions).toEqual([flat]);
    });

    it('suppresses the tool_result of an answered AskUserQuestion (no stray error line)', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      // Card emitted for the completed call…
      fireTool('sess-z', { id: 'tu-ans', name: 'AskUserQuestion', status: 'complete', input: askInput });
      emitMock.mockClear();
      // …then the SDK re-emits its tool_result as a generic name:'tool' event,
      // marked error because the answer came via canUseTool deny.
      fireTool('sess-z', { id: 'tu-ans', name: 'tool', status: 'error', output: '[H] A', detail: { kind: 'tool_result' } });

      expect(emitMock).not.toHaveBeenCalled(); // suppressed — no "< error:" line
    });

    it('still emits a normal tool.call for non-AskUserQuestion tools', () => {
      const { provider, fireTool } = makeMockProvider();
      wireProviderToRelay(provider);

      fireTool('sess-a', { id: 'tu-read', name: 'Read', status: 'running', input: { file_path: '/x' } });

      const askCalls = emitMock.mock.calls.filter((c) => c[1] === 'ask.question');
      const toolCalls = emitMock.mock.calls.filter((c) => c[1] === 'tool.call');
      expect(askCalls).toHaveLength(0);
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0][2].tool).toBe('Read');
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
