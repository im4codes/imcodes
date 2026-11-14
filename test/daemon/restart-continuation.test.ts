import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CHAT_MESSAGE_ORIGINS, USER_MESSAGE_ORIGIN_FIELDS } from '../../shared/chat-message-origin.js';
import {
  DAEMON_RESTART_CONTINUATION_COMMAND_PREFIX,
  DAEMON_RESTART_CONTINUATION_TTL_MS,
} from '../../shared/daemon-upgrade.js';
import { EXECUTION_CLONE_KIND } from '../../shared/execution-clone.js';
import {
  captureRestartContinuationsBeforeShutdown,
  captureRestartContinuationsBeforeShutdownDetailed,
  captureUncleanRestartContinuations,
  captureUncleanRestartContinuationsDetailed,
  claimProcessRestartContinuationRecovery,
  clearSessionRestartContinuation,
  consumeRestartContinuation,
  dispatchProcessRestartContinuation,
  dispatchTransportRestartContinuation,
  emitSystemContinueUserMessage,
  getPendingRestartContinuation,
  hasActiveProcessRestartContinuationRecovery,
  hasPendingRestartContinuation,
  markSessionUserStopped,
  restartContinuationPath,
  retireRestartContinuation,
} from '../../src/daemon/restart-continuation.js';
import { TransportQueueStore } from '../../src/daemon/transport-queue-store.js';
import type { SessionRecord } from '../../src/store/session-store.js';

function makeSession(overrides: Partial<SessionRecord> & { name: string }): SessionRecord {
  return {
    name: overrides.name,
    projectName: 'proj',
    role: 'brain',
    agentType: overrides.agentType ?? 'claude-code-sdk',
    runtimeType: overrides.runtimeType ?? 'transport',
    providerId: overrides.providerId,
    projectDir: '/tmp/proj',
    state: overrides.state ?? 'running',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

let tempHome = '';
const origHome = process.env.IMCODES_HOME;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'imcodes-restart-cont-'));
  process.env.IMCODES_HOME = tempHome;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.IMCODES_HOME;
  else process.env.IMCODES_HOME = origHome;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = '';
});

