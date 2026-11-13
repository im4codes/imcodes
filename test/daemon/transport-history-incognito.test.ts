import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../shared/agent-message.js';
import type { ProviderError, ProviderStatusUpdate, TransportProvider } from '../../src/agent/transport-provider.js';
import { setSessionIncognito } from '../../shared/session-incognito-context.js';
import { appendTransportEvent, flushTransportHistory, replayTransportHistory } from '../../src/daemon/transport-history.js';
import { timelineProjection } from '../../src/daemon/timeline-projection.js';
import { timelineStore } from '../../src/daemon/timeline-store.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { flushStore, loadStore, removeSession, resetSessionStoreAuthorityForTests, upsertSession } from '../../src/store/session-store.js';
import {
  __testing__ as relayTesting,
  emitTransportUserMessage,
  forgetTransportRelaySession,
  wireProviderToRelay,
} from '../../src/daemon/transport-relay.js';

const { routedSessions } = vi.hoisted(() => ({
  routedSessions: new Map<string, string>(),
}));

vi.mock('../../src/agent/session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/session-manager.js')>();
  return {
    ...actual,
    resolveSessionName: (providerSid: string) => routedSessions.get(providerSid) ?? providerSid,
    getTransportRuntime: () => undefined,
  };
});

function createMockRelayProvider() {
  let deltaCb: ((sid: string, delta: MessageDelta) => void) | null = null;
  let completeCb: ((sid: string, msg: AgentMessage) => void) | null = null;
  let errorCb: ((sid: string, err: ProviderError) => void) | null = null;
  let toolCb: ((sid: string, tool: ToolCallEvent) => void) | null = null;
  let statusCb: ((sid: string, status: ProviderStatusUpdate) => void) | null = null;

  const provider = {
    id: 'claude-code-sdk',
    capabilities: { streaming: true, toolCalls: true, nativeAgentAdmission: 'none' },
    onDelta: (cb: typeof deltaCb) => { deltaCb = cb; },
    onComplete: (cb: typeof completeCb) => { completeCb = cb; },
    onError: (cb: typeof errorCb) => { errorCb = cb; },
    onToolCall: (cb: typeof toolCb) => { toolCb = cb; },
    onStatus: (cb: typeof statusCb) => { statusCb = cb; },
  } as unknown as TransportProvider;

  return {
    provider,
    emitDelta: (sid: string, delta: MessageDelta) => deltaCb?.(sid, delta),
    emitComplete: (sid: string, msg: AgentMessage) => completeCb?.(sid, msg),
    emitError: (sid: string, err: ProviderError) => errorCb?.(sid, err),
    emitToolCall: (sid: string, tool: ToolCallEvent) => toolCb?.(sid, tool),
    emitStatus: (sid: string, status: ProviderStatusUpdate) => statusCb?.(sid, status),
  };
}

