import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_MESSAGE_ORIGINS, USER_MESSAGE_ORIGIN_FIELDS } from '../../shared/chat-message-origin.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const mocks = vi.hoisted(() => {
  const store = new Map<string, SessionRecord>();
  const tmuxLive = new Set<string>();
  const tmuxPaneAlive = new Set<string>();
  const respawnCalls: string[] = [];
  const sendKeysCalls: Array<{ session: string; keys: string }> = [];
  const timelineEvents: Array<{ session: string; type: string; payload: Record<string, unknown> }> = [];
  const providerSends: Array<{ sessionId: string; message: string }> = [];
  const resendQueues = new Map<string, Array<Record<string, unknown>>>();
  let codexRolloutCompleted = false;

  return {
    store,
    tmuxLive,
    tmuxPaneAlive,
    respawnCalls,
    sendKeysCalls,
    timelineEvents,
    providerSends,
    resendQueues,
    get codexRolloutCompleted() {
      return codexRolloutCompleted;
    },
    set codexRolloutCompleted(v: boolean) {
      codexRolloutCompleted = v;
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: string) => {
      if (p === '/tmp/proj' || p === '/mock/proj') return true;
      return actual.existsSync(p);
    },
  };
});

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: () => Array.from(mocks.store.values()),
  getSession: (name: string) => mocks.store.get(name),
  upsertSession: (rec: SessionRecord) => {
    mocks.store.set(rec.name, rec);
  },
  updateSessionState: (name: string, state: SessionRecord['state'], error?: string) => {
    const existing = mocks.store.get(name);
    if (existing) mocks.store.set(name, { ...existing, state, ...(error ? { error } : {}) });
  },
  removeSession: (name: string) => {
    mocks.store.delete(name);
  },
  createSessionInstanceId: () => 'inst-1',
  createRuntimeEpoch: () => 'epoch-1',
}));

vi.mock('../../src/agent/tmux.js', () => ({
  BACKEND: 'tmux',
  listSessions: async () => Array.from(mocks.tmuxLive),
  newSession: async (name: string) => {
    mocks.tmuxLive.add(name);
    mocks.tmuxPaneAlive.add(name);
  },
  killSession: async (name: string) => {
    mocks.tmuxLive.delete(name);
    mocks.tmuxPaneAlive.delete(name);
  },
  sessionExists: async (name: string) => mocks.tmuxLive.has(name),
  isPaneAlive: async (name: string) => mocks.tmuxPaneAlive.has(name),
  respawnPane: async (name: string) => {
    mocks.respawnCalls.push(name);
    mocks.tmuxPaneAlive.add(name);
  },
  capturePane: async () => ['❯ '],
  sendKey: vi.fn(async () => {}),
  sendKeys: vi.fn(async (session: string, keys: string) => {
    mocks.sendKeysCalls.push({ session, keys });
  }),
  sendKeysDelayedEnter: vi.fn(async () => {}),
  sendRawInput: vi.fn(async () => {}),
  resizeSession: vi.fn(async () => {}),
  getPaneCwd: vi.fn(async () => '/tmp/proj'),
  getPaneId: vi.fn(async () => '%1'),
  getPanePids: vi.fn(async () => []),
  getPaneStartCommand: vi.fn(async () => 'claude --dangerously-skip-permissions'),
  showBuffer: vi.fn(async () => ''),
  cleanupOrphanFifos: vi.fn(async () => {}),
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  reserveSessionFile: vi.fn(),
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingFile: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn(() => false),
  findJsonlPathBySessionId: () => '/mock/session.jsonl',
  ensureClaudeSessionFile: vi.fn().mockResolvedValue(undefined),
  preClaimFile: vi.fn(),
}));

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingSpecificFile: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn(() => false),
  findRolloutPathByUuid: vi.fn().mockResolvedValue(null),
  isFileClaimedByOther: vi.fn(() => false),
  startWatchingById: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/daemon/gemini-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingDiscovered: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn(() => false),
}));

vi.mock('../../src/daemon/opencode-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn(() => false),
}));

vi.mock('../../src/daemon/opencode-history.js', () => ({
  discoverLatestOpenCodeSessionId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: vi.fn((session: string, type: string, payload: Record<string, unknown>) => {
      mocks.timelineEvents.push({ session, type, payload });
      return { eventId: `evt-${mocks.timelineEvents.length}` };
    }),
    on: vi.fn(() => () => {}),
    epoch: 0,
    replay: vi.fn(() => ({ events: [], truncated: false })),
    forgetSession: vi.fn(),
  },
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: {
    read: vi.fn(async () => []),
    readPreferred: vi.fn(async () => []),
    readByTypesPreferred: vi.fn(async () => []),
    readCompletedTextTail: vi.fn(async () => []),
    append: vi.fn(),
  },
}));

