import { describe, expect, it } from 'vitest';

import { hasActiveTimelineTurn, isRunningTimelineEvent } from '../src/timeline-running.js';

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

describe('isRunningTimelineEvent', () => {
  it('treats assistant.thinking as a running signal', () => {
    expect(isRunningTimelineEvent({ type: 'assistant.thinking' } as any)).toBe(true);
  });

  it('keeps tool.call and streaming assistant.text as running signals', () => {
    expect(isRunningTimelineEvent({ type: 'tool.call' } as any)).toBe(true);
    expect(isRunningTimelineEvent({ type: 'assistant.text', payload: { streaming: true } } as any)).toBe(true);
    expect(isRunningTimelineEvent({ type: 'assistant.text', payload: { streaming: false } } as any)).toBe(false);
    expect(isRunningTimelineEvent({ type: 'tool.result' } as any)).toBe(false);
  });

  it('treats assistant output after the latest idle as an active turn', () => {
    expect(hasActiveTimelineTurn([
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'assistant.text', payload: { text: 'working', streaming: true } },
      { type: 'command.ack', payload: { ok: true } },
    ] as any)).toBe(true);
  });

  it('keeps an active turn visible through pending optimistic user messages', () => {
    expect(hasActiveTimelineTurn([
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'assistant.text', payload: { text: 'still working', streaming: true } },
      { type: 'user.message', payload: { text: 'queued first', pending: true, commandId: 'cmd-1' } },
      { type: 'command.ack', payload: { ok: true, commandId: 'cmd-1' } },
    ] as any)).toBe(true);
  });

  it('keeps a running transport turn visible through the confirmed user message echo', () => {
    expect(hasActiveTimelineTurn([
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'session.state', payload: { state: 'running' } },
      { type: 'user.message', payload: { text: 'sent first', pending: false, commandId: 'cmd-1' } },
      { type: 'command.ack', payload: { ok: true, commandId: 'cmd-1' } },
    ] as any)).toBe(true);
  });

  it('lets a confirmed user message end active-turn inference when no newer running signal exists', () => {
    expect(hasActiveTimelineTurn([
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'assistant.text', payload: { text: 'old assistant text', streaming: false } },
      { type: 'user.message', payload: { text: 'already confirmed', pending: false, commandId: 'cmd-1' } },
      { type: 'command.ack', payload: { ok: true, commandId: 'cmd-1' } },
    ] as any)).toBe(false);
  });

  it('stops active turn detection at the latest idle state', () => {
    expect(hasActiveTimelineTurn([
      { type: 'assistant.text', payload: { text: 'done', streaming: false } },
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'command.ack', payload: { ok: true } },
    ] as any)).toBe(false);
  });

  it('does not let legacy idle close an unmatched tool call', () => {
    expect(hasActiveTimelineTurn([
      { type: 'tool.call', payload: { tool: 'Bash' } },
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'usage.update', payload: { model: 'gpt-5.5' } },
    ] as any)).toBe(true);
  });

  it('lets authoritative clean idle close an unmatched tool call', () => {
    expect(hasActiveTimelineTurn([
      { type: 'tool.call', payload: { tool: 'Bash' } },
      { type: 'session.state', payload: authoritativeIdlePayload },
      { type: 'usage.update', payload: { model: 'gpt-5.5' } },
    ] as any)).toBe(false);
  });

  it('does not revive an idle turn when a late tool result arrives after idle', () => {
    expect(hasActiveTimelineTurn([
      { type: 'tool.call', payload: { tool: 'Bash' } },
      { type: 'session.state', payload: authoritativeIdlePayload },
      { type: 'usage.update', payload: { model: 'gpt-5.5' } },
      { type: 'tool.result', payload: { output: 'done' } },
    ] as any)).toBe(false);
  });

  it('keeps a turn active when a tool result follows an unmatched tool call before idle', () => {
    expect(hasActiveTimelineTurn([
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'tool.call', payload: { tool: 'Bash' } },
      { type: 'tool.result', payload: { output: 'done' } },
      { type: 'usage.update', payload: { model: 'gpt-5.5' } },
    ] as any)).toBe(true);
  });

  it('keeps a turn active when a tool call is the latest running tail', () => {
    expect(hasActiveTimelineTurn([
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'tool.call', payload: { tool: 'Bash' } },
      { type: 'usage.update', payload: { model: 'gpt-5.5' } },
    ] as any)).toBe(true);
  });

  it('does not treat terminal non-running session states as active turns', () => {
    expect(hasActiveTimelineTurn([
      { type: 'assistant.text', payload: { text: 'done', streaming: false } },
      { type: 'session.state', payload: { state: 'stopped' } },
    ] as any)).toBe(false);
  });

  it('ignores malformed tail events without crashing active-turn detection', () => {
    expect(hasActiveTimelineTurn([
      { type: 'tool.call', payload: { tool: 'Bash' } },
      { type: 'session.state', payload: authoritativeIdlePayload },
      { type: 'usage.update' },
      { type: 'tool.result', payload: null },
    ] as any)).toBe(false);

    expect(hasActiveTimelineTurn([
      { type: 'session.state', payload: null },
      { type: 'user.message' },
      { type: 'command.ack', payload: { ok: true } },
    ] as any)).toBe(false);
  });

  it('keeps one of multiple keyed tools active across weak idle', () => {
    expect(hasActiveTimelineTurn([
      { type: 'tool.call', payload: { toolCallId: 'A', tool: 'Bash' } },
      { type: 'tool.call', payload: { toolCallId: 'B', tool: 'Read' } },
      { type: 'tool.result', payload: { toolCallId: 'A', terminalStatus: 'succeeded' } },
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'usage.update', payload: { model: 'gpt-5.5' } },
    ] as any)).toBe(true);
  });
});
