import { describe, expect, it } from 'vitest';

import { hasActiveTimelineTurn, hasPendingUserSend, isRunningTimelineEvent } from '../src/timeline-running.js';

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
  it('recognizes only unresolved optimistic user sends as immediate client activity', () => {
    expect(hasPendingUserSend([
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'user.message', payload: { text: 'just sent', pending: true, commandId: 'cmd-1' } },
    ] as any)).toBe(true);
    expect(hasPendingUserSend([
      { type: 'user.message', payload: { text: 'failed', pending: false, failed: true, commandId: 'cmd-2' } },
    ] as any)).toBe(false);
    expect(hasPendingUserSend([
      { type: 'user.message', payload: { text: 'confirmed', pending: false, commandId: 'cmd-3' } },
    ] as any)).toBe(false);
  });

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

  it('keeps a permission-waiting turn active instead of presenting false idle', () => {
    expect(hasActiveTimelineTurn([
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'session.state', payload: { state: 'permission' } },
      { type: 'command.ack', payload: { ok: true } },
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

  it('does not let legacy idle close a keyed unmatched tool call', () => {
    expect(hasActiveTimelineTurn([
      { type: 'tool.call', payload: { toolCallId: 'A', tool: 'Bash' } },
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'usage.update', payload: { model: 'gpt-5.5' } },
    ] as any)).toBe(true);
  });

  it('does not keep an anonymous legacy tool call active across idle', () => {
    expect(hasActiveTimelineTurn([
      { type: 'tool.call', payload: { tool: 'Bash' } },
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'usage.update', payload: { model: 'gpt-5.5' } },
    ] as any)).toBe(false);
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

  it('does not keep a turn active after a tool result closes an anonymous tool call', () => {
    expect(hasActiveTimelineTurn([
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'tool.call', payload: { tool: 'Bash' } },
      { type: 'tool.result', payload: { output: 'done' } },
      { type: 'usage.update', payload: { model: 'gpt-5.5' } },
    ] as any)).toBe(false);
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

  it('does not let hidden SDK subagent wrapper calls keep the parent turn active after idle', () => {
    const sdkDetail = {
      kind: 'sdkSubagent',
      summary: 'Codex collaboration agent (1 receiver)',
      meta: {
        isSdkSubagent: true,
        schemaVersion: 1,
        provider: 'codex-sdk',
        providerKind: 'codexCollabAgent',
        canonicalKey: 'codex:deck_main_brain:call-spawn',
        normalizedStatus: 'running',
        active: true,
        terminal: false,
      },
    };
    expect(hasActiveTimelineTurn([
      { type: 'tool.call', payload: { toolCallId: 'call-spawn', tool: 'Codex Collaboration', detail: sdkDetail } },
      { type: 'session.state', payload: authoritativeIdlePayload },
      { type: 'assistant.text', payload: { text: 'spawned', streaming: false } },
    ] as any)).toBe(false);
  });

  it('does not revive the parent turn when SDK subagent heartbeats continue after idle', () => {
    const sdkDetail = {
      kind: 'sdkSubagent',
      summary: 'Godel',
      meta: {
        isSdkSubagent: true,
        schemaVersion: 1,
        provider: 'codex-sdk',
        providerKind: 'codexRuntimeAgent',
        canonicalKey: 'codex:deck_main_brain:runtime:agent-1',
        normalizedStatus: 'running',
        active: true,
        terminal: false,
        backgrounded: true,
      },
    };
    expect(isRunningTimelineEvent({
      type: 'tool.call',
      payload: { toolCallId: 'agent-1', tool: 'Codex Sub-agent', detail: sdkDetail },
    } as any)).toBe(false);
    expect(hasActiveTimelineTurn([
      { type: 'session.state', payload: authoritativeIdlePayload },
      { type: 'assistant.text', payload: { text: 'spawned', streaming: false } },
      { type: 'tool.call', payload: { toolCallId: 'agent-1', tool: 'Codex Sub-agent', detail: sdkDetail } },
      { type: 'tool.call', payload: { toolCallId: 'agent-1', tool: 'Codex Sub-agent', detail: sdkDetail } },
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

  /**
   * Regression for deck_sub_704c1g42 (2026-07-25 08:53:32 → 08:54:06): the
   * daemon emitted `session.state: running`, then the agent thought for 34 s
   * emitting only `agent.status` labels. The tail therefore ended at the
   * `memory.context` of that send, which used to fall through to `return false`
   * — reporting "no active turn" for the whole window. `SubSessionWindow` then
   * fed that into `resolveTimelineBackedSessionState`, whose stale-running guard
   * overrode the timeline's `running` with the store snapshot, and the footer
   * rendered IDLE while the agent was demonstrably editing files.
   */
  it('stays active through the memory.context tail of a context-injecting send', () => {
    const events = [
      { type: 'session.state', payload: authoritativeIdlePayload },
      { type: 'command.ack', payload: { commandId: 'cmd-x', status: 'accepted' } },
      { type: 'assistant.thinking', payload: { text: '' } },
      { type: 'session.state', payload: { state: 'running', blockingWorkCount: 3 } },
      { type: 'user.message', payload: { text: '远程桌面只干一件事那里 字幕缺了下载安装的字幕吧' } },
      { type: 'memory.context', payload: { query: 'x', injectedText: '[Related past work]' } },
      { type: 'agent.status', payload: { status: 'requesting', label: null } },
      { type: 'agent.status', payload: { status: 'thinking', label: 'Thinking (1.9k tokens)' } },
    ];
    expect(hasActiveTimelineTurn(events as any)).toBe(true);
  });

  it('stays active when telemetry metadata is the tail after real work', () => {
    // file.change / memory.compression / queue snapshots are pure metadata and
    // must not be read as "the turn ended".
    for (const tail of [
      { type: 'file.change', payload: { batch: {} } },
      { type: 'memory.compression', payload: { outcome: 'success' } },
      { type: 'transport.queue.snapshot', payload: {} },
      { type: 'peer_audit.status', payload: {} },
    ]) {
      expect(hasActiveTimelineTurn([
        { type: 'session.state', payload: { state: 'running', blockingWorkCount: 1 } },
        { type: 'user.message', payload: { text: 'go' } },
        { type: 'memory.context', payload: {} },
        tail,
      ] as any)).toBe(true);
    }
  });

  it('still reports inactive when metadata trails an authoritative clean idle', () => {
    // The fix must not resurrect a settled turn: walking through metadata has to
    // land on the authoritative idle and report no active work.
    expect(hasActiveTimelineTurn([
      { type: 'user.message', payload: { text: 'go' } },
      { type: 'tool.call', payload: { toolCallId: 'A', tool: 'Bash' } },
      { type: 'tool.result', payload: { toolCallId: 'A', terminalStatus: 'succeeded' } },
      { type: 'assistant.text', payload: { text: 'done', streaming: false } },
      { type: 'session.state', payload: authoritativeIdlePayload },
      { type: 'memory.compression', payload: { outcome: 'success' } },
      { type: 'memory.context', payload: {} },
    ] as any)).toBe(false);
  });
});
