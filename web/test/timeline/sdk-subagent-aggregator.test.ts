import { describe, expect, it } from 'vitest';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_DIAGNOSTIC,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_SCHEMA_VERSION,
  SDK_SUBAGENT_STATUS,
  type SdkSubagentDetailMeta,
} from '../../../shared/sdk-subagent-status.js';
import type { TimelineEvent } from '../../src/ws-client.js';
import { deriveSdkSubagentStatusRows } from '../../src/timeline/sdk-subagent-aggregator.js';

const NOW = 1_700_000_500_000;

function makeMeta(overrides: Partial<SdkSubagentDetailMeta> = {}): SdkSubagentDetailMeta {
  return {
    isSdkSubagent: true,
    schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
    provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
    providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
    canonicalKey: 'claude:deck_main_brain:task-1',
    normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
    active: true,
    terminal: false,
    ...overrides,
  };
}

function makeEvent(
  eventId: string,
  meta: SdkSubagentDetailMeta | Record<string, unknown>,
  overrides: Partial<TimelineEvent> = {},
): TimelineEvent {
  return {
    eventId,
    sessionId: 'deck_main_brain',
    ts: NOW - 1_000,
    seq: 1,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type: 'tool.call',
    payload: {
      tool: 'Agent',
      detail: {
        kind: SDK_SUBAGENT_DETAIL_KIND,
        summary: 'Safe row summary',
        meta,
      },
    },
    ...overrides,
  };
}

function makeSessionStateEvent(eventId: string, state: string, ts = NOW - 500): TimelineEvent {
  return {
    eventId,
    sessionId: 'deck_main_brain',
    ts,
    seq: 1,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type: 'session.state',
    payload: { state },
  };
}