describe('restart-continuation store & filtering', () => {
  it('captures active transport (main + sub-session) and process sessions before shutdown while applying strict exclusions', () => {
    const now = 100_000;
    const sessions: SessionRecord[] = [
      makeSession({ name: 'deck_proj_brain', agentType: 'codex-sdk', providerId: 'codex-sdk', runtimeType: 'transport', state: 'running' }),
      makeSession({ name: 'deck_sub_worker1', role: 'w1', agentType: 'claude-code-sdk', providerId: 'claude-code-sdk', runtimeType: 'transport', state: 'idle' }),
      makeSession({ name: 'deck_proj_w1', role: 'w1', agentType: 'claude-code', runtimeType: 'process', state: 'running' }),
      // Excluded sessions:
      makeSession({ name: 'deck_idle_runtime', agentType: 'codex-sdk', providerId: 'codex-sdk', runtimeType: 'transport', state: 'running' }),
      makeSession({ name: 'deck_stale_phantom', agentType: 'claude-code-sdk', providerId: 'claude-code-sdk', runtimeType: 'transport', state: 'running' }),
      makeSession({ name: 'deck_stopped', state: 'stopped' }),
      makeSession({ name: 'deck_error', state: 'error' }),
      makeSession({ name: 'deck_incognito', incognito: true, state: 'running' }),
      makeSession({ name: 'deck_shell', agentType: 'shell', runtimeType: 'process', state: 'running' }),
      makeSession({ name: 'deck_script', agentType: 'script', runtimeType: 'process', state: 'running' }),
      makeSession({
        name: 'deck_clone',
        agentType: 'claude-code-sdk',
        runtimeType: 'transport',
        state: 'running',
        executionCloneMetadata: {
          kind: EXECUTION_CLONE_KIND,
          parentRunId: 'run-1',
          parentStage: 'generic_execution',
          createdBySessionName: 'deck_proj_brain',
        } as SessionRecord['executionCloneMetadata'],
      }),
      makeSession({ name: 'deck_user_stopped', state: 'running' }),
    ];

    markSessionUserStopped('deck_user_stopped', now - 1_000);

    const runtimes = new Map<string, { sending?: boolean; backgroundWorkCount?: number; lastActivityAt?: number; getStatus: () => string }>([
      ['deck_proj_brain', { sending: true, lastActivityAt: now - 5_000, getStatus: () => 'streaming' }],
      ['deck_sub_worker1', { sending: false, backgroundWorkCount: 1, getStatus: () => 'idle' }],
      ['deck_idle_runtime', { sending: false, backgroundWorkCount: 0, getStatus: () => 'idle' }],
      ['deck_stale_phantom', { sending: true, lastActivityAt: now - 20 * 60_000, getStatus: () => 'streaming' }],
    ]);

    const captured = captureRestartContinuationsBeforeShutdown({
      sessions,
      getRuntime: (name) => runtimes.get(name),
      now,
      epoch: 'epoch-1',
      staleTurnMs: 15 * 60_000,
    });

    expect(captured.map((c) => c.sessionName)).toEqual([
      'deck_proj_brain',
      'deck_sub_worker1',
      'deck_proj_w1',
    ]);
    expect(hasPendingRestartContinuation('deck_proj_brain', now + 100)).toBe(true);
    expect(hasPendingRestartContinuation('deck_sub_worker1', now + 100)).toBe(true);
    expect(hasPendingRestartContinuation('deck_proj_w1', now + 100)).toBe(true);
    expect(hasPendingRestartContinuation('deck_idle_runtime', now + 100)).toBe(false);
    expect(hasPendingRestartContinuation('deck_stale_phantom', now + 100)).toBe(false);
    expect(hasPendingRestartContinuation('deck_stopped', now + 100)).toBe(false);
    expect(hasPendingRestartContinuation('deck_error', now + 100)).toBe(false);
    expect(hasPendingRestartContinuation('deck_incognito', now + 100)).toBe(false);
    expect(hasPendingRestartContinuation('deck_shell', now + 100)).toBe(false);
    expect(hasPendingRestartContinuation('deck_script', now + 100)).toBe(false);
    expect(hasPendingRestartContinuation('deck_clone', now + 100)).toBe(false);
    expect(hasPendingRestartContinuation('deck_user_stopped', now + 100)).toBe(false);

    // A new user message clears userStopped so a later turn CAN be captured on the next shutdown.
    retireRestartContinuation('deck_user_stopped', now + 200);
    const recaptured = captureRestartContinuationsBeforeShutdown({
      sessions: [makeSession({ name: 'deck_user_stopped', agentType: 'claude-code', runtimeType: 'process', state: 'running' })],
      getRuntime: () => undefined,
      now: now + 300,
      epoch: 'epoch-2',
    });
    expect(recaptured.map((c) => c.sessionName)).toEqual(['deck_user_stopped']);
  });

  it('captures unclean crash sessions from persisted running/queued state and handoff_inflight rows, but skips clean restarts', () => {
    const now = 200_000;
    const sessions: SessionRecord[] = [
      makeSession({ name: 'deck_crash_running', agentType: 'codex-sdk', providerId: 'codex-sdk', runtimeType: 'transport', state: 'running' }),
      makeSession({ name: 'deck_crash_inflight', agentType: 'claude-code-sdk', providerId: 'claude-code-sdk', runtimeType: 'transport', state: 'idle' }),
      makeSession({ name: 'deck_crash_proc', agentType: 'codex', runtimeType: 'process', state: 'queued' }),
      makeSession({ name: 'deck_crash_stopped_by_user', agentType: 'codex', runtimeType: 'process', state: 'running' }),
    ];
    markSessionUserStopped('deck_crash_stopped_by_user', now - 500);

    // Clean restart must NOT capture from stale store state.
    expect(
      captureUncleanRestartContinuations({
        uncleanPreviousExit: false,
        sessions,
        activeDispatchSessions: new Set(['deck_crash_inflight']),
        now,
        epoch: 'clean-epoch',
      }),
    ).toEqual([]);

    const captured = captureUncleanRestartContinuations({
      uncleanPreviousExit: true,
      sessions,
      activeDispatchSessions: new Set(['deck_crash_inflight']),
      now,
      epoch: 'crash-epoch',
    });
    expect(captured.map((c) => c.sessionName)).toEqual([
      'deck_crash_running',
      'deck_crash_inflight',
      'deck_crash_proc',
    ]);
    expect(getPendingRestartContinuation('deck_crash_inflight', now + 10)?.reason).toBe('unclean_exit');
    expect(hasPendingRestartContinuation('deck_crash_stopped_by_user', now + 10)).toBe(false);
  });

  it('distinguishes SQLite queued user messages from orphaned handoff_inflight dispatch rows', () => {
    const dbPath = join(tempHome, 'transport-queue.sqlite');
    const store = new TransportQueueStore(dbPath);
    try {
      store.enqueue({
        sessionName: 'deck_inflight_only',
        clientMessageId: 'msg-inflight',
        text: 'initial prompt',
        now: 1_000,
      });
      store.markHandoffInFlight('deck_inflight_only', ['msg-inflight'], 60_000, 1_100);

      store.enqueue({
        sessionName: 'deck_has_queued',
        clientMessageId: 'msg-queued',
        text: 'follow-up user prompt',
        now: 1_200,
      });

      expect(store.listActiveDispatchSessionNames()).toEqual(['deck_inflight_only']);
      expect(store.hasQueuedEntries('deck_inflight_only')).toBe(false);
      expect(store.hasQueuedEntries('deck_has_queued')).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe('restart-continuation dispatch & safety guards', () => {
  it('dispatches one-shot system-origin continue for transport and prevents duplicate delivery across repeated calls', async () => {
    const now = 300_000;
    const session = makeSession({
      name: 'deck_t_brain',
      agentType: 'claude-code-sdk',
      providerId: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
    });

    captureRestartContinuationsBeforeShutdown({
      sessions: [session],
      getRuntime: () => ({ sending: true, getStatus: () => 'streaming' }),
      now,
      epoch: 'ep-once',
    });

    const emitted: Array<{ sessionName: string; type: string; payload: Record<string, unknown>; opts: Record<string, unknown> }> = [];
    const send = vi.fn(() => 'sent');
    const runtime = {
      sending: false,
      pendingCount: 0,
      getStatus: () => 'idle',
      send,
    };

    const res1 = await dispatchTransportRestartContinuation({
      preRestoreSession: session,
      currentSession: { ...session, state: 'idle' },
      runtime,
      getResendCount: () => 0,
      hasQueuedDurableEntries: () => false,
      emitUserMessage: (sName, commandId) =>
        emitSystemContinueUserMessage((n, t, p, o) => emitted.push({ sessionName: n, type: t, payload: p, opts: o }), sName, commandId, 'transport'),
      now: now + 1_000,
    });

    expect(res1.dispatched).toBe(true);
    expect(res1.commandId).toBe(`${DAEMON_RESTART_CONTINUATION_COMMAND_PREFIX}deck_t_brain:ep-once`);
    expect(hasPendingRestartContinuation('deck_t_brain', now + 1_000)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('continue', res1.commandId, undefined, undefined, {
      queuePlacement: 'front',
      timelineCommitted: true,
      messageOrigin: CHAT_MESSAGE_ORIGINS.SYSTEM,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload[USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]).toBe(CHAT_MESSAGE_ORIGINS.SYSTEM);
    expect(emitted[0].payload.text).toBe('continue');

    // Second dispatch on duplicate restore / retry must NOT fire again.
    const res2 = await dispatchTransportRestartContinuation({
      preRestoreSession: session,
      currentSession: { ...session, state: 'idle' },
      runtime,
      getResendCount: () => 0,
      hasQueuedDurableEntries: () => false,
      emitUserMessage: vi.fn(),
      now: now + 2_000,
    });
    expect(res2.dispatched).toBe(false);
    expect(res2.reason).toBe('none');
    expect(send).toHaveBeenCalledTimes(1);

    // Even if the exact same epoch is somehow re-consumed, consumedEpochs rejects replay.
    expect(consumeRestartContinuation('deck_t_brain', 'ep-once', now + 2_000)).toBeNull();
  });

  it('skips and consumes continuation when pending/resend/durable queue is non-empty, Codex rollout completed, or marker expired', async () => {
    const now = 400_000;
    const baseSession = makeSession({
      name: 'deck_codex_brain',
      agentType: 'codex-sdk',
      providerId: 'codex-sdk',
      runtimeType: 'transport',
      state: 'running',
    });

    // 1) Pending/resend non-empty
    captureRestartContinuationsBeforeShutdown({
      sessions: [baseSession],
      getRuntime: () => ({ sending: true, getStatus: () => 'streaming' }),
      now,
      epoch: 'ep-q',
    });
    const send = vi.fn();
    const resQueued = await dispatchTransportRestartContinuation({
      preRestoreSession: baseSession,
      runtime: { sending: false, pendingCount: 1, getStatus: () => 'idle', send },
      getResendCount: () => 0,
      hasQueuedDurableEntries: () => false,
      emitUserMessage: vi.fn(),
      now: now + 100,
    });
    expect(resQueued).toEqual({ dispatched: false, reason: 'pending_queue_nonempty' });
    expect(send).not.toHaveBeenCalled();
    expect(hasPendingRestartContinuation('deck_codex_brain', now + 100)).toBe(false);

    // 2) Codex rollout already completed
    captureRestartContinuationsBeforeShutdown({
      sessions: [baseSession],
      getRuntime: () => ({ sending: true, getStatus: () => 'streaming' }),
      now,
      epoch: 'ep-rollout',
    });
    const resCodexDone = await dispatchTransportRestartContinuation({
      preRestoreSession: baseSession,
      runtime: {
        sending: false,
        pendingCount: 0,
        getStatus: () => 'idle',
        send,
        hasCompletedCodexRolloutTurn: async () => true,
      },
      getResendCount: () => 0,
      hasQueuedDurableEntries: () => false,
      emitUserMessage: vi.fn(),
      now: now + 100,
    });
    expect(resCodexDone).toEqual({ dispatched: false, reason: 'codex_rollout_completed' });
    expect(send).not.toHaveBeenCalled();
    expect(hasPendingRestartContinuation('deck_codex_brain', now + 100)).toBe(false);

    // 3) TTL expiration
    captureRestartContinuationsBeforeShutdown({
      sessions: [baseSession],
      getRuntime: () => ({ sending: true, getStatus: () => 'streaming' }),
      now,
      epoch: 'ep-ttl',
    });
    const resExpired = await dispatchTransportRestartContinuation({
      preRestoreSession: baseSession,
      runtime: { sending: false, pendingCount: 0, getStatus: () => 'idle', send },
      getResendCount: () => 0,
      hasQueuedDurableEntries: () => false,
      emitUserMessage: vi.fn(),
      now: now + DAEMON_RESTART_CONTINUATION_TTL_MS + 1,
    });
    expect(resExpired).toEqual({ dispatched: false, reason: 'none' });
    expect(send).not.toHaveBeenCalled();
  });

  it('dispatches one-shot continue for restarted process session and enforces state/userStopped exclusions', async () => {
    const now = 500_000;
    const procSession = makeSession({
      name: 'deck_proc_brain',
      agentType: 'claude-code',
      runtimeType: 'process',
      state: 'running',
    });
    captureRestartContinuationsBeforeShutdown({
      sessions: [procSession],
      getRuntime: () => undefined,
      now,
      epoch: 'ep-proc',
    });

    const sendKeys = vi.fn(async () => {});
    const emit = vi.fn();
    const res = await dispatchProcessRestartContinuation({
      sessionName: 'deck_proc_brain',
      currentSession: { ...procSession, state: 'idle' },
      sendKeys,
      emitUserMessage: (sName, commandId) => emitSystemContinueUserMessage(emit, sName, commandId, 'process'),
      now: now + 500,
    });
    expect(res.dispatched).toBe(true);
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith('deck_proc_brain', 'continue');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(hasPendingRestartContinuation('deck_proc_brain', now + 500)).toBe(false);

    // Second call must be a no-op
    const res2 = await dispatchProcessRestartContinuation({
      sessionName: 'deck_proc_brain',
      currentSession: { ...procSession, state: 'idle' },
      sendKeys,
      emitUserMessage: emit,
      now: now + 600,
    });
    expect(res2).toEqual({ dispatched: false, reason: 'none' });
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(restartContinuationPath()).toContain(tempHome);
  });

  it('propagates store persistence failure on consume/mutations and dispatches continue strictly once after recovery', async () => {
    const now = 600_000;
    const tSession = makeSession({
      name: 'deck_eacces_t',
      agentType: 'claude-code-sdk',
      providerId: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
    });
    const pSession = makeSession({
      name: 'deck_eacces_p',
      agentType: 'claude-code',
      runtimeType: 'process',
      state: 'running',
    });

    const cap = captureRestartContinuationsBeforeShutdownDetailed({
      sessions: [tSession, pSession],
      getRuntime: () => ({ sending: true, getStatus: () => 'streaming' }),
      now,
      epoch: 'ep-eacces',
    });
    expect(cap.persisted).toBe(true);
    expect(cap.captured).toHaveLength(2);

    const storeDir = dirname(restartContinuationPath());
    const tSend = vi.fn();
    const tEmit = vi.fn();
    const pSendKeys = vi.fn(async () => {});
    const pEmit = vi.fn();

    chmodSync(storeDir, 0o500);
    try {
      // Failed consume must refuse dispatch, preserve pending on disk, and allow clean retry later.
      expect(consumeRestartContinuation('deck_eacces_t', 'ep-eacces', now + 100)).toBeNull();
      expect(hasPendingRestartContinuation('deck_eacces_t', now + 100)).toBe(true);

      const tFail = await dispatchTransportRestartContinuation({
        preRestoreSession: tSession,
        currentSession: { ...tSession, state: 'idle' },
        runtime: { sending: false, pendingCount: 0, getStatus: () => 'idle', send: tSend },
        getResendCount: () => 0,
        hasQueuedDurableEntries: () => false,
        emitUserMessage: (sName, commandId) => emitSystemContinueUserMessage(tEmit, sName, commandId, 'transport'),
        now: now + 100,
      });
      expect(tFail).toEqual({ dispatched: false, reason: 'consume_persist_failed' });
      expect(tSend).not.toHaveBeenCalled();
      expect(tEmit).not.toHaveBeenCalled();
      expect(hasPendingRestartContinuation('deck_eacces_t', now + 100)).toBe(true);

      const pFail = await dispatchProcessRestartContinuation({
        sessionName: 'deck_eacces_p',
        currentSession: { ...pSession, state: 'idle' },
        sendKeys: pSendKeys,
        emitUserMessage: (sName, commandId) => emitSystemContinueUserMessage(pEmit, sName, commandId, 'process'),
        now: now + 100,
      });
      expect(pFail).toEqual({ dispatched: false, reason: 'consume_persist_failed' });
      expect(pSendKeys).not.toHaveBeenCalled();
      expect(pEmit).not.toHaveBeenCalled();
      expect(hasPendingRestartContinuation('deck_eacces_p', now + 100)).toBe(true);

      // Every other store mutation also propagates persistence failure cleanly.
      expect(markSessionUserStopped('deck_eacces_u', now + 100)).toBe(false);
      expect(retireRestartContinuation('deck_eacces_t', now + 100)).toBe(false);
      expect(clearSessionRestartContinuation('deck_eacces_t', now + 100)).toBe(false);
    } finally {
      chmodSync(storeDir, 0o700);
    }

    // Once writable again, each session dispatches 'continue' strictly once.
    const tOk1 = await dispatchTransportRestartContinuation({
      preRestoreSession: tSession,
      currentSession: { ...tSession, state: 'idle' },
      runtime: { sending: false, pendingCount: 0, getStatus: () => 'idle', send: tSend },
      getResendCount: () => 0,
      hasQueuedDurableEntries: () => false,
      emitUserMessage: (sName, commandId) => emitSystemContinueUserMessage(tEmit, sName, commandId, 'transport'),
      now: now + 200,
    });
    const tOk2 = await dispatchTransportRestartContinuation({
      preRestoreSession: tSession,
      currentSession: { ...tSession, state: 'idle' },
      runtime: { sending: false, pendingCount: 0, getStatus: () => 'idle', send: tSend },
      getResendCount: () => 0,
      hasQueuedDurableEntries: () => false,
      emitUserMessage: tEmit,
      now: now + 300,
    });
    expect(tOk1.dispatched).toBe(true);
    expect(tOk2).toEqual({ dispatched: false, reason: 'none' });
    expect(tSend).toHaveBeenCalledTimes(1);
    expect(tEmit).toHaveBeenCalledTimes(1);

    const pOk1 = await dispatchProcessRestartContinuation({
      sessionName: 'deck_eacces_p',
      currentSession: { ...pSession, state: 'idle' },
      sendKeys: pSendKeys,
      emitUserMessage: (sName, commandId) => emitSystemContinueUserMessage(pEmit, sName, commandId, 'process'),
      now: now + 200,
    });
    const pOk2 = await dispatchProcessRestartContinuation({
      sessionName: 'deck_eacces_p',
      currentSession: { ...pSession, state: 'idle' },
      sendKeys: pSendKeys,
      emitUserMessage: pEmit,
      now: now + 300,
    });
    expect(pOk1.dispatched).toBe(true);
    expect(pOk2).toEqual({ dispatched: false, reason: 'none' });
    expect(pSendKeys).toHaveBeenCalledTimes(1);
    expect(pEmit).toHaveBeenCalledTimes(1);

    expect(markSessionUserStopped('deck_eacces_u', now + 400)).toBe(true);
    captureRestartContinuationsBeforeShutdown({
      sessions: [tSession],
      getRuntime: () => ({ sending: true, getStatus: () => 'streaming' }),
      now: now + 400,
      epoch: 'ep-clear-retire',
    });
    expect(clearSessionRestartContinuation('deck_eacces_t', now + 410)).toBe(true);
    expect(hasPendingRestartContinuation('deck_eacces_t', now + 410)).toBe(false);
    captureRestartContinuationsBeforeShutdown({
      sessions: [tSession],
      getRuntime: () => ({ sending: true, getStatus: () => 'streaming' }),
      now: now + 420,
      epoch: 'ep-retire',
    });
    expect(retireRestartContinuation('deck_eacces_t', now + 430)).toBe(true);
    expect(retireRestartContinuation('deck_eacces_t', now + 430)).toBe(true);
  });

  it('reports capture persistence failure instead of claiming capture or clearing stale store succeeded', () => {
    const now = 700_000;
    const session = makeSession({
      name: 'deck_cap_fail',
      agentType: 'claude-code-sdk',
      providerId: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
    });

    // Seed an existing store file first.
    const initial = captureRestartContinuationsBeforeShutdownDetailed({
      sessions: [session],
      getRuntime: () => ({ sending: true, getStatus: () => 'streaming' }),
      now,
      epoch: 'ep-seed',
    });
    expect(initial.persisted).toBe(true);

    const storeDir = dirname(restartContinuationPath());
    chmodSync(storeDir, 0o500);
    try {
      // Shutdown capture with empty sessions (dirty due to clearing stale entry) fails closed.
      const clearFail = captureRestartContinuationsBeforeShutdownDetailed({
        sessions: [],
        getRuntime: () => undefined,
        now: now + 100,
        epoch: 'ep-clear-fail',
      });
      expect(clearFail).toEqual({ captured: [], persisted: false });
      expect(hasPendingRestartContinuation('deck_cap_fail', now + 100)).toBe(true);

      // Unclean capture with a fresh active session fails closed.
      const uncleanFail = captureUncleanRestartContinuationsDetailed({
        uncleanPreviousExit: true,
        sessions: [makeSession({ name: 'deck_cap_fail_2', agentType: 'opencode', runtimeType: 'process', state: 'running' })],
        now: now + 100,
        epoch: 'ep-unclean-fail',
      });
      expect(uncleanFail).toEqual({ captured: [], persisted: false });
      expect(hasPendingRestartContinuation('deck_cap_fail_2', now + 100)).toBe(false);
    } finally {
      chmodSync(storeDir, 0o700);
    }

    const uncleanOk = captureUncleanRestartContinuationsDetailed({
      uncleanPreviousExit: true,
      sessions: [makeSession({ name: 'deck_cap_fail_2', agentType: 'opencode', runtimeType: 'process', state: 'running' })],
      now: now + 200,
      epoch: 'ep-unclean-ok',
    });
    expect(uncleanOk.persisted).toBe(true);
    expect(uncleanOk.captured).toHaveLength(1);
    expect(hasPendingRestartContinuation('deck_cap_fail_2', now + 200)).toBe(true);
  });

  it('tracks process recovery ownership by session + runtimeEpoch and clears it on release or cancel', () => {
    const release = claimProcessRestartContinuationRecovery('deck_sub_latch', 'epoch-new');
    expect(hasActiveProcessRestartContinuationRecovery('deck_sub_latch')).toBe(true);
    expect(hasActiveProcessRestartContinuationRecovery('deck_sub_latch', 'epoch-new')).toBe(true);
    expect(hasActiveProcessRestartContinuationRecovery('deck_sub_latch', 'epoch-old')).toBe(false);

    // Releasing an older claim token cannot clobber a newer claim on the same session.
    const release2 = claimProcessRestartContinuationRecovery('deck_sub_latch', 'epoch-newer');
    release();
    expect(hasActiveProcessRestartContinuationRecovery('deck_sub_latch', 'epoch-newer')).toBe(true);
    release2();
    expect(hasActiveProcessRestartContinuationRecovery('deck_sub_latch', 'epoch-newer')).toBe(false);

    // markSessionUserStopped / retireRestartContinuation immediately clear any active recovery claim.
    const releaseStop = claimProcessRestartContinuationRecovery('deck_sub_latch_stop', 'epoch-stop');
    expect(hasActiveProcessRestartContinuationRecovery('deck_sub_latch_stop', 'epoch-stop')).toBe(true);
    expect(markSessionUserStopped('deck_sub_latch_stop', 800_000)).toBe(true);
    expect(hasActiveProcessRestartContinuationRecovery('deck_sub_latch_stop', 'epoch-stop')).toBe(false);
    releaseStop();

    const releaseRetire = claimProcessRestartContinuationRecovery('deck_sub_latch_retire', 'epoch-ret');
    expect(hasActiveProcessRestartContinuationRecovery('deck_sub_latch_retire', 'epoch-ret')).toBe(true);
    expect(retireRestartContinuation('deck_sub_latch_retire', 800_100)).toBe(true);
    expect(hasActiveProcessRestartContinuationRecovery('deck_sub_latch_retire', 'epoch-ret')).toBe(false);
    releaseRetire();
  });
});
