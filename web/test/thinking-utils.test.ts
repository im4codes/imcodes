import { describe, expect, it } from 'vitest';

import { getActiveStatusText, getActiveThinkingTs, getTailSessionState, hasActiveToolCall } from '../src/thinking-utils.js';

const authoritativeIdlePayload = {
  state: 'idle',
  authoritative: true,
  activityGeneration: 1,
  blockingWorkCount: 0,
  activeWorkCount: 0,
  activeToolCount: 0,
  pendingCount: 0,
  pendingVersion: 1,
  decisionReason: 'activity_reconciler_clear',
  clearInputs: [{ source: 'transport-runtime', reason: 'clear', count: 0 }],
};

describe('hasActiveToolCall', () => {
  it('does not treat trailing agent.status during thinking as a tool call', () => {
    expect(hasActiveToolCall([
      { type: 'assistant.thinking', ts: 1 },
      { type: 'agent.status', payload: { label: 'thinking 4s' } },
      { type: 'session.state', payload: { state: 'running' } },
    ] as any)).toBe(false);
  });

  it('treats a trailing tool.call as active', () => {
    expect(hasActiveToolCall([
      { type: 'assistant.thinking', ts: 1 },
      { type: 'tool.call', payload: { tool: 'Read' } },
      { type: 'agent.status', payload: { label: 'Reading file...' } },
      { type: 'session.state', payload: { state: 'running' } },
    ] as any)).toBe(true);
  });

  it('does not treat a completed tool.result as an active tool call', () => {
    expect(hasActiveToolCall([
      { type: 'tool.call', payload: { tool: 'Read' } },
      { type: 'tool.result', payload: { ok: true } },
      { type: 'agent.status', payload: { label: 'thinking 1s' } },
      { type: 'session.state', payload: { state: 'running' } },
    ] as any)).toBe(false);
  });

  it('keeps a keyed unmatched tool call active across legacy idle', () => {
    expect(hasActiveToolCall([
      { type: 'tool.call', payload: { toolCallId: 'A', tool: 'Bash' } },
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'usage.update', payload: { model: 'gpt-5.5' } },
    ] as any)).toBe(true);
  });

  it('does not keep an anonymous legacy tool call active across idle', () => {
    expect(hasActiveToolCall([
      { type: 'tool.call', payload: { tool: 'Bash' } },
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'usage.update', payload: { model: 'gpt-5.5' } },
    ] as any)).toBe(false);
  });

  it('lets authoritative idle close an unmatched tool call', () => {
    expect(hasActiveToolCall([
      { type: 'tool.call', payload: { tool: 'Bash' } },
      { type: 'session.state', payload: authoritativeIdlePayload },
    ] as any)).toBe(false);
  });

  it('does not treat a backgrounded SDK sub-agent heartbeat after idle as an active parent tool call', () => {
    const sdkDetail = {
      kind: 'sdkSubagent',
      meta: {
        isSdkSubagent: true,
        schemaVersion: 1,
        provider: 'codex-sdk',
        providerKind: 'codexRuntimeAgent',
        canonicalKey: 'codex:deck_main:runtime:agent-1',
        normalizedStatus: 'running',
        active: true,
        terminal: false,
        backgrounded: true,
      },
    };
    expect(hasActiveToolCall([
      { type: 'session.state', payload: authoritativeIdlePayload },
      { type: 'tool.call', payload: { toolCallId: 'agent-1', tool: 'Codex Sub-agent', detail: sdkDetail } },
    ] as any)).toBe(false);
  });

  it('does not close one keyed tool when another keyed tool completes', () => {
    expect(hasActiveToolCall([
      { type: 'tool.call', payload: { toolCallId: 'A', tool: 'Bash' } },
      { type: 'tool.call', payload: { toolCallId: 'B', tool: 'Read' } },
      { type: 'tool.result', payload: { toolCallId: 'A', terminalStatus: 'succeeded' } },
      { type: 'session.state', payload: { state: 'idle' } },
    ] as any)).toBe(true);
  });
});

describe('getActiveThinkingTs', () => {
  it('treats legacy idle as weak while thinking is still open', () => {
    expect(getActiveThinkingTs([
      { type: 'assistant.thinking', ts: 10 },
      { type: 'session.state', ts: 11, payload: { state: 'idle' } },
      { type: 'agent.status', ts: 12, payload: { label: 'still thinking' } },
    ] as any)).toBe(10);
  });
});

describe('getActiveStatusText', () => {
  it('keeps an automatic peer-audit status visible across protocol events and automation notes', () => {
    expect(getActiveStatusText([
      { type: 'agent.status', payload: { status: 'supervision_audit_waiting', label: 'Peer audit running' } },
      { type: 'assistant.text', payload: { text: 'Audit started', automation: true, memoryExcluded: true } },
      { type: 'peer_audit.status', payload: { phase: 'waiting_reply', trigger: 'automatic' } },
    ])).toBe('Peer audit running');
  });

  it('does not carry supervision status across ordinary assistant activity', () => {
    expect(getActiveStatusText([
      { type: 'agent.status', payload: { status: 'supervision_audit_waiting', label: 'Peer audit running' } },
      { type: 'assistant.text', payload: { text: 'ordinary assistant reply' } },
    ])).toBeNull();
  });
});

describe('getTailSessionState', () => {
  it('returns the latest authoritative session state from the timeline tail', () => {
    expect(getTailSessionState([
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'tool.result', payload: { ok: true } },
      { type: 'session.state', payload: { state: 'running' } },
    ] as any)).toBe('running');
  });

  it('returns null when no session.state event exists', () => {
    expect(getTailSessionState([
      { type: 'assistant.thinking', ts: 1 },
      { type: 'tool.call', payload: { tool: 'Read' } },
    ] as any)).toBe(null);
  });

  it('keeps the tail session state idle while backgrounded SDK sub-agent heartbeats continue', () => {
    const sdkDetail = {
      kind: 'sdkSubagent',
      meta: {
        isSdkSubagent: true,
        schemaVersion: 1,
        provider: 'codex-sdk',
        providerKind: 'codexRuntimeAgent',
        canonicalKey: 'codex:deck_main:runtime:agent-1',
        normalizedStatus: 'running',
        active: true,
        terminal: false,
        backgrounded: true,
      },
    };
    expect(getTailSessionState([
      { type: 'session.state', payload: authoritativeIdlePayload },
      { type: 'tool.call', payload: { toolCallId: 'agent-1', tool: 'Codex Sub-agent', detail: sdkDetail } },
      { type: 'tool.call', payload: { toolCallId: 'agent-1', tool: 'Codex Sub-agent', detail: sdkDetail } },
    ] as any)).toBe('idle');
  });

  it('ignores neutral started notifications when deriving the active tail state', () => {
    expect(getTailSessionState([
      { type: 'session.state', ts: 1, payload: authoritativeIdlePayload },
      { type: 'session.state', ts: 2, payload: { state: 'started' } },
    ] as any)).toBe('idle');

    expect(getTailSessionState([
      { type: 'session.state', ts: 2, payload: { state: 'started' } },
    ] as any)).toBe(null);
  });
});
