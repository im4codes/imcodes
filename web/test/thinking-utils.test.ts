import { describe, expect, it } from 'vitest';

import { getActiveThinkingTs, getTailSessionState, hasActiveToolCall } from '../src/thinking-utils.js';

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
});