vi.mock('../../src/daemon/session-resource-service.js', () => ({
  initializeSessionResourceLifecycle: vi.fn().mockResolvedValue({ released: 0, preserved: 0, failed: 0 }),
  registerTmuxSessionResource: vi.fn().mockResolvedValue(undefined),
  releaseSessionChildResources: vi.fn().mockResolvedValue({ released: 0, failed: 0 }),
  releaseSessionResources: vi.fn().mockResolvedValue({ released: 0, failed: 0 }),
  resourceOwnerEnv: vi.fn(() => ({})),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/daemon/session-identity-resolver.js', () => ({
  resolveEffectiveIdentityPrompt: vi.fn(async () => undefined),
}));

vi.mock('../../src/agent/agent-version.js', () => ({
  getAgentVersion: vi.fn(async () => undefined),
}));

vi.mock('../../src/daemon/memory-inject.js', () => ({
  injectGeminiMemoryWithTimeline: vi.fn(async () => undefined),
}));

vi.mock('../../src/agent/signal.js', () => ({
  setupCCStopHook: vi.fn(async () => {}),
}));

vi.mock('../../src/agent/notify-setup.js', () => ({
  setupCodexNotify: vi.fn(async () => {}),
  setupOpenCodePlugin: vi.fn(async () => {}),
}));

vi.mock('../../src/agent/runtime-context-bootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/runtime-context-bootstrap.js')>();
  return {
    ...actual,
    resolveTransportContextBootstrap: vi.fn(async () => ({
      namespace: { scope: 'personal', projectId: 'proj', enterpriseId: 'ent', workspaceId: 'ws', userId: 'u1' },
      diagnostics: [],
      localProcessedFreshness: 'fresh' as const,
      remoteProcessedFreshness: 'fresh' as const,
    })),
  };
});

vi.mock('../../src/agent/provider-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/provider-registry.js')>();
  const makeProvider = (id: string) => ({
    id,
    connectionMode: 'local-sdk',
    capabilities: { streaming: true, toolCalling: false, approval: false, sessionManagement: true },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    createSession: vi.fn(async ({ sessionKey }: { sessionKey?: string }) => sessionKey ?? `${id}-sid-1`),
    endSession: vi.fn(async () => {}),
    send: vi.fn(async (sessionId: string, payload: string | { userMessage?: string }) => {
      const message = typeof payload === 'string' ? payload : String(payload?.userMessage ?? '');
      mocks.providerSends.push({ sessionId, message });
    }),
    cancel: vi.fn(async () => {}),
    onDelta: vi.fn(() => () => {}),
    onComplete: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    getSessionInfo: vi.fn(async (sid: string) => ({ resumeId: `${sid}-resume` })),
    listSessions: vi.fn(async () => []),
    hasCompletedRolloutTurn: vi.fn(async () => mocks.codexRolloutCompleted),
  });
  const providers = new Map<string, ReturnType<typeof makeProvider>>([
    ['claude-code-sdk', makeProvider('claude-code-sdk')],
    ['codex-sdk', makeProvider('codex-sdk')],
  ]);
  return {
    ...actual,
    getProvider: (id: string) => providers.get(id),
    ensureProviderConnected: vi.fn(async (id: string) => providers.get(id)),
    listProviders: () => Array.from(providers.values()),
  };
});

const {
  captureRestartContinuationsBeforeShutdown,
  captureUncleanRestartContinuations,
  hasPendingRestartContinuation,
  markSessionUserStopped,
  restartContinuationPath,
} = await import('../../src/daemon/restart-continuation.js');
const {
  captureShutdownRestartContinuationsAndMarkExit,
} = await import('../../src/daemon/lifecycle.js');
const {
  __resetUpgradeReadinessForTests,
  beginUpgradeReadinessTracking,
  readPreviousExitWasUnclean,
} = await import('../../src/daemon/upgrade-readiness.js');
const {
  markDaemonProcess,
  resetProcessRoleForTests,
} = await import('../../src/daemon/process-role.js');
const {
  resetTransportQueueStoreForTests,
} = await import('../../src/daemon/transport-queue-store.js');
const {
  clearAllResend,
  enqueueResend,
  recipientFromSessionRecord,
} = await import('../../src/daemon/transport-resend-queue.js');
const {
  restoreFromStore,
  restoreTransportSessions,
  stopTransportRuntimeSession,
} = await import('../../src/agent/session-manager.js');
const {
  rebuildSubSessions,
} = await import('../../src/daemon/subsession-manager.js');