describe('transport-history + transport-relay + timelineStore incognito isolation (F1)', () => {
  let tempHome = '';
  let prevHome: string | undefined;
  let prevImcodesHome: string | undefined;
  const sessionName = 'deck_f1_incognito_brain';

  beforeEach(async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'incognito-f1-'));
    prevHome = process.env.HOME;
    prevImcodesHome = process.env.IMCODES_HOME;
    process.env.HOME = tempHome;
    process.env.IMCODES_HOME = join(tempHome, '.imcodes');
    resetSessionStoreAuthorityForTests();
    await loadStore();
    routedSessions.clear();
    relayTesting.resetRelayState();
    setSessionIncognito(sessionName, false);
    removeSession(sessionName);
  });

  afterEach(async () => {
    forgetTransportRelaySession(sessionName);
    timelineEmitter.forgetSession(sessionName);
    await flushTransportHistory();
    await timelineStore.flushAll(5_000);
    await timelineProjection.drain(5_000);
    await timelineProjection.shutdown();
    await timelineEmitter.drainUsageWrites(3_000);
    setSessionIncognito(sessionName, false);
    removeSession(sessionName);
    await flushStore().catch(() => {});
    process.env.HOME = prevHome;
    if (prevImcodesHome === undefined) delete process.env.IMCODES_HOME;
    else process.env.IMCODES_HOME = prevImcodesHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('blocks direct appendTransportEvent, relay callbacks, and old normal history reads/truncation while private', async () => {
    const imcodesDir = process.env.IMCODES_HOME!;
    const transportDir = join(imcodesDir, 'transport');
    const timelineDir = join(imcodesDir, 'timeline');
    mkdirSync(transportDir, { recursive: true });
    mkdirSync(timelineDir, { recursive: true });

    const transportPath = join(transportDir, `${sessionName}.jsonl`);
    const timelinePath = join(timelineDir, `${sessionName}.jsonl`);
    const preExistingTransportLine = `${JSON.stringify({ type: 'assistant.text', sessionId: sessionName, text: 'prior-normal-disk-entry', _ts: 1000 })}\n`;
    const preExistingTimelineLine = `${JSON.stringify({ eventId: 'old-1', sessionId: sessionName, ts: 1000, epoch: 1, seq: 1, type: 'assistant.text', source: 'daemon', confidence: 'high', payload: { text: 'prior-normal-timeline' } })}\n`;
    writeFileSync(transportPath, preExistingTransportLine, 'utf8');
    writeFileSync(timelinePath, preExistingTimelineLine, 'utf8');

    upsertSession({
      name: sessionName,
      projectName: 'f1_incognito',
      role: 'brain',
      agentType: 'claude-code-sdk',
      state: 'running',
      projectDir: tempHome,
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      incognito: true,
    });
    setSessionIncognito(sessionName, true);

    const mock = createMockRelayProvider();
    wireProviderToRelay(mock.provider);
    routedSessions.set('provider-priv-1', sessionName);

    // Drive every relay callback + direct transport append
    emitTransportUserMessage(sessionName, 'SECRET-USER-PROMPT');
    mock.emitDelta('provider-priv-1', { messageId: 'm1', delta: 'SECRET-FIRST-PARTIAL', role: 'assistant' });
    mock.emitDelta('provider-priv-1', { messageId: 'm2', delta: 'SECRET-SECOND-PARTIAL', role: 'assistant' });
    mock.emitToolCall('provider-priv-1', { id: 'tool-1', name: 'Bash', status: 'running', input: { command: 'echo SECRET-CMD' } });
    mock.emitToolCall('provider-priv-1', { id: 'tool-1', name: 'Bash', status: 'complete', output: 'SECRET-TOOL-OUTPUT' });
    mock.emitComplete('provider-priv-1', { id: 'm2', role: 'assistant', content: 'SECRET-FINAL-ASSISTANT-REPLY' });
    mock.emitError('provider-priv-1', { code: 'PROVIDER_ERROR', message: 'SECRET-PROVIDER-ERROR', recoverable: true });
    await appendTransportEvent(sessionName, { type: 'assistant.text', sessionId: sessionName, text: 'SECRET-DIRECT-BYPASS' });

    await flushTransportHistory();
    await timelineStore.flushSession(sessionName);

    // Prior normal disk history must be completely untouched and zero private bytes written
    const transportBytes = readFileSync(transportPath, 'utf8');
    const timelineBytes = readFileSync(timelinePath, 'utf8');
    expect(transportBytes).toBe(preExistingTransportLine);
    expect(timelineBytes).toBe(preExistingTimelineLine);
    expect(transportBytes).not.toContain('SECRET-');
    expect(timelineBytes).not.toContain('SECRET-');

    // Replay and timelineStore read/getLatest/truncate must return empty / not leak or mutate disk
    await expect(replayTransportHistory(sessionName)).resolves.toEqual([]);
    expect(timelineStore.read(sessionName)).toEqual([]);
    expect(timelineStore.getLatest(sessionName)).toBeNull();
    await timelineStore.truncate(sessionName, 0);
    expect(readFileSync(timelinePath, 'utf8')).toBe(preExistingTimelineLine);
  });

  it('recovers transport + relay persistence cleanly when a new ordinary session reuses the same name', async () => {
    // Run and close a private session with an unfinished in-flight delta
    upsertSession({
      name: sessionName,
      projectName: 'f1_incognito',
      role: 'brain',
      agentType: 'claude-code-sdk',
      state: 'running',
      projectDir: tempHome,
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      incognito: true,
    });
    setSessionIncognito(sessionName, true);

    const mock = createMockRelayProvider();
    wireProviderToRelay(mock.provider);
    routedSessions.set('provider-priv-2', sessionName);

    mock.emitDelta('provider-priv-2', { messageId: 'priv-msg', delta: 'SECRET-UNFINISHED-INFLIGHT', role: 'assistant' });

    // Close private session cleanly
    forgetTransportRelaySession(sessionName);
    timelineEmitter.forgetSession(sessionName);
    removeSession(sessionName);
    setSessionIncognito(sessionName, false);

    // Launch a new normal session with the same sessionName
    upsertSession({
      name: sessionName,
      projectName: 'f1_incognito',
      role: 'brain',
      agentType: 'claude-code-sdk',
      state: 'running',
      projectDir: tempHome,
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      incognito: false,
    });
    routedSessions.set('provider-norm-1', sessionName);

    mock.emitDelta('provider-norm-1', { messageId: 'norm-msg', delta: 'ORDINARY-STREAM', role: 'assistant' });
    mock.emitComplete('provider-norm-1', { id: 'norm-msg', role: 'assistant', content: 'ORDINARY-FINAL' });

    await flushTransportHistory();
    await timelineStore.flushSession(sessionName);

    const transportPath = join(process.env.IMCODES_HOME!, 'transport', `${sessionName}.jsonl`);
    expect(existsSync(transportPath)).toBe(true);
    const replayed = await replayTransportHistory(sessionName);
    expect(replayed.some((e) => e.text === 'ORDINARY-FINAL')).toBe(true);
    expect(JSON.stringify(replayed)).not.toContain('SECRET-UNFINISHED-INFLIGHT');
  });

  it('drains fire-and-forget transport/timeline writes cleanly across IMCODES_HOME switches so immediate tempHome cleanup never hits ENOTEMPTY', async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const cycleHome = mkdtempSync(join(tmpdir(), `incognito-f1-cycle-${cycle}-`));
      process.env.HOME = cycleHome;
      process.env.IMCODES_HOME = join(cycleHome, '.imcodes');
      resetSessionStoreAuthorityForTests();
      await loadStore();

      upsertSession({
        name: sessionName,
        projectName: 'f1_incognito',
        role: 'brain',
        agentType: 'claude-code-sdk',
        state: 'running',
        projectDir: cycleHome,
        restarts: 0,
        restartTimestamps: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        incognito: false,
      });

      const mock = createMockRelayProvider();
      wireProviderToRelay(mock.provider);
      routedSessions.set(`provider-cycle-${cycle}`, sessionName);

      mock.emitComplete(`provider-cycle-${cycle}`, {
        id: `cycle-msg-${cycle}`,
        role: 'assistant',
        content: `CYCLE-FINAL-${cycle}`,
      });

      await flushTransportHistory();
      await timelineStore.flushAll(5_000);
      await timelineProjection.drain(5_000);
      await timelineProjection.shutdown();
      forgetTransportRelaySession(sessionName);
      timelineEmitter.forgetSession(sessionName);
      removeSession(sessionName);
      await flushStore();

      expect(existsSync(join(cycleHome, '.imcodes', 'transport', `${sessionName}.jsonl`))).toBe(true);
      expect(() => rmSync(cycleHome, { recursive: true, force: true })).not.toThrow();
    }
  });
});