describe('deriveSdkSubagentStatusRows', () => {
  it('derives running rows from raw hidden events without transcript visibility state', () => {
    const event = makeEvent('hidden-running', makeMeta({ taskId: 'task-1', taskType: 'local_bash', model: 'haiku' }), { hidden: true });

    const result = deriveSdkSubagentStatusRows([event], NOW, { terminalTtlMs: 300_000, maxTerminalRows: 5 });

    expect(result.runningCount).toBe(1);
    expect(result.rows).toMatchObject([{
      canonicalKey: 'claude:deck_main_brain:task-1',
      summary: 'Safe row summary',
      startTs: NOW - 1_000,
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      model: 'haiku',
      taskId: 'task-1',
      taskType: 'local_bash',
    }]);
    expect(result.diagnostics).toEqual([]);
  });

  it('uses canonical-key latest wins for duplicate event ids and terminal monotonicity', () => {
    const running = makeEvent('dup', makeMeta({
      canonicalKey: 'claude:deck_main_brain:task-1',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
      rawStatus: 'running',
    }), { ts: NOW - 10_000, seq: 1 });
    const complete = makeEvent('dup', makeMeta({
      canonicalKey: 'claude:deck_main_brain:task-1',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      rawStatus: 'completed',
    }), { type: 'tool.result', ts: NOW - 5_000, seq: 2 });
    const lateRunning = makeEvent('dup', makeMeta({
      canonicalKey: 'claude:deck_main_brain:task-1',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
      rawStatus: 'running-late',
    }), { ts: NOW - 1_000, seq: 3 });

    const result = deriveSdkSubagentStatusRows([running, complete, lateRunning], NOW);

    expect(result.runningCount).toBe(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      rawStatus: 'completed',
      active: false,
      terminal: true,
    });
  });

  it('suppresses Claude runtime Agent fallback rows when a structured task row shares the tool id', () => {
    const runtimeFallback = makeEvent('runtime-agent', makeMeta({
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_RUNTIME_AGENT,
      canonicalKey: 'claude:deck_main_brain:runtime:tool-agent-1',
      parentToolUseId: 'tool-agent-1',
      agentPath: 'tool-agent-1',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    }), { ts: NOW - 2_000 });
    const structuredTask = makeEvent('structured-task', makeMeta({
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
      canonicalKey: 'claude:deck_main_brain:task-1',
      parentToolUseId: 'tool-agent-1',
      taskId: 'task-1',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    }), { ts: NOW - 1_000 });

    const result = deriveSdkSubagentStatusRows([runtimeFallback, structuredTask], NOW);

    expect(result.runningCount).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      canonicalKey: 'claude:deck_main_brain:task-1',
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
      parentToolUseId: 'tool-agent-1',
    });
  });

  it('retains only recent terminal stale rows and diagnostics, capped together', () => {
    const terminalEvents = Array.from({ length: 5 }, (_, index) => makeEvent(`terminal-${index}`, makeMeta({
      canonicalKey: `claude:deck_main_brain:task-${index}`,
      normalizedStatus: index === 0 ? SDK_SUBAGENT_STATUS.STALE : SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
    }), { type: 'tool.result', ts: NOW - ((index + 1) * 1_000) }));
    const oldTerminal = makeEvent('old-terminal', makeMeta({
      canonicalKey: 'claude:deck_main_brain:old',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
    }), { type: 'tool.result', ts: NOW - 400_000 });
    const diagnostic = makeEvent('diagnostic', makeMeta({
      canonicalKey: 'claude:deck_main_brain:diagnostic',
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
    }), { type: 'tool.result', ts: NOW - 500 });

    const result = deriveSdkSubagentStatusRows(
      [...terminalEvents, oldTerminal, diagnostic],
      NOW,
      { terminalTtlMs: 300_000, maxTerminalRows: 5 },
    );

    expect(result.rows.map((row) => row.canonicalKey)).not.toContain('claude:deck_main_brain:old');
    expect(result.rows.some((row) => row.normalizedStatus === SDK_SUBAGENT_STATUS.STALE)).toBe(true);
    expect(result.rows.length + result.diagnostics.length).toBe(5);
    expect(result.diagnostics).toMatchObject([{
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
      canonicalKey: 'claude:deck_main_brain:diagnostic',
    }]);
  });

  it('marks active rows stale after a later session finish and expires them by terminal retention', () => {
    const running = makeEvent('running-without-terminal', makeMeta({
      canonicalKey: 'claude:deck_main_brain:no-terminal',
      taskId: 'no-terminal',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    }), { ts: NOW - 20_000 });
    const idle = makeSessionStateEvent('parent-idle', 'idle', NOW - 1_000);

    const stale = deriveSdkSubagentStatusRows([running, idle], NOW, { terminalTtlMs: 300_000, maxTerminalRows: 5 });

    expect(stale.runningCount).toBe(0);
    expect(stale.rows).toMatchObject([{
      canonicalKey: 'claude:deck_main_brain:no-terminal',
      normalizedStatus: SDK_SUBAGENT_STATUS.STALE,
      active: false,
      terminal: true,
      eventId: 'parent-idle',
    }]);

    const expired = deriveSdkSubagentStatusRows(
      [running, idle],
      NOW + 301_000,
      { terminalTtlMs: 300_000, maxTerminalRows: 5 },
    );
    expect(expired.rows).toEqual([]);
    expect(expired.runningCount).toBe(0);
  });

  it('keeps backgrounded Codex subagents active after the parent session idles', () => {
    const running = makeEvent('backgrounded-codex-subagent', makeMeta({
      provider: SDK_SUBAGENT_PROVIDERS.CODEX_SDK,
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT,
      canonicalKey: 'codex:deck_main_brain:runtime:019e8422',
      parentItemId: 'codex:deck_main_brain:runtime:019e8422',
      agentPath: '019e8422',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
      backgrounded: true,
      usageTotalTokens: 168,
    }), { ts: NOW - 20_000 });
    const idle = makeSessionStateEvent('parent-idle', 'idle', NOW - 1_000);

    const result = deriveSdkSubagentStatusRows([running, idle], NOW);

    expect(result.runningCount).toBe(1);
    expect(result.rows).toMatchObject([{
      canonicalKey: 'codex:deck_main_brain:runtime:019e8422',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
      backgrounded: true,
      usageTotalTokens: 168,
    }]);
  });

  it('uses the first later session finish for stale retention', () => {
    const running = makeEvent('running-without-terminal', makeMeta({
      canonicalKey: 'claude:deck_main_brain:first-finish',
      taskId: 'first-finish',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    }), { ts: NOW - 20_000 });
    const firstIdle = makeSessionStateEvent('first-idle', 'idle', NOW - 10_000);
    const secondIdle = makeSessionStateEvent('second-idle', 'idle', NOW - 1_000);

    const result = deriveSdkSubagentStatusRows([running, firstIdle, secondIdle], NOW);

    expect(result.rows).toMatchObject([{
      canonicalKey: 'claude:deck_main_brain:first-finish',
      eventId: 'first-idle',
      ts: NOW - 10_000,
      normalizedStatus: SDK_SUBAGENT_STATUS.STALE,
    }]);
  });

  it('terminal diagnostic snapshots close an existing active row with the same canonical key', () => {
    const running = makeEvent('running-before-unknown', makeMeta({
      canonicalKey: 'claude:deck_main_brain:unknown-terminal',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
      rawStatus: 'running',
    }), { ts: NOW - 10_000 });
    const unknown = makeEvent('terminal-unknown', makeMeta({
      canonicalKey: 'claude:deck_main_brain:unknown-terminal',
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      rawStatus: 'pausedForMystery',
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
    }), { type: 'tool.result', ts: NOW - 1_000 });

    const result = deriveSdkSubagentStatusRows([running, unknown], NOW);

    expect(result.runningCount).toBe(0);
    expect(result.rows).toMatchObject([{
      canonicalKey: 'claude:deck_main_brain:unknown-terminal',
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      rawStatus: 'pausedForMystery',
    }]);
    expect(result.diagnostics).toMatchObject([{
      canonicalKey: 'claude:deck_main_brain:unknown-terminal',
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
    }]);
  });

  it('counts Codex running children and keeps receiver rows in receiver order', () => {
    const second = makeEvent('receiver-2', makeMeta({
      provider: SDK_SUBAGENT_PROVIDERS.CODEX_SDK,
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CODEX_COLLAB_AGENT,
      canonicalKey: 'codex:deck_main_brain:item-1:thread-b',
      parentItemId: 'item-1',
      receiverThreadId: 'thread-b',
      receiverIndex: 1,
    }), { ts: NOW - 2_000 });
    const first = makeEvent('receiver-1', makeMeta({
      provider: SDK_SUBAGENT_PROVIDERS.CODEX_SDK,
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CODEX_COLLAB_AGENT,
      canonicalKey: 'codex:deck_main_brain:item-1:thread-a',
      parentItemId: 'item-1',
      receiverThreadId: 'thread-a',
      receiverIndex: 0,
    }), { ts: NOW - 1_000 });

    const result = deriveSdkSubagentStatusRows([second, first], NOW);

    expect(result.runningCount).toBe(2);
    expect(result.rows.map((row) => row.receiverThreadId)).toEqual(['thread-a', 'thread-b']);
  });

  it('marks Codex collaboration wrapper rows stale after a later assistant message', () => {
    const running = makeEvent('codex-collab-running', makeMeta({
      provider: SDK_SUBAGENT_PROVIDERS.CODEX_SDK,
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CODEX_COLLAB_AGENT,
      canonicalKey: 'codex:deck_main_brain:call-spawn',
      parentItemId: 'call-spawn',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
      receiverCount: 1,
      runningChildCount: 1,
      childStatusSummary: 'pendingInit:1',
    }), { ts: NOW - 20_000 });
    const assistantText: TimelineEvent = {
      eventId: 'assistant-after-wrapper',
      sessionId: 'deck_main_brain',
      ts: NOW - 1_000,
      seq: 2,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: '已启动子代理。' },
    };

    const result = deriveSdkSubagentStatusRows([running, assistantText], NOW);

    expect(result.runningCount).toBe(0);
    expect(result.rows).toMatchObject([{
      canonicalKey: 'codex:deck_main_brain:call-spawn',
      normalizedStatus: SDK_SUBAGENT_STATUS.STALE,
      active: false,
      terminal: true,
      eventId: 'assistant-after-wrapper',
    }]);
  });

  it('diagnostic/unknown terminal event deletes active row so runningCount drops to 0', () => {
    // P0 fix: when a diagnostic or unknown-status terminal event arrives for a canonicalKey
    // that already has an active row, the active row must be deleted so runningCount
    // reflects the terminal state correctly.
    const running = makeEvent('running', makeMeta({
      canonicalKey: 'claude:deck_main_brain:task-1',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    }), { ts: NOW - 10_000 });
    const unknownDiagnostic = makeEvent('unknown-diag', makeMeta({
      canonicalKey: 'claude:deck_main_brain:task-1',
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
    }), { ts: NOW - 5_000 });

    const result = deriveSdkSubagentStatusRows([running, unknownDiagnostic], NOW);

    // Active row must be deleted by the diagnostic event; runningCount must be 0.
    expect(result.runningCount).toBe(0);
    const activeRows = result.rows.filter((r) => r.active && !r.terminal);
    expect(activeRows).toHaveLength(0);
    // The diagnostic must be retained.
    expect(result.diagnostics).toMatchObject([{
      canonicalKey: 'claude:deck_main_brain:task-1',
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
    }]);
  });

  it('diagnostic terminal event for same canonicalKey suppresses late running updates', () => {
    // Late running updates arriving after a diagnostic terminal must not reactivate the row.
    const running = makeEvent('running', makeMeta({
      canonicalKey: 'claude:deck_main_brain:task-1',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    }), { ts: NOW - 10_000 });
    const unknownDiagnostic = makeEvent('diag', makeMeta({
      canonicalKey: 'claude:deck_main_brain:task-1',
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
    }), { ts: NOW - 5_000 });
    const lateRunning = makeEvent('late-running', makeMeta({
      canonicalKey: 'claude:deck_main_brain:task-1',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    }), { ts: NOW - 1_000 });

    const result = deriveSdkSubagentStatusRows([running, unknownDiagnostic, lateRunning], NOW);

    expect(result.runningCount).toBe(0);
    const activeRows = result.rows.filter((r) => r.active && !r.terminal);
    expect(activeRows).toHaveLength(0);
  });

  it('ignores non-sdk details and reports malformed sdk metadata as diagnostics', () => {
    const ordinaryTool: TimelineEvent = {
      ...makeEvent('ordinary', makeMeta()),
      payload: { detail: { kind: 'toolUse', meta: { canonicalKey: 'ignored' } } },
    };
    const malformed = makeEvent('malformed', { canonicalKey: 'missing-required-fields' });

    const result = deriveSdkSubagentStatusRows([ordinaryTool, malformed], NOW);

    expect(result.rows).toEqual([]);
    expect(result.runningCount).toBe(0);
    expect(result.diagnostics).toMatchObject([{
      eventId: 'malformed',
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.MALFORMED_PAYLOAD,
    }]);
  });
});