let tempHome = '';
const origHome = process.env.IMCODES_HOME;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'imcodes-restore-cont-'));
  process.env.IMCODES_HOME = tempHome;
  __resetUpgradeReadinessForTests();
  resetTransportQueueStoreForTests();
  clearAllResend();
  markDaemonProcess();
  mocks.store.clear();
  mocks.tmuxLive.clear();
  mocks.tmuxPaneAlive.clear();
  mocks.respawnCalls.length = 0;
  mocks.sendKeysCalls.length = 0;
  mocks.timelineEvents.length = 0;
  mocks.providerSends.length = 0;
  mocks.resendQueues.clear();
  mocks.codexRolloutCompleted = false;
});

afterEach(async () => {
  for (const key of Array.from(mocks.store.keys())) {
    await stopTransportRuntimeSession(key).catch(() => {});
  }
  resetTransportQueueStoreForTests();
  resetProcessRoleForTests();
  if (origHome === undefined) delete process.env.IMCODES_HOME;
  else process.env.IMCODES_HOME = origHome;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = '';
});

function makeRecord(overrides: Partial<SessionRecord> & { name: string }): SessionRecord {
  return {
    name: overrides.name,
    projectName: 'proj',
    role: 'brain',
    agentType: overrides.agentType ?? 'claude-code',
    runtimeType: overrides.runtimeType ?? 'process',
    providerId: overrides.providerId,
    providerSessionId: overrides.providerSessionId,
    providerResumeId: overrides.providerResumeId,
    projectDir: '/tmp/proj',
    state: overrides.state ?? 'running',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('restoreFromStore & restoreTransportSessions restart continuation wiring', () => {
  it('process restore: sends continue once after restart/respawn, skips live tmux panes, and respects user_stopped', async () => {
    const restarted = makeRecord({ name: 'deck_dead_brain', agentType: 'opencode', runtimeType: 'process', state: 'running', opencodeSessionId: 'oc-1' });
    const respawned = makeRecord({ name: 'deck_pane_dead_w1', role: 'w1', agentType: 'opencode', runtimeType: 'process', state: 'running', opencodeSessionId: 'oc-2' });
    const livePane = makeRecord({ name: 'deck_live_w2', role: 'w2', agentType: 'opencode', runtimeType: 'process', state: 'running', opencodeSessionId: 'oc-3' });
    const userStopped = makeRecord({ name: 'deck_stopped_w3', role: 'w3', agentType: 'opencode', runtimeType: 'process', state: 'running', opencodeSessionId: 'oc-4' });

    for (const r of [restarted, respawned, livePane, userStopped]) mocks.store.set(r.name, r);

    // Live tmux state: deck_live_w2 stayed alive; deck_pane_dead_w1 has remain-on-exit dead pane; others missing.
    mocks.tmuxLive.add('deck_pane_dead_w1');
    mocks.tmuxLive.add('deck_live_w2');
    mocks.tmuxPaneAlive.add('deck_live_w2');

    markSessionUserStopped('deck_stopped_w3', Date.now() - 100);
    captureRestartContinuationsBeforeShutdown({
      sessions: [restarted, respawned, livePane, userStopped],
      getRuntime: () => undefined,
      epoch: 'ep-proc-wiring',
    });

    expect(hasPendingRestartContinuation('deck_dead_brain')).toBe(true);
    expect(hasPendingRestartContinuation('deck_pane_dead_w1')).toBe(true);
    expect(hasPendingRestartContinuation('deck_live_w2')).toBe(true);
    expect(hasPendingRestartContinuation('deck_stopped_w3')).toBe(false);

    await restoreFromStore();
    // Allow unawaited injectInit microtasks (opencode driver has no postLaunch wait) to finish.
    await new Promise((r) => setTimeout(r, 30));

    expect(mocks.sendKeysCalls).toEqual(
      expect.arrayContaining([
        { session: 'deck_dead_brain', keys: 'continue' },
        { session: 'deck_pane_dead_w1', keys: 'continue' },
      ]),
    );
    expect(mocks.sendKeysCalls.filter((c) => c.session === 'deck_live_w2')).toEqual([]);
    expect(mocks.sendKeysCalls.filter((c) => c.session === 'deck_stopped_w3')).toEqual([]);
    expect(hasPendingRestartContinuation('deck_live_w2')).toBe(false);
    expect(hasPendingRestartContinuation('deck_dead_brain')).toBe(false);
    expect(hasPendingRestartContinuation('deck_pane_dead_w1')).toBe(false);
  });

  it('transport restore: restores pending-continue sessions in fast first wave and sends continue once with system origin', async () => {
    const main = makeRecord({
      name: 'deck_tr_brain',
      agentType: 'claude-code-sdk',
      providerId: 'claude-code-sdk',
      runtimeType: 'transport',
      providerSessionId: 'sid-main',
      providerResumeId: 'res-main',
      state: 'running',
    });
    const sub = makeRecord({
      name: 'deck_sub_worker',
      role: 'w1',
      agentType: 'claude-code-sdk',
      providerId: 'claude-code-sdk',
      runtimeType: 'transport',
      providerSessionId: 'sid-sub',
      providerResumeId: 'res-sub',
      state: 'running',
    });
    const idleUnmarked = makeRecord({
      name: 'deck_idle_other',
      role: 'w2',
      agentType: 'claude-code-sdk',
      providerId: 'claude-code-sdk',
      runtimeType: 'transport',
      providerSessionId: 'sid-idle',
      providerResumeId: 'res-idle',
      state: 'idle',
    });

    for (const r of [main, sub, idleUnmarked]) mocks.store.set(r.name, r);

    captureRestartContinuationsBeforeShutdown({
      sessions: [main, sub, idleUnmarked],
      getRuntime: (name) => (name === 'deck_idle_other'
        ? { sending: false, getStatus: () => 'idle' }
        : { sending: true, getStatus: () => 'streaming' }),
      epoch: 'ep-tr-wiring',
    });

    await restoreTransportSessions('claude-code-sdk', { onlyWithPendingResend: true });
    await new Promise((r) => setTimeout(r, 30));

    // Both main & sub were pulled into the fast first wave even without pending resend rows; idleUnmarked was skipped.
    const mainSid = mocks.store.get('deck_tr_brain')?.providerSessionId;
    const subSid = mocks.store.get('deck_sub_worker')?.providerSessionId;
    expect(mainSid).toBeTruthy();
    expect(subSid).toBeTruthy();
    expect(mocks.providerSends).toEqual([
      { sessionId: mainSid, message: 'continue' },
      { sessionId: subSid, message: 'continue' },
    ]);
    expect(mocks.store.has('deck_idle_other')).toBe(true);
    expect(mocks.store.get('deck_idle_other')?.providerSessionId).toBe('sid-idle');
    const continueUserEvents = mocks.timelineEvents.filter((e) => e.type === 'user.message' && e.payload.text === 'continue');
    expect(continueUserEvents).toHaveLength(2);
    for (const ev of continueUserEvents) {
      expect(ev.payload[USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]).toBe(CHAT_MESSAGE_ORIGINS.SYSTEM);
    }

    // Re-running restore must never re-send continue.
    await restoreTransportSessions('claude-code-sdk', { onlyWithPendingResend: true });
    expect(mocks.providerSends).toHaveLength(2);
  });

  it('transport restore: skips continue when codex rollout already completed or resend queue is non-empty', async () => {
    const codexSession = makeRecord({
      name: 'deck_codex_done',
      agentType: 'codex-sdk',
      providerId: 'codex-sdk',
      runtimeType: 'transport',
      providerSessionId: 'sid-codex-done',
      providerResumeId: 'res-codex-done',
      state: 'running',
    });
    const queuedSession = makeRecord({
      name: 'deck_queued_msg',
      agentType: 'claude-code-sdk',
      providerId: 'claude-code-sdk',
      runtimeType: 'transport',
      providerSessionId: 'sid-queued',
      providerResumeId: 'res-queued',
      state: 'running',
    });

    mocks.store.set(codexSession.name, codexSession);
    mocks.store.set(queuedSession.name, queuedSession);
    mocks.codexRolloutCompleted = true;
    enqueueResend(queuedSession.name, {
      text: 'queued user text',
      commandId: 'cmd-u1',
      clientMessageId: 'cmd-u1',
      queuedAt: Date.now(),
      recipient: recipientFromSessionRecord(queuedSession),
    });

    captureRestartContinuationsBeforeShutdown({
      sessions: [codexSession, queuedSession],
      getRuntime: () => ({ sending: true, getStatus: () => 'streaming' }),
      epoch: 'ep-exclusions',
    });

    await restoreTransportSessions('codex-sdk', { onlyWithPendingResend: true });
    await restoreTransportSessions('claude-code-sdk', { onlyWithPendingResend: true });
    await new Promise((r) => setTimeout(r, 30));

    // Codex completed turn sends nothing; queuedSession drains queued user text instead of 'continue'.
    const queuedSid = mocks.store.get('deck_queued_msg')?.providerSessionId;
    expect(queuedSid).toBeTruthy();
    expect(mocks.providerSends).toEqual([
      { sessionId: queuedSid, message: 'queued user text' },
    ]);
    expect(hasPendingRestartContinuation('deck_codex_done')).toBe(false);
    expect(hasPendingRestartContinuation('deck_queued_msg')).toBe(false);
  });

  it('shutdown capture persistence failure skips graceful_shutdown mark so next startup unclean fallback recovers', async () => {
    const active = makeRecord({
      name: 'deck_shutdown_fail_proc',
      agentType: 'opencode',
      runtimeType: 'process',
      state: 'running',
      updatedAt: Date.now(),
      opencodeSessionId: 'oc-sd-fail',
    });
    mocks.store.set(active.name, active);

    // 1) Daemon starts cleanly -> initial start was clean, run-state on disk is now 'running'.
    const initialBoot = beginUpgradeReadinessTracking({ startedAt: Date.now() - 1_000 });
    expect(initialBoot.uncleanPreviousExit).toBe(false);
    expect(readPreviousExitWasUnclean()).toBe(true);

    // 2) Shutdown continuation capture fails to persist (EACCES on target dir).
    const readonlyDir = join(tempHome, 'readonly-cont');
    mkdirSync(readonlyDir, { recursive: true });
    const failFilePath = join(readonlyDir, 'restart-continuation.json');
    chmodSync(readonlyDir, 0o500);
    let shutdownRes: { persisted: boolean; count: number };
    try {
      shutdownRes = captureShutdownRestartContinuationsAndMarkExit({ filePath: failFilePath });
    } finally {
      chmodSync(readonlyDir, 0o700);
    }
    expect(shutdownRes).toEqual({ persisted: false, count: 0 });

    // 3) Next startup sees uncleanPreviousExit === true because graceful_shutdown was NOT written.
    __resetUpgradeReadinessForTests();
    const uncleanStartup = beginUpgradeReadinessTracking({ startedAt: Date.now() }).uncleanPreviousExit;
    expect(uncleanStartup).toBe(true);

    // Unclean fallback recovers active session and restoreFromStore sends continue once.
    const fallback = captureUncleanRestartContinuations({
      uncleanPreviousExit: uncleanStartup,
      sessions: [active],
      epoch: 'ep-fallback-recover',
    });
    expect(fallback).toHaveLength(1);
    await restoreFromStore();
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.sendKeysCalls).toEqual([
      { session: 'deck_shutdown_fail_proc', keys: 'continue' },
    ]);

    // 4) When writable, shutdown capture marks graceful_shutdown cleanly.
    mocks.store.set(active.name, { ...active, state: 'running' });
    beginUpgradeReadinessTracking({ startedAt: Date.now() });
    const okRes = captureShutdownRestartContinuationsAndMarkExit({ filePath: restartContinuationPath() });
    expect(okRes).toEqual({ persisted: true, count: 1 });
    __resetUpgradeReadinessForTests();
    expect(readPreviousExitWasUnclean()).toBe(false);
  });

  it('process sub-session restore & rebuildSubSessions: respawns dead pane once, launches missing once, skips live & negative controls', async () => {
    const subMissing = makeRecord({
      name: 'deck_sub_missing1',
      role: 'w1',
      agentType: 'opencode',
      runtimeType: 'process',
      state: 'running',
      opencodeSessionId: 'oc-sub-miss',
    });
    const subDead = makeRecord({
      name: 'deck_sub_dead1',
      role: 'w1',
      agentType: 'opencode',
      runtimeType: 'process',
      state: 'running',
      opencodeSessionId: 'oc-sub-dead',
    });
    const subDeadStandalone = makeRecord({
      name: 'deck_sub_deadstandalone1',
      role: 'w1',
      agentType: 'opencode',
      runtimeType: 'process',
      state: 'running',
      opencodeSessionId: 'oc-sub-dead-sa',
    });
    const subLive = makeRecord({
      name: 'deck_sub_live1',
      role: 'w1',
      agentType: 'opencode',
      runtimeType: 'process',
      state: 'running',
      opencodeSessionId: 'oc-sub-live',
    });
    const subStopped = makeRecord({
      name: 'deck_sub_stopped1',
      role: 'w1',
      agentType: 'opencode',
      runtimeType: 'process',
      state: 'stopped',
      opencodeSessionId: 'oc-sub-stop',
    });
    const subErr = makeRecord({
      name: 'deck_sub_err1',
      role: 'w1',
      agentType: 'opencode',
      runtimeType: 'process',
      state: 'error',
      opencodeSessionId: 'oc-sub-err',
    });
    const subIncog = makeRecord({
      name: 'deck_sub_incog1',
      role: 'w1',
      agentType: 'opencode',
      runtimeType: 'process',
      state: 'running',
      incognito: true,
      opencodeSessionId: 'oc-sub-incog',
    });
    const subShell = makeRecord({
      name: 'deck_sub_shell1',
      role: 'w1',
      agentType: 'shell',
      runtimeType: 'process',
      state: 'running',
    });
    const subScript = makeRecord({
      name: 'deck_sub_script1',
      role: 'w1',
      agentType: 'script',
      runtimeType: 'process',
      state: 'running',
    });
    const subUserStop = makeRecord({
      name: 'deck_sub_userstop1',
      role: 'w1',
      agentType: 'opencode',
      runtimeType: 'process',
      state: 'running',
      opencodeSessionId: 'oc-sub-ustop',
    });

    const restoreSet = [
      subMissing,
      subDead,
      subLive,
      subStopped,
      subErr,
      subIncog,
      subShell,
      subScript,
      subUserStop,
    ];
    for (const r of restoreSet) mocks.store.set(r.name, r);

    // Live tmux state: subLive is alive; subDead + negative controls exist as remain-on-exit dead panes; subMissing does not exist.
    for (const deadName of [
      subDead.name,
      subStopped.name,
      subErr.name,
      subIncog.name,
      subShell.name,
      subScript.name,
      subUserStop.name,
    ]) {
      mocks.tmuxLive.add(deadName);
    }
    mocks.tmuxLive.add(subLive.name);
    mocks.tmuxPaneAlive.add(subLive.name);

    markSessionUserStopped(subUserStop.name, Date.now() - 100);
    captureRestartContinuationsBeforeShutdown({
      sessions: restoreSet,
      getRuntime: () => undefined,
      epoch: 'ep-sub-restore',
    });

    // 1) Daemon restoreFromStore followed by server sync rebuildSubSessions (active sub-sessions only, matching syncSubSessions).
    await restoreFromStore();
    await new Promise((r) => setTimeout(r, 30));

    const rebuildDtos: Parameters<typeof rebuildSubSessions>[0] = [
      { id: 'missing1', type: 'opencode', cwd: '/tmp/proj', opencodeSessionId: 'oc-sub-miss' },
      { id: 'dead1', type: 'opencode', cwd: '/tmp/proj', opencodeSessionId: 'oc-sub-dead' },
      { id: 'live1', type: 'opencode', cwd: '/tmp/proj', opencodeSessionId: 'oc-sub-live' },
      { id: 'err1', type: 'opencode', cwd: '/tmp/proj', opencodeSessionId: 'oc-sub-err' },
      { id: 'incog1', type: 'opencode', cwd: '/tmp/proj', opencodeSessionId: 'oc-sub-incog' },
      { id: 'shell1', type: 'shell', cwd: '/tmp/proj' },
      { id: 'script1', type: 'script', cwd: '/tmp/proj' },
      { id: 'userstop1', type: 'opencode', cwd: '/tmp/proj', opencodeSessionId: 'oc-sub-ustop' },
    ];
    await rebuildSubSessions(rebuildDtos);
    // Replay rebuildSubSessions (simulates reconnect) — must NEVER double-respawn or double-continue.
    await rebuildSubSessions(rebuildDtos);
    await new Promise((r) => setTimeout(r, 30));

    expect(mocks.respawnCalls).toEqual(['deck_sub_dead1']);
    expect(mocks.tmuxPaneAlive.has('deck_sub_dead1')).toBe(true);
    expect(mocks.tmuxPaneAlive.has('deck_sub_missing1')).toBe(true);
    for (const neg of [subStopped.name, subErr.name, subIncog.name, subShell.name, subScript.name, subUserStop.name]) {
      expect(mocks.tmuxPaneAlive.has(neg)).toBe(false);
    }
    expect(mocks.store.get(subStopped.name)?.state).toBe('stopped');
    expect(mocks.store.get(subErr.name)?.state).toBe('error');

    const sentSessions = mocks.sendKeysCalls.map((c) => `${c.session}:${c.keys}`).sort();
    expect(sentSessions).toEqual([
      'deck_sub_dead1:continue',
      'deck_sub_missing1:continue',
    ]);
    expect(hasPendingRestartContinuation('deck_sub_dead1')).toBe(false);
    expect(hasPendingRestartContinuation('deck_sub_missing1')).toBe(false);
    expect(hasPendingRestartContinuation('deck_sub_live1')).toBe(false);

    // 2) Standalone rebuildSubSessions without prior restoreFromStore also recovers a dead-pane sub-session once.
    mocks.store.set(subDeadStandalone.name, subDeadStandalone);
    mocks.tmuxLive.add(subDeadStandalone.name);
    captureRestartContinuationsBeforeShutdown({
      sessions: [subDeadStandalone],
      getRuntime: () => undefined,
      epoch: 'ep-sub-standalone',
    });
    const standaloneDtos: Parameters<typeof rebuildSubSessions>[0] = [
      { id: 'deadstandalone1', type: 'opencode', cwd: '/tmp/proj', opencodeSessionId: 'oc-sub-dead-sa' },
    ];
    await rebuildSubSessions(standaloneDtos);
    await rebuildSubSessions(standaloneDtos);
    await new Promise((r) => setTimeout(r, 30));

    expect(mocks.respawnCalls.filter((n) => n === 'deck_sub_deadstandalone1')).toHaveLength(1);
    expect(mocks.tmuxPaneAlive.has('deck_sub_deadstandalone1')).toBe(true);
    expect(mocks.sendKeysCalls.filter((c) => c.session === 'deck_sub_deadstandalone1' && c.keys === 'continue')).toHaveLength(1);
  });

  it('delayed-ready process restore & rebuild replays: keeps marker pending until real postLaunch finishes, then sends continue once', async () => {
    const subDeadCc = makeRecord({
      name: 'deck_sub_cc_dead',
      role: 'w1',
      agentType: 'claude-code',
      runtimeType: 'process',
      state: 'running',
      updatedAt: Date.now(),
      ccSessionId: '11111111-1111-4111-8111-111111111101',
    });
    const subDeadStandaloneCc = makeRecord({
      name: 'deck_sub_cc_dead_sa',
      role: 'w1',
      agentType: 'claude-code',
      runtimeType: 'process',
      state: 'running',
      updatedAt: Date.now(),
      ccSessionId: '11111111-1111-4111-8111-111111111102',
    });
    const subMissingCc = makeRecord({
      name: 'deck_sub_cc_miss',
      role: 'w1',
      agentType: 'claude-code',
      runtimeType: 'process',
      state: 'running',
      updatedAt: Date.now(),
      ccSessionId: '11111111-1111-4111-8111-111111111103',
    });
    const subLiveCc = makeRecord({
      name: 'deck_sub_cc_live',
      role: 'w1',
      agentType: 'claude-code',
      runtimeType: 'process',
      state: 'running',
      updatedAt: Date.now(),
      ccSessionId: '11111111-1111-4111-8111-111111111104',
    });
    const subStoppedCc = makeRecord({
      name: 'deck_sub_cc_stop',
      role: 'w1',
      agentType: 'claude-code',
      runtimeType: 'process',
      state: 'stopped',
      updatedAt: Date.now(),
      ccSessionId: '11111111-1111-4111-8111-111111111105',
    });
    const mainDeadCc = makeRecord({
      name: 'deck_cc_main_dead',
      role: 'brain',
      agentType: 'claude-code',
      runtimeType: 'process',
      state: 'running',
      updatedAt: Date.now(),
      ccSessionId: '11111111-1111-4111-8111-111111111106',
    });
    const mainMissingCc = makeRecord({
      name: 'deck_cc_main_miss',
      role: 'brain',
      agentType: 'claude-code',
      runtimeType: 'process',
      state: 'running',
      updatedAt: Date.now(),
      ccSessionId: '11111111-1111-4111-8111-111111111107',
    });

    const initialRestoreSet = [subDeadCc, subLiveCc, subStoppedCc, mainDeadCc, mainMissingCc];
    for (const r of initialRestoreSet) mocks.store.set(r.name, r);

    // Dead panes exist in tmux with dead pane; surviving live sub-session has alive pane; mainMissingCc has no tmux session.
    mocks.tmuxLive.add(subDeadCc.name);
    mocks.tmuxLive.add(subStoppedCc.name);
    mocks.tmuxLive.add(mainDeadCc.name);
    mocks.tmuxLive.add(subLiveCc.name);
    mocks.tmuxPaneAlive.add(subLiveCc.name);

    captureRestartContinuationsBeforeShutdown({
      sessions: [...initialRestoreSet, subDeadStandaloneCc, subMissingCc],
      getRuntime: () => undefined,
      epoch: 'ep-delayed-ready-cc',
    });

    // 1) Startup restoreFromStore spawns/respawns replacement panes and enters real ClaudeDriver.postLaunch (~1500ms).
    await restoreFromStore();

    // Add standalone dead-pane and missing sub-session right before rebuild replays.
    mocks.store.set(subDeadStandaloneCc.name, subDeadStandaloneCc);
    mocks.tmuxLive.add(subDeadStandaloneCc.name);
    mocks.store.set(subMissingCc.name, subMissingCc);

    const dtos: Parameters<typeof rebuildSubSessions>[0] = [
      { id: 'cc_dead', type: 'claude-code', cwd: '/tmp/proj', ccSessionId: subDeadCc.ccSessionId },
      { id: 'cc_dead_sa', type: 'claude-code', cwd: '/tmp/proj', ccSessionId: subDeadStandaloneCc.ccSessionId },
      { id: 'cc_miss', type: 'claude-code', cwd: '/tmp/proj', ccSessionId: subMissingCc.ccSessionId },
      { id: 'cc_live', type: 'claude-code', cwd: '/tmp/proj', ccSessionId: subLiveCc.ccSessionId },
    ];

    // 2) Immediate replay of rebuildSubSessions (2x) and restoreFromStore while postLaunch is still pending.
    await rebuildSubSessions(dtos);
    await rebuildSubSessions(dtos);
    await restoreFromStore();

    // During the pre-ready window, replacement panes MUST retain pending continuation markers (not prematurely consumed).
    for (const s of [subDeadCc, subDeadStandaloneCc, subMissingCc, mainDeadCc, mainMissingCc]) {
      expect(hasPendingRestartContinuation(s.name), `${s.name} must stay pending until postLaunch finishes`).toBe(true);
    }
    expect(mocks.sendKeysCalls.filter((c) => c.keys === 'continue')).toHaveLength(0);
    // Genuine cross-restart surviving pane already discarded its marker on restore.
    expect(hasPendingRestartContinuation(subLiveCc.name)).toBe(false);

    // 3) Wait for real ClaudeDriver.postLaunch (~1500ms) to finish and emit exactly 1 'continue' per recovered session.
    await vi.waitFor(() => {
      const sent = mocks.sendKeysCalls.filter((c) => c.keys === 'continue').map((c) => c.session).sort();
      expect(sent).toEqual([
        mainDeadCc.name,
        mainMissingCc.name,
        subDeadCc.name,
        subDeadStandaloneCc.name,
        subMissingCc.name,
      ].sort());
    }, { timeout: 5_000, interval: 50 });

    // Replaying rebuildSubSessions again post-ready must remain idempotent (0 extra continues, 0 extra respawns).
    await rebuildSubSessions(dtos);
    expect(mocks.sendKeysCalls.filter((c) => c.keys === 'continue')).toHaveLength(5);
    expect(mocks.respawnCalls.filter((n) => n === subDeadCc.name)).toHaveLength(1);
    expect(mocks.respawnCalls.filter((n) => n === subDeadStandaloneCc.name)).toHaveLength(1);
    expect(mocks.respawnCalls.filter((n) => n === mainDeadCc.name)).toHaveLength(1);
    expect(mocks.respawnCalls.filter((n) => n === subLiveCc.name || n === subStoppedCc.name)).toHaveLength(0);
    expect(mocks.sendKeysCalls.filter((c) => c.session === subLiveCc.name || c.session === subStoppedCc.name)).toHaveLength(0);
    expect(mocks.tmuxPaneAlive.has(subStoppedCc.name)).toBe(false);
  }, 10_000);
});
