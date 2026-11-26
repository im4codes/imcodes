/**
 * Integration tests verifying agy-sdk mid-turn finalization (`final: true`)
 * across `AgyAcpProvider` + `AgyTranscriptBridge` + `wireProviderToRelay`
 * during long `schedule` / steering turns without requiring subprocess spawning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const getSessionMock = vi.hoisted(() => vi.fn());
const getCachedPresetContextWindowMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: vi.fn(),
  },
}));

vi.mock('../../src/daemon/transport-history.js', () => ({
  appendTransportEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  resolveSessionName: (providerSid: string) => providerSid,
  getTransportRuntime: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
}));

vi.mock('../../src/daemon/cc-presets.js', () => ({
  getCachedPresetContextWindow: getCachedPresetContextWindowMock,
}));

import {
  setTransportRelaySend,
  wireProviderToRelay,
  __testing__ as relayTesting,
} from '../../src/daemon/transport-relay.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { appendTransportEvent } from '../../src/daemon/transport-history.js';
import { AgyAcpProvider } from '../../src/agent/providers/agy-acp.js';

function createWiredSession(
  provider: AgyAcpProvider,
  opts: { sessionId: string; nativeId: string; homeDir: string; authoritative?: boolean },
): { state: any; transcriptFile: string } {
  const transcriptFile = path.join(
    opts.homeDir,
    '.gemini',
    'antigravity-cli',
    'brain',
    opts.nativeId,
    '.system_generated',
    'logs',
    'transcript_full.jsonl',
  );
  mkdirSync(path.dirname(transcriptFile), { recursive: true });
  writeFileSync(transcriptFile, '');

  const state: Record<string, any> = {
    routeId: opts.sessionId,
    acpSessionId: opts.nativeId,
    cwd: opts.homeDir,
    env: { HOME: opts.homeDir },
    loaded: true,
    replaying: false,
    cancelled: false,
    stoppedByCancel: false,
    turnGeneration: 1,
    settledGeneration: 0,
    activePromptGenerations: new Set([1]),
    promptInFlight: true,
    currentMessageId: null,
    currentText: '',
    toolCalls: new Map(),
    emittedToolSignatures: new Map(),
    lastStatusSignature: null,
    agyForeground: opts.authoritative ? { authoritative: true, hasActiveLane: () => false, observe: () => false, releaseTurn: () => {}, hasBoundInput: () => false, release: () => {}, clear: () => {}, latest: undefined } : undefined,
  };

  (provider as any).sessions.set(opts.sessionId, state);
  (provider as any).acpToRoute.set(opts.nativeId, opts.sessionId);
  return { state, transcriptFile };
}

describe('agy-sdk schedule/long-turn assistant.text persistence via transport-relay', () => {
  let homeDir: string;
  let provider: AgyAcpProvider;
  let emitMock: ReturnType<typeof vi.fn>;
  let appendMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    relayTesting.resetRelayState();
    setTransportRelaySend(vi.fn());
    emitMock = vi.mocked(timelineEmitter.emit);
    emitMock.mockClear();
    appendMock = vi.mocked(appendTransportEvent);
    appendMock.mockClear();
    getSessionMock.mockReturnValue(undefined);
    getCachedPresetContextWindowMock.mockReturnValue(undefined);
    homeDir = mkdtempSync(path.join(tmpdir(), 'imcodes-agy-sched-'));
    provider = new AgyAcpProvider();
    wireProviderToRelay(provider);
  });

  afterEach(async () => {
    await provider.disconnect();
    rmSync(homeDir, { recursive: true, force: true });
    setTransportRelaySend(() => {});
  });

  it('upgrades streamed non-authoritative chunk in-place on PLANNER_RESPONSE DONE and resets for subsequent schedule wakeups', async () => {
    const sid = 'deck_soft_dev_rules_brain';
    const nativeId = '71c2f785-3cc7-45d8-932d-0b9f3e4c24ea';
    const { state, transcriptFile } = createWiredSession(provider, { sessionId: sid, nativeId, homeDir });
    await (provider as any).startAgyBridge(sid, state);

    // 1) Non-authoritative ACP streams a partial chunk while schedule keeps promptInFlight=true
    (provider as any).handleAgentChunk(sid, state, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Starting timer ' },
    });
    const firstMsgId = state.currentMessageId as string;
    expect(firstMsgId).toBeTruthy();
    expect(emitMock.mock.calls.some(([, type, payload]) => type === 'assistant.text' && payload.streaming === true)).toBe(true);
    expect(appendMock).not.toHaveBeenCalled();

    // 2) Transcript PLANNER_RESPONSE DONE arrives -> final:true reuses firstMsgId & persists immediately!
    appendFileSync(
      transcriptFile,
      JSON.stringify({
        step_index: 60644,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Starting timer for 600s.',
        tool_calls: [{ name: 'schedule' }],
      }) + '\n',
    );
    await vi.waitFor(() => {
      const persisted = appendMock.mock.calls.filter(([, evt]) => evt?.type === 'assistant.text');
      expect(persisted).toHaveLength(1);
    }, { timeout: 5000 });

    const final1 = emitMock.mock.calls.find(
      ([, type, payload, meta]) => type === 'assistant.text' && payload.streaming === false && meta?.eventId === `transport:${sid}:${firstMsgId}`,
    );
    expect(final1).toBeDefined();
    expect(final1![2].text).toBe('Starting timer for 600s.');
    expect(state.currentMessageId).toBeNull();
    expect(state.currentText).toBe('');

    // 3) Schedule fires 10m later inside the SAME open session/prompt RPC; ACP drops chunks,
    //    only transcript PLANNER_RESPONSE DONE is written (like step 60646 in live evidence).
    appendFileSync(
      transcriptFile,
      JSON.stringify({ step_index: 60645, type: 'GENERIC', status: 'DONE', content: 'Timer fired' }) + '\n'
      + JSON.stringify({
        step_index: 60646,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '服务器于 `19:25 UTC` 重启后，已恢复运行。',
        input_tokens: 12000,
        output_tokens: 45,
        cache_read_tokens: 8000,
      }) + '\n',
    );
    await vi.waitFor(() => {
      const persisted = appendMock.mock.calls.filter(([, evt]) => evt?.type === 'assistant.text');
      expect(persisted).toHaveLength(2);
    }, { timeout: 5000 });

    const final2 = emitMock.mock.calls.find(
      ([, type, payload, meta]) =>
        type === 'assistant.text'
        && payload.streaming === false
        && meta?.eventId === `transport:${sid}:${nativeId}:step:60646`,
    );
    expect(final2).toBeDefined();
    expect(final2![2].text).toBe('服务器于 `19:25 UTC` 重启后，已恢复运行。');

    // 4) Subsequent steering chunk with NO incoming messageId gets a fresh UUID and never concatenates
    (provider as any).handleAgentChunk(sid, state, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Steered reply.' },
    });
    const thirdMsgId = state.currentMessageId as string;
    expect(thirdMsgId).toBeTruthy();
    expect(thirdMsgId).not.toBe(firstMsgId);
    expect(state.currentText).toBe('Steered reply.');

    appendFileSync(
      transcriptFile,
      JSON.stringify({
        step_index: 60647,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Steered reply.',
      }) + '\n',
    );
    await vi.waitFor(() => {
      const persisted = appendMock.mock.calls.filter(([, evt]) => evt?.type === 'assistant.text');
      expect(persisted).toHaveLength(3);
    }, { timeout: 5000 });

    // 5) When session/prompt eventually settles, ZERO duplicate assistant.text bubbles are emitted
    //    while usage.update still emits cleanly.
    const countBeforeSettle = emitMock.mock.calls.filter(
      ([, type, payload]) => type === 'assistant.text' && payload.streaming === false,
    ).length;
    expect(countBeforeSettle).toBe(3);

    (provider as any).settleTurn(sid, state, 1, 'end_turn');
    expect(
      emitMock.mock.calls.filter(([, type, payload]) => type === 'assistant.text' && payload.streaming === false),
    ).toHaveLength(3);
    expect(
      appendMock.mock.calls.filter(([, evt]) => evt?.type === 'assistant.text').map(([, evt]) => evt.text),
    ).toEqual([
      'Starting timer for 600s.',
      '服务器于 `19:25 UTC` 重启后，已恢复运行。',
      'Steered reply.',
    ]);
    expect(emitMock.mock.calls.some(([, type]) => type === 'usage.update')).toBe(true);
  });

  it('persists authoritative long-turn PLANNER_RESPONSE steps immediately without duplicate on settleTurn', async () => {
    const sid = 'deck_agy_auth_long';
    const nativeId = 'native-auth-1';
    const { state, transcriptFile } = createWiredSession(provider, {
      sessionId: sid,
      nativeId,
      homeDir,
      authoritative: true,
    });
    await (provider as any).startAgyBridge(sid, state);

    appendFileSync(
      transcriptFile,
      JSON.stringify({
        step_index: 20,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Authoritative schedule step.',
        tool_calls: [{ name: 'schedule' }],
      }) + '\n',
    );
    await vi.waitFor(() => {
      const persisted = appendMock.mock.calls.filter(([, evt]) => evt?.type === 'assistant.text');
      expect(persisted).toHaveLength(1);
    }, { timeout: 5000 });

    expect(
      emitMock.mock.calls.filter(([, type, payload]) => type === 'assistant.text' && payload.streaming === false),
    ).toHaveLength(1);

    (provider as any).settleTurn(sid, state, 1, 'end_turn');
    expect(
      emitMock.mock.calls.filter(([, type, payload]) => type === 'assistant.text' && payload.streaming === false),
    ).toHaveLength(1);
  });

  it('enforces subagent, terminal status, compactControl, and lagging-watcher boundaries cleanly', () => {
    const sid = 'deck_agy_boundaries';
    const nativeId = 'native-bound-1';
    const { state } = createWiredSession(provider, { sessionId: sid, nativeId, homeDir });

    // Subagent, RUNNING, CANCELLED, ERROR, and whitespace rows must not emit assistant.text
    for (const row of [
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Spawn child', tool_calls: [{ name: 'invoke_subagent' }] },
      { step_index: 2, type: 'PLANNER_RESPONSE', status: 'RUNNING', content: 'Partial...' },
      { step_index: 3, type: 'PLANNER_RESPONSE', status: 'CANCELLED', content: 'Aborted' },
      { step_index: 4, type: 'PLANNER_RESPONSE', status: 'ERROR', content: 'Errored' },
      { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', content: '   \n  ' },
    ]) {
      (provider as any).handleAgyTranscriptRow(sid, state, nativeId, row);
    }
    state.agyCompactControl = true;
    (provider as any).handleAgyTranscriptRow(sid, state, nativeId, {
      step_index: 6,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'Leaked compact summary',
    });
    state.agyCompactControl = false;

    expect(emitMock.mock.calls.filter(([, type]) => type === 'assistant.text')).toHaveLength(0);
    expect(appendMock).not.toHaveBeenCalled();

    // Lagging-watcher race: ACP chunk moved on to step 8 text while step 7 transcript row arrives late
    (provider as any).handleAgentChunk(sid, state, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Part 1Part 2' },
    });
    const raceMsgId = state.currentMessageId as string;
    (provider as any).handleAgyTranscriptRow(sid, state, nativeId, {
      step_index: 7,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'Part 1',
      tool_calls: [{ name: 'run_command' }],
    });
    // Step 7 finalizes cleanly under its own step id without wiping active step 8 stream buffer
    expect(state.currentMessageId).toBe(raceMsgId);
    expect(state.currentText).toBe('Part 1Part 2');
    expect(
      appendMock.mock.calls.filter(([, evt]) => evt?.type === 'assistant.text' && evt.text === 'Part 1'),
    ).toHaveLength(1);
  });
});
