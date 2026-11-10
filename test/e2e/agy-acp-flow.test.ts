import { PROVIDER_ERROR_CODES } from '../../src/agent/transport-provider.js';
import { handleWebCommand, runWithProcessSessionSendLock, switchSessionModelNow } from '../../src/daemon/command-handler.js';
import { SESSION_MODEL_APPLIED } from '../../shared/session-model-control.js';
import { SESSION_MODEL_COMMAND } from '../../shared/session-control-commands.js';
import { AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES } from '../../shared/agent-delegation.js';
import { AGY_ACP_AGENT_NAME } from '../../shared/agy-agent.js';
import { mkdtemp, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectProvider, disconnectAll, getProvider } from '../../src/agent/provider-registry.js';
import { launchTransportSession, getTransportRuntime, stopTransportRuntimeSession } from '../../src/agent/session-manager.js';
import { getSession, flushStore, removeSession, authorizeEmptySessionStoreWrite } from '../../src/store/session-store.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';
import { AGY_NATIVE_SESSION_STATE, AGY_SDK_PROVIDER_ID } from '../../shared/agy-agent.js';
import { isKnownTestSessionLike } from '../../shared/test-session-guard.js';
import { getTransportQueueStore } from '../../src/daemon/transport-queue-store.js';
import { imcodesStateDir } from '../../src/util/imcodes-state-dir.js';
import { isRealImcodesPath } from '../../src/util/test-home-guard.js';
import { getActiveThinkingTs, getActiveStatusText, getTailSessionStateInfo, hasActiveToolCall } from '../../web/src/thinking-utils.js';
import { hasActiveTimelineTurn, hasPendingUserSend } from '../../web/src/timeline-running.js';
import { getLatestTransportActivityDetail } from '../../web/src/transport-activity-status.js';
import { deriveSessionLiveStatus, resolveTimelineBackedSessionState } from '../../web/src/session-live-status.js';

vi.mock('@shared/session-control-commands.js', () => import('../../shared/session-control-commands.js'));
vi.mock('@shared/capacity-retry.js', () => import('../../shared/capacity-retry.js'));

const NAME = 'deck_e2e_agy_acp_brain';
const PROJECT = 'e2e_agy_acp';
let root: string, log: string, off: (() => void) | undefined;
let events: TimelineEvent[];
const requests = async () => (await readFile(log, 'utf8')).trim().split('\n').map(x => JSON.parse(x));
const finalized = () => events.filter(e => e.type === 'assistant.text' && e.payload.streaming === false && !e.payload.automation);
beforeEach(async () => {
  // Each case creates a new session owner with this synthetic name. Retire the
  // prior owner's latest-value dedupe snapshots before asserting new frames.
  timelineEmitter.forgetSession(NAME);
  root = await mkdtemp(path.join(tmpdir(), 'imcodes-e2e-agy-acp-')); log = path.join(root, 'rpc.jsonl'); events = [];
  expect(isKnownTestSessionLike({ name: NAME, projectName: PROJECT, projectDir: root })).toBe(true);
  const binary = path.join(root, 'agy');
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve('test/fixtures/agy-acp.mjs')}' "$@"\n`, { mode: 0o700 });
  off = timelineEmitter.on(e => { if (e.sessionId === NAME) events.push(e); });
  await connectProvider(AGY_SDK_PROVIDER_ID, { binaryPath: binary, env: { HOME: root, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME, AGY_ACP_FIXTURE_LOG: log } });
  await launchTransportSession({ name: NAME, projectName: PROJECT, projectDir: root, role: 'brain', agentType: AGY_SDK_PROVIDER_ID });
});
afterEach(async () => { off?.(); await stopTransportRuntimeSession(NAME); removeSession(NAME); await disconnectAll(); await rm(root, { recursive: true, force: true }); });
describe('real AG ACP SDK/runtime/durable store/relay', () => {
  it.each(['model-b', 'model-a'])('applies loaded idle ACP model %s now instead of unconditional next-start', async model => {
    const runtime = getTransportRuntime(NAME)!;
    runtime.send('WARM_MODEL', 'e2e-agy-model-warm');
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    expect(getSession(NAME)?.activeModel).toBe('model-a');
    const before = (await requests()).filter(row => row.method === 'session/prompt').length;
    const result = await switchSessionModelNow(NAME, model);
    expect(result).toMatchObject({ ok: true, model, applied: SESSION_MODEL_APPLIED.LIVE });
    expect(getSession(NAME)).toMatchObject({ requestedModel: model, activeModel: model });
    expect((await requests()).filter(row => row.method === 'session/prompt')).toHaveLength(before);
  });

  it('selects pending B then C during A without the send mutex, keeps actual A through append/completion, and uses C next', async () => {
    const runtime = getTransportRuntime(NAME)!;
    const nativeCompletions: unknown[] = [];
    getProvider(AGY_SDK_PROVIDER_ID)!.onComplete((_sid, message) => nativeCompletions.push(message.metadata));
    await writeFile(log + '.hold', 'hold');
    runtime.send('RUN_A', 'e2e-agy-live-model-a');
    await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/prompt')).toBe(true));
    let unlock!: () => void;
    const held = new Promise<void>(resolve => { unlock = resolve; });
    let locked!: () => void;
    const entered = new Promise<void>(resolve => { locked = resolve; });
    const lock = runWithProcessSessionSendLock(NAME, async () => { locked(); await held; });
    await entered;
    try {
      const link = { send: vi.fn(), daemonVersion: 'fixture' };
      handleWebCommand({ type: 'session.send', session: NAME, text: '/model model-b', commandId: 'e2e-agy-browser-model-b' }, link as any);
      await vi.waitFor(() => expect(events.some(event => event.type === 'command.ack' && event.payload.commandId === 'e2e-agy-browser-model-b' && event.payload.status === 'accepted')).toBe(true), { timeout: 5000 });
      for (const model of ['model-b', 'model-c']) {
        const result = await Promise.race([
          switchSessionModelNow(NAME, model),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('model queued behind send mutex')), 350)),
        ]);
        expect(result).toMatchObject({ ok: true, model, applied: SESSION_MODEL_APPLIED.NEXT_START });
        expect(runtime.sending).toBe(true);
        expect(getSession(NAME)).toMatchObject({ requestedModel: model, activeModel: 'model-a', modelDisplay: 'model-a' });
        expect(events.some(event => event.type === 'usage.update' && event.payload.model === model)).toBe(false);
      }
      expect(await switchSessionModelNow(NAME, 'model-c')).toMatchObject({ ok: true, applied: SESSION_MODEL_APPLIED.NEXT_START });
      await runtime.appendExternalMessageToActiveTurn('APPEND_STAYS_A', 'model-selection-append');
      expect(finalized()).toHaveLength(0);
    } finally { unlock(); await lock; await unlink(log + '.hold'); }
    const rows = await requests();
    expect(rows.filter(row => row.method === 'session/set_model').map(row => row.params.modelId)).toEqual(['model-b', 'model-c']);
    expect(new Set(rows.filter(row => row.method === 'session/set_model' || row.method === 'session/prompt').map(row => row.params.sessionId)).size).toBe(1);
    expect(rows.some(row => row.method === 'session/cancel')).toBe(false);
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    expect(finalized()).toHaveLength(1);
    expect(nativeCompletions).toEqual([expect.objectContaining({ model: 'model-a' })]);
    expect(getSession(NAME)).toMatchObject({ requestedModel: 'model-c', activeModel: 'model-a' });
    await vi.waitFor(() => expect(events.filter(event => event.type === 'usage.update' && typeof event.payload.model === 'string').at(-1)?.payload.model, 'current turn usage keeps A').toBe('model-a'));
    expect(rows.filter(row => row.fixture === 'prompt-model').map(row => row.model)).toEqual(['model-a', 'model-a']);
    runtime.send('NEXT_WITH_C', 'e2e-agy-next-selected-c');
    await vi.waitFor(() => expect(finalized()).toHaveLength(2), { timeout: 5000 });
    expect(getSession(NAME)).toMatchObject({ requestedModel: 'model-c', activeModel: 'model-c' });
    await vi.waitFor(() => expect(events.filter(event => event.type === 'usage.update' && typeof event.payload.model === 'string').at(-1)?.payload.model).toBe('model-c'));
    expect((await requests()).filter(row => row.fixture === 'prompt-model').at(-1).model).toBe('model-c');
  });

  it('rejects an older model intent whose catalogue lookup finishes after C', async () => {
    const runtime = getTransportRuntime(NAME)!;
    runtime.send('WARM_MODEL', 'e2e-agy-model-catalogue');
    await vi.waitFor(() => expect(runtime.sending).toBe(false), { timeout: 5000 });
    const provider = getProvider(AGY_SDK_PROVIDER_ID)!;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const observed = new Promise<void>(resolve => { entered = resolve; });
    const original = provider.listModels!.bind(provider);
    const probe = vi.spyOn(provider, 'listModels').mockImplementationOnce(async () => { entered(); await gate; return original(); });
    const old = switchSessionModelNow(NAME, 'model-b');
    await observed;
    try {
      expect(await switchSessionModelNow(NAME, 'model-c')).toMatchObject({ ok: true, applied: SESSION_MODEL_APPLIED.LIVE });
    } finally { release(); }
    expect(await old).toMatchObject({ ok: false });
    expect(getSession(NAME)).toMatchObject({ activeModel: 'model-c', requestedModel: 'model-c' });
    expect((await requests()).filter(row => row.method === 'session/set_model').map(row => row.params.modelId)).toEqual(['model-c']);
    probe.mockRestore();
  });

  it('admits human Append and MCP append during A, no premature completion/FIFO replay, persists exact native identity', async () => {
    const runtime = getTransportRuntime(NAME)!;
    expect(getProvider(AGY_SDK_PROVIDER_ID)?.capabilities.activeDelegationNotification).toBe(AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE);
    expect(getSession(NAME)?.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.UNSTARTED);
    runtime.send('RUN_A', 'e2e-agy-acp-a');
    await vi.waitFor(async () => expect((await requests()).some(x => x.method === 'session/prompt')).toBe(true));
    expect(getSession(NAME)?.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.STARTED);
    runtime.send('HUMAN_B', 'e2e-agy-acp-b');
    expect(runtime.pendingEntries.some(x => x.clientMessageId === 'e2e-agy-acp-b')).toBe(true);
    const appended = await runtime.appendPendingMessagesToActiveTurn(['e2e-agy-acp-b'], 'e2e-agy-acp-human-append');
    expect(appended.status).toBe('delivered');
    await runtime.appendExternalMessageToActiveTurn('MCP_C', 'e2e-agy-acp-c');
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(3));
    expect(finalized()).toHaveLength(0); expect(runtime.getStatus()).not.toBe('idle');
    await vi.waitFor(() => expect(finalized()).toHaveLength(1));
    expect(finalized()[0]?.payload.text).toContain('RUN_A');
    expect(finalized()[0]?.payload.text).toContain('HUMAN_B'); expect(finalized()[0]?.payload.text).toContain('MCP_C');
    await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
    expect(runtime.pendingCount).toBe(0);
    expect(getTransportQueueStore().hasDeliveryTombstone(NAME, 'e2e-agy-acp-b')).toBe(true);
    expect(getTransportQueueStore().hasDeliveryTombstone(NAME, 'e2e-agy-acp-c')).toBe(true);
    const rows = await requests(); const prompts = rows.filter(x => x.method === 'session/prompt');
    expect(new Set(prompts.map(x => x.params.sessionId)).size).toBe(1);
    expect(rows.some(x => x.method === 'session/cancel')).toBe(false);
    await flushStore();
    expect(getSession(NAME)?.providerResumeId).toBe(prompts[0]?.params.sessionId);
    expect(getSession(NAME)?.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.STARTED);
  });
  it('keeps ordinary busy messages in durable FIFO until the current native run completes', async () => {
    const runtime = getTransportRuntime(NAME)!; runtime.send('RUN_A', 'fifo-a');
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(1));
    runtime.send('ORDINARY_D', 'fifo-d'); expect(runtime.pendingCount).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 40)); expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(1);
    await vi.waitFor(() => expect(finalized()).toHaveLength(2));
    expect(finalized()[0]?.payload.text).not.toContain('ORDINARY_D'); expect(finalized()[1]?.payload.text).toContain('ORDINARY_D');
    expect(runtime.pendingCount).toBe(0);
  });
  it.each(['reordered', 'reject-b'])('Stop-and-send preserves selected IDs and FIFO after a retired/rejected last RPC (%s)', async scenario => {
    const runtime = getTransportRuntime(NAME)!, provider = getProvider(AGY_SDK_PROVIDER_ID)!;
    // Switch only the task-owned native peer before any model/session call.
    await provider.connect({ binaryPath: path.join(root, 'agy'), env: { HOME: root, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME, AGY_ACP_FIXTURE_LOG: log, AGY_ACP_FIXTURE_SCENARIO: scenario, AGY_ACP_FIXTURE_REPLY_GAP_MS: '500' } });
    const selectedId = `stop-selected-${scenario}`, fifoId = `stop-fifo-${scenario}`;
    runtime.send('RUN_A', `stop-original-${scenario}`);
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(1));
    const providerSessionId = (runtime as any)._providerSessionId as string;
    expect(typeof providerSessionId).toBe('string');
    await provider.notifyActiveDelegation!(providerSessionId, { notificationId: 'stop-steer-b', text: 'B' });
    const state = (provider as any).sessions.get(providerSessionId);
    await (provider as any).promptTerminals.get(state).catch(() => {});
    expect(provider.getSessionDiagnostics!(providerSessionId)?.promptInFlight).toBe(true);
    // A model command is intentionally not a native delegation append. This
    // exercises the real strong-Stop fallback, not a mocked capability/ACK.
    const selected = `${SESSION_MODEL_COMMAND} model-b`;
    runtime.send(selected, selectedId);
    runtime.send('FIFO_D', fifoId);
    expect(runtime.pendingEntries.map(entry => entry.clientMessageId)).toEqual([selectedId, fifoId]);
    const operation = runtime.stopAndSendPendingMessages([selectedId], 'stop-click');
    await expect(operation).resolves.toMatchObject({ status: 'stopped_and_dispatched' });
    await vi.waitFor(() => expect(runtime.pendingCount).toBe(0));
    await vi.waitFor(async () => {
      const prompts = (await requests()).filter(x => x.method === 'session/prompt');
      expect(prompts).toHaveLength(4);
      expect(prompts.slice(2).map(x => x.params.prompt[0].text)).toEqual([expect.stringContaining(selected), expect.stringContaining('FIFO_D')]);
    });
    await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
    expect(await runtime.stopAndSendPendingMessages([selectedId], 'same-id-retry')).toMatchObject({ status: 'already_delivered' });
    const rows = await requests(); expect(rows.filter(x => x.method === 'session/cancel')).toHaveLength(1);
    expect(rows.filter(x => x.method === 'session/prompt' && x.params.prompt[0].text.includes(selected))).toHaveLength(1);
    expect(rows.filter(x => x.method === 'session/prompt' && x.params.prompt[0].text.includes('FIFO_D'))).toHaveLength(1);
    const output = finalized();
    expect(output.filter(e => e.payload.text.includes(selected))).toHaveLength(1);
    expect(output.filter(e => e.payload.text.includes('FIFO_D'))).toHaveLength(1);
    // The old run has one diagnostic terminal (partial text on Stop or a
    // real RPC error), plus exactly one final per subsequent queued turn.
    expect(output).toHaveLength(3);
    const oldTerminal = output.filter(e => e.payload.providerErrorCode);
    expect(oldTerminal).toHaveLength(1);
    expect(oldTerminal[0]?.payload.providerErrorCode).toBe(scenario === 'reject-b' ? PROVIDER_ERROR_CODES.PROVIDER_ERROR : PROVIDER_ERROR_CODES.CANCELLED);
  });
  it('retains native identity across actual provider process restart without session/new fallback', async () => {
    const runtime = getTransportRuntime(NAME)!; runtime.send('RUN_A', 'restart-a');
    await vi.waitFor(() => expect(finalized()).toHaveLength(1)); await flushStore();
    const saved = getSession(NAME)!; const native = saved.providerResumeId as string;
    const provider = getProvider(AGY_SDK_PROVIDER_ID)!;
    await provider.disconnect();
    const binary = path.join(root, 'agy'); await provider.connect({ binaryPath: binary, env: { HOME: root, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME, AGY_ACP_FIXTURE_LOG: log } });
    const resumed = await provider.createSession({ sessionKey: 'deck_e2e_agy_acp_restored', resumeId: native, cwd: root });
    const done = vi.fn(); const unsubscribe = provider.onComplete(done);
    try { await provider.send(resumed, 'after restart'); await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1)); }
    finally { unsubscribe(); }
    const rows = await requests(); expect(rows.filter(x => x.method === 'session/new')).toHaveLength(1);
    expect(rows.filter(x => x.method === 'session/resume').map(x => x.params.sessionId)).toEqual([native]);
    expect(done.mock.calls[0]?.[1].metadata.resumeId).toBe(native);
  });
  it('automatically drives persisted SQLite state, relay timeline events, and frontend live-status projection across A + steered B/C without manual store writes', async () => {
    const persistedDir = await mkdtemp(path.join(tmpdir(), 'imcodes-ag-prodchain-'));
    const persistedName = 'deck_ag_prodchain_brain';
    const persistedProject = 'ag_prodchain';
    const persistedEvents: TimelineEvent[] = [];
    const offPersisted = timelineEmitter.on(e => { if (e.sessionId === persistedName) persistedEvents.push(e); });
    const dbPath = path.join(imcodesStateDir(), 'sessions.sqlite');
    const readPersistedSqliteRow = () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db.prepare('SELECT state, payload, updated_at FROM sessions WHERE name = ?').get(persistedName) as
          | { state: string; payload: string; updated_at: number }
          | undefined;
        return row ? { state: row.state, updatedAt: row.updated_at, record: JSON.parse(row.payload) as Record<string, unknown> } : null;
      } finally {
        db.close();
      }
    };
    const projectLiveStatus = (sqliteState: string | null) => {
      const activeThinkingTs = getActiveThinkingTs(persistedEvents);
      const statusText = getActiveStatusText(persistedEvents);
      const activeToolCall = hasActiveToolCall(persistedEvents);
      const pendingUserSend = hasPendingUserSend(persistedEvents);
      const transportActivityDetail = getLatestTransportActivityDetail(persistedEvents);
      const tailState = getTailSessionStateInfo(persistedEvents);
      const timelineLastEventTs = persistedEvents.length > 0 ? (persistedEvents[persistedEvents.length - 1]?.ts ?? null) : null;
      const activeTransportTurn = hasActiveTimelineTurn(persistedEvents);
      const resolvedSessionState = resolveTimelineBackedSessionState({
        timelineState: tailState.state,
        sessionState: sqliteState,
        activeThinking: !!activeThinkingTs,
        activeToolCall,
        activeTransportTurn,
        timelineStateTs: tailState.ts,
        timelineLastEventTs,
      });
      const liveStatus = deriveSessionLiveStatus({
        sessionState: resolvedSessionState,
        activeThinking: !!activeThinkingTs,
        activeToolCall,
        activeTransportTurn,
        pendingUserSend,
        statusText,
        transportActivityDetail,
      });
      return {
        activeThinking: !!activeThinkingTs,
        activeToolCall,
        activeTransportTurn,
        statusText,
        tailTimelineState: tailState.state,
        sqliteState,
        resolvedSessionState,
        liveStatus,
      };
    };

    try {
      expect(isRealImcodesPath(imcodesStateDir())).toBe(false);
      expect(isKnownTestSessionLike({ name: persistedName, projectName: persistedProject, projectDir: persistedDir })).toBe(false);
      const provider = getProvider(AGY_SDK_PROVIDER_ID)!;
      await provider.connect({
        binaryPath: path.join(root, 'agy'),
        env: {
          HOME: root,
          AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME,
          AGY_ACP_FIXTURE_LOG: log,
          AGY_ACP_FIXTURE_SCENARIO: 'reordered',
          AGY_ACP_FIXTURE_REPLY_GAP_MS: '120',
        },
      });
      await launchTransportSession({
        name: persistedName,
        projectName: persistedProject,
        projectDir: persistedDir,
        role: 'brain',
        agentType: AGY_SDK_PROVIDER_ID,
      });
      const runtime = getTransportRuntime(persistedName)!;
      await flushStore();

      // Stage 1: Initial idle before any prompt is sent
      const stage1Sqlite = readPersistedSqliteRow();
      expect(runtime.getStatus()).toBe('idle');
      expect(stage1Sqlite?.state).toBe('idle');
      expect(stage1Sqlite?.record.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.UNSTARTED);
      const stage1Projection = projectLiveStatus(stage1Sqlite?.state ?? null);
      expect(stage1Projection.resolvedSessionState).toBe('idle');
      expect(stage1Projection.liveStatus.busy).toBe(false);
      expect(stage1Projection.liveStatus.visualMode).toBe('idle');

      // Stage 2: Send RUN_A, wait for native tool.call, steer HUMAN_B and MCP_C while in-flight
      runtime.send('RUN_A', 'prodchain-a');
      await vi.waitFor(() => expect(persistedEvents.some(e => e.type === 'tool.call' && e.payload.toolCallId === 'sleep')).toBe(true));
      expect(await switchSessionModelNow(persistedName, 'model-b')).toMatchObject({ ok: true, applied: SESSION_MODEL_APPLIED.NEXT_START });
      runtime.send('HUMAN_B', 'prodchain-b');
      const appendB = await runtime.appendPendingMessagesToActiveTurn(['prodchain-b'], 'prodchain-append-b');
      expect(appendB.status).toBe('delivered');
      const appendC = await runtime.appendExternalMessageToActiveTurn('MCP_C', 'prodchain-c');
      expect(appendC).toBe('queued');
      await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(3));
      expect(getTransportQueueStore().hasDeliveryTombstone(persistedName, 'prodchain-b')).toBe(true);
      expect(getTransportQueueStore().hasDeliveryTombstone(persistedName, 'prodchain-c')).toBe(true);
      await flushStore();

      const stage2RuntimeStatus = runtime.getStatus();
      const stage2Sqlite = readPersistedSqliteRow();
      expect(stage2RuntimeStatus).not.toBe('idle');
      expect(stage2Sqlite?.state).toBe('running');
      expect(stage2Sqlite?.record).toMatchObject({ requestedModel: 'model-b', activeModel: 'model-a', modelDisplay: 'model-a' });
      expect(stage2Sqlite?.record.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.STARTED);
      const stage2Projection = projectLiveStatus(stage2Sqlite?.state ?? null);
      expect(stage2Projection.activeToolCall).toBe(true);
      expect(stage2Projection.activeTransportTurn).toBe(true);
      expect(stage2Projection.resolvedSessionState).toBe('running');
      expect(stage2Projection.liveStatus.busy).toBe(true);
      expect(stage2Projection.liveStatus.sweep).toBe(true);
      expect(stage2Projection.liveStatus.mode).toBe('tool');

      // Stage 3: Post tool.result window while aggregated turn is still settling (openToolCount === 0, runtime still running)
      await vi.waitFor(() => expect(persistedEvents.some(e => e.type === 'tool.result' && e.payload.toolCallId === 'sleep')).toBe(true));
      const stage3RuntimeStatus = runtime.getStatus();
      const stage3Sqlite = readPersistedSqliteRow();
      const stage3Projection = projectLiveStatus(stage3Sqlite?.state ?? null);
      expect(stage3Projection.activeToolCall).toBe(false);
      expect(stage3Sqlite?.state).toBe('running');
      expect(stage3Projection.resolvedSessionState).toBe('running');
      expect(stage3Projection.liveStatus.busy).toBe(true);
      expect(stage3Projection.liveStatus.sweep).toBe(true);

      // Stage 4: Final aggregated turn settlement -> automatic idle persistence in SQLite + authoritative idle timeline event
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
      await flushStore();
      const stage4Sqlite = readPersistedSqliteRow();
      expect(stage4Sqlite?.state).toBe('idle');
      expect(stage4Sqlite?.record).toMatchObject({ requestedModel: 'model-b', activeModel: 'model-a' });
      expect(persistedEvents.filter(e => e.type === 'usage.update' && typeof e.payload.model === 'string').at(-1)?.payload.model).toBe('model-a');
      expect(stage4Sqlite?.record.providerResumeId).toBe('native-1');
      expect(stage4Sqlite?.record.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.STARTED);
      const finalTexts = persistedEvents.filter(e => e.type === 'assistant.text' && e.payload.streaming === false && !e.payload.automation);
      expect(finalTexts).toHaveLength(1);
      expect(finalTexts[0]?.payload.text).toContain('RUN_A');
      expect(finalTexts[0]?.payload.text).toContain('HUMAN_B');
      expect(finalTexts[0]?.payload.text).toContain('MCP_C');
      expect(persistedEvents.some(e => e.type === 'usage.update')).toBe(true);
      expect(persistedEvents.some(e => e.type === 'session.state' && e.payload.state === 'idle' && e.payload.authoritative === true)).toBe(true);

      const stage4Projection = projectLiveStatus(stage4Sqlite?.state ?? null);
      expect(stage4Projection.activeToolCall).toBe(false);
      expect(stage4Projection.activeTransportTurn).toBe(false);
      expect(stage4Projection.resolvedSessionState).toBe('idle');
      expect(stage4Projection.liveStatus.busy).toBe(false);
      expect(stage4Projection.liveStatus.sweep).toBe(false);
      expect(stage4Projection.liveStatus.mode).toBe('idle');
      expect(stage4Projection.liveStatus.visualMode).toBe('idle');

      const evidencePath = process.env.IMCODES_SAVE_AGY_FULLCHAIN_EVIDENCE?.trim();
      if (evidencePath) {
        const rpcRows = await requests();
        await writeFile(evidencePath, JSON.stringify({
          testFile: 'test/e2e/agy-acp-flow.test.ts',
          testName: 'automatically drives persisted SQLite state, relay timeline events, and frontend live-status projection across A + steered B/C without manual store writes',
          peerClassification: 'controllable_acp_fixture (test/fixtures/agy-acp.mjs via real @agentclientprotocol/sdk ClientSideConnection)',
          manualStoreWritesInTest: 0,
          statePersistenceDriver: 'TransportSessionRuntime.onStatusChange -> session-manager.wireTransportCallbacks -> persistTransportState -> upsertSession -> flushStore -> sessions.sqlite (sessions table)',
          isolatedImcodesHome: imcodesStateDir(),
          sqliteDbPath: dbPath,
          sessionName: persistedName,
          projectName: persistedProject,
          stages: {
            stage1_initial_idle: {
              runtimeStatus: 'idle',
              sqlitePersistedState: stage1Sqlite?.state,
              agyNativeSessionState: stage1Sqlite?.record.agyNativeSessionState,
              frontendProjection: stage1Projection,
            },
            stage2_in_flight_a_with_tool_and_steered_b_c: {
              runtimeStatus: stage2RuntimeStatus,
              sqlitePersistedState: stage2Sqlite?.state,
              agyNativeSessionState: stage2Sqlite?.record.agyNativeSessionState,
              frontendProjection: stage2Projection,
            },
            stage3_post_tool_result_before_turn_settle: {
              runtimeStatus: stage3RuntimeStatus,
              sqlitePersistedState: stage3Sqlite?.state,
              frontendProjection: stage3Projection,
            },
            stage4_terminal_settled_idle: {
              runtimeStatus: runtime.getStatus(),
              sqlitePersistedState: stage4Sqlite?.state,
              providerResumeId: stage4Sqlite?.record.providerResumeId,
              agyNativeSessionState: stage4Sqlite?.record.agyNativeSessionState,
              frontendProjection: stage4Projection,
            },
          },
          rpcMethodCounts: rpcRows.reduce<Record<string, number>>((acc, r) => {
            acc[r.method] = (acc[r.method] ?? 0) + 1;
            return acc;
          }, {}),
          timelineEventSummary: persistedEvents.map(e => ({
            type: e.type,
            ts: e.ts,
            state: e.payload.state,
            authoritative: e.payload.authoritative,
            status: e.payload.status,
            label: e.payload.label,
            toolCallId: e.payload.toolCallId,
            terminalStatus: e.payload.terminalStatus,
            streaming: e.payload.streaming,
            textPreview: typeof e.payload.text === 'string' ? e.payload.text.slice(0, 80) : undefined,
          })),
        }, null, 2));
      }
      runtime.send('NEXT_MODEL_B', 'prodchain-next-model-b');
      await vi.waitFor(() => expect(persistedEvents.filter(e => e.type === 'assistant.text' && e.payload.streaming === false && !e.payload.automation)).toHaveLength(2));
      await flushStore();
      expect(readPersistedSqliteRow()?.record).toMatchObject({ requestedModel: 'model-b', activeModel: 'model-b', modelDisplay: 'model-b' });
      expect(persistedEvents.filter(e => e.type === 'usage.update' && typeof e.payload.model === 'string').at(-1)?.payload.model).toBe('model-b');

    } finally {
      offPersisted();
      await stopTransportRuntimeSession(persistedName);
      removeSession(persistedName);
      authorizeEmptySessionStoreWrite();
      await flushStore();
      await rm(persistedDir, { recursive: true, force: true });
    }
  });
});
