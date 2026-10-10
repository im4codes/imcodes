import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, Record<string, any>>(),
  listCalls: 0,
  listFails: false,
  warns: [] as Array<{ obj: Record<string, unknown>; msg: string }>,
  infos: [] as string[],
  emits: [] as Array<{ session: string; type: string; payload: Record<string, unknown> }>,
}));

// cursor-headless cannot list sessions (the real provider has no listSessions);
// copilot-sdk can, so a listSessions failure there is a transient failure.
vi.mock('../../src/agent/providers/cursor-headless.js', () => ({
  CursorHeadlessProvider: class {
    id = 'cursor-headless';
    async connect(): Promise<void> {}
    async disconnect(): Promise<void> {}
  },
}));
vi.mock('../../src/agent/providers/copilot-sdk.js', () => ({
  CopilotSdkProvider: class {
    id = 'copilot-sdk';
    async connect(): Promise<void> {}
    async disconnect(): Promise<void> {}
    async listSessions(): Promise<never[]> {
      mocks.listCalls += 1;
      if (mocks.listFails) throw new Error('ECONNRESET');
      return [];
    }
  },
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => [...mocks.store.values()]),
  getSession: vi.fn((name: string) => mocks.store.get(name) ?? null),
  upsertSession: vi.fn((record: Record<string, any>) => { if (record.name) mocks.store.set(record.name, record); }),
  removeSession: vi.fn((name: string) => { mocks.store.delete(name); }),
  updateSessionState: vi.fn(),
}));
vi.mock('../../src/daemon/transport-relay.js', () => ({ wireProviderToRelay: vi.fn(), broadcastProviderStatus: vi.fn() }));
vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn((_obj: unknown, msg?: string) => { if (typeof msg === 'string') mocks.infos.push(msg); }),
    warn: vi.fn((obj: Record<string, unknown>, msg?: string) => { mocks.warns.push({ obj: obj ?? {}, msg: String(msg ?? '') }); }),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn((session: string, type: string, payload: Record<string, unknown>) => { mocks.emits.push({ session, type, payload }); }), on: vi.fn(() => () => {}), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })), forgetSession: vi.fn() },
}));
vi.mock('../../src/agent/tmux.js', () => ({
  listSessions: vi.fn().mockResolvedValue([]), newSession: vi.fn(), killSession: vi.fn().mockResolvedValue(undefined),
  sessionExists: vi.fn(), isPaneAlive: vi.fn(), respawnPane: vi.fn(), sendKeys: vi.fn(), sendKey: vi.fn(), capturePane: vi.fn(),
  showBuffer: vi.fn(), getPaneId: vi.fn().mockResolvedValue(undefined), getPaneCwd: vi.fn().mockResolvedValue('/tmp'),
  getPaneStartCommand: vi.fn().mockResolvedValue(''), cleanupOrphanFifos: vi.fn(), BACKEND: 'tmux',
}));
vi.mock('../../src/daemon/jsonl-watcher.js', () => ({ startWatching: vi.fn(), startWatchingFile: vi.fn(), stopWatching: vi.fn(), isWatching: vi.fn(() => false), findJsonlPathBySessionId: vi.fn() }));
vi.mock('../../src/daemon/codex-watcher.js', () => ({ startWatching: vi.fn(), startWatchingSpecificFile: vi.fn(), startWatchingById: vi.fn(), stopWatching: vi.fn(), isWatching: vi.fn(() => false), findRolloutPathByUuid: vi.fn(async () => null) }));
vi.mock('../../src/daemon/gemini-watcher.js', () => ({ startWatching: vi.fn(), startWatchingLatest: vi.fn(), stopWatching: vi.fn(), isWatching: vi.fn(() => false) }));
vi.mock('../../src/daemon/opencode-watcher.js', () => ({ startWatching: vi.fn(), stopWatching: vi.fn(), isWatching: vi.fn(() => false) }));
vi.mock('../../src/agent/structured-session-bootstrap.js', () => ({ resolveStructuredSessionBootstrap: vi.fn(async (x) => x) }));
vi.mock('../../src/agent/qwen-runtime-config.js', () => ({ getQwenRuntimeConfig: vi.fn(async () => null) }));
vi.mock('../../src/agent/sdk-runtime-config.js', () => ({ getClaudeSdkRuntimeConfig: vi.fn(async () => ({})) }));
vi.mock('../../src/agent/codex-runtime-config.js', () => ({ getCodexRuntimeConfig: vi.fn(async () => ({})) }));
vi.mock('../../src/agent/provider-display.js', () => ({ getQwenDisplayMetadata: vi.fn(() => ({})) }));
vi.mock('../../src/agent/provider-quota.js', () => ({ getQwenOAuthQuotaUsageLabel: vi.fn(() => '') }));
vi.mock('../../src/agent/agent-version.js', () => ({ getAgentVersion: vi.fn(async () => 'test') }));
vi.mock('../../src/agent/signal.js', () => ({ setupCCStopHook: vi.fn(async () => {}) }));
vi.mock('../../src/agent/notify-setup.js', () => ({ setupCodexNotify: vi.fn(async () => {}), setupOpenCodePlugin: vi.fn(async () => {}) }));
vi.mock('../../src/repo/cache.js', () => ({ repoCache: { invalidate: vi.fn() } }));
vi.mock('../../src/agent/brain-dispatcher.js', () => ({ BrainDispatcher: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })) }));

import { connectProvider, disconnectAll } from '../../src/agent/provider-registry.js';
import { ensureTransportRuntimeAvailable, ensureTransportRuntimeForPendingResend } from '../../src/agent/session-manager.js';
import { TRANSPORT_RESTORE_BACKOFF_STEPS_MS, resetTransportRestoreBackoffForTests, transportRestoreBackoffSize } from '../../src/agent/transport-restore-backoff.js';
import { clearAllResend, enqueueResend, getResendCount } from '../../src/daemon/transport-resend-queue.js';
import { DAEMON_USER_NOTICE_CODE } from '../../shared/daemon-user-notices.js';

const RESTORE_LOG = 'Restoring transport session runtimes';
const UNBOUND_WARN = 'Transport restore requires a durable provider id but the provider cannot list sessions';
const T0 = Date.UTC(2026, 8, 30, 0, 0, 0);

function seedSession(name: string, over: Record<string, unknown> = {}): void {
  mocks.store.set(name, {
    name, projectName: 'p', role: 'w1', agentType: 'cursor-headless', projectDir: '/tmp/cursor-work', state: 'idle',
    restarts: 0, restartTimestamps: [], createdAt: T0, updatedAt: T0, runtimeType: 'transport',
    providerId: 'cursor-headless', providerSessionId: `route-${name}`, sessionInstanceId: `inst-${name}`, runtimeEpoch: 'epoch-1',
    ...over,
  });
}
const restoreAttempts = (): number => mocks.infos.filter((m) => m === RESTORE_LOG).length;
const unboundWarns = () => mocks.warns.filter((w) => w.msg === UNBOUND_WARN);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  mocks.store.clear();
  mocks.warns.length = 0;
  mocks.infos.length = 0;
  mocks.listCalls = 0;
  mocks.listFails = false;
  mocks.emits.length = 0;
  clearAllResend();
  resetTransportRestoreBackoffForTests();
});
afterEach(async () => {
  await disconnectAll();
  vi.useRealTimers();
});
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe('transport restore backoff through ensureTransportRuntimeAvailable', () => {
  it('repeated calls inside the window do not restore; each window end allows exactly one attempt (5s -> 60s -> 300s cap)', async () => {
    seedSession('deck_sub_cursor1');
    expect(await ensureTransportRuntimeAvailable('deck_sub_cursor1')).toBeUndefined();
    expect(restoreAttempts()).toBe(1);

    for (const stepMs of [...TRANSPORT_RESTORE_BACKOFF_STEPS_MS, 300_000]) {
      const before = restoreAttempts();
      // Sweep-like hammering inside the window: never restores.
      for (let elapsed = 0; elapsed < stepMs - 1_000; elapsed += 1_000) {
        advance(1_000);
        await ensureTransportRuntimeAvailable('deck_sub_cursor1');
      }
      expect(restoreAttempts(), `inside the ${stepMs}ms window`).toBe(before);
      advance(1_000);
      await ensureTransportRuntimeAvailable('deck_sub_cursor1');
      expect(restoreAttempts(), `at the end of the ${stepMs}ms window`).toBe(before + 1);
    }
  });

  it('logs at most one warn per backoff step, not one per 5s sweep tick (30 simulated minutes)', async () => {
    seedSession('deck_sub_cursor2');
    for (let elapsed = 0; elapsed <= 30 * 60_000; elapsed += 5_000) {
      await ensureTransportRuntimeAvailable('deck_sub_cursor2');
      advance(5_000);
    }
    const warns = unboundWarns();
    const steps = warns.map((w) => w.obj.backoffStep as number);
    expect(new Set(steps).size).toBe(steps.length); // one warn per step
    expect(steps).toEqual(steps.map((_, index) => index + 1)); // steps are consecutive
    expect(warns.length).toBe(restoreAttempts());
    expect(warns.length).toBeLessThanOrEqual(8); // unthrottled this would be 361
    expect(warns[0]!.obj.nextRetryInMs).toBe(5_000);
    expect(warns[1]!.obj.nextRetryInMs).toBe(60_000);
    expect(warns[2]!.obj.nextRetryInMs).toBe(300_000);
  });

  it('a user send bypasses the cache and restores immediately, without extra warns or a shifted schedule', async () => {
    seedSession('deck_sub_cursor3');
    await ensureTransportRuntimeAvailable('deck_sub_cursor3');
    expect(restoreAttempts()).toBe(1);
    advance(1_000);
    await ensureTransportRuntimeAvailable('deck_sub_cursor3'); // sweep: gated
    expect(restoreAttempts()).toBe(1);

    await ensureTransportRuntimeForPendingResend('deck_sub_cursor3', { bypassBackoff: true }); // message just queued
    expect(restoreAttempts()).toBe(2); // attempted inside the window
    expect(unboundWarns()).toHaveLength(1); // ...but did not warn again

    advance(4_000); // the original 5s window is over
    await ensureTransportRuntimeAvailable('deck_sub_cursor3');
    expect(restoreAttempts()).toBe(3);
    expect(unboundWarns().map((w) => w.obj.backoffStep)).toEqual([1, 2]); // schedule did not skip ahead
  });

  it('resets on provider reconnect', async () => {
    seedSession('deck_sub_cursor4');
    await connectProvider('cursor-headless', {});
    await ensureTransportRuntimeAvailable('deck_sub_cursor4');
    advance(1_000);
    await ensureTransportRuntimeAvailable('deck_sub_cursor4');
    expect(restoreAttempts()).toBe(1);
    await connectProvider('cursor-headless', {}); // provider reconnected
    await ensureTransportRuntimeAvailable('deck_sub_cursor4');
    expect(restoreAttempts()).toBe(2);
    expect(unboundWarns().map((w) => w.obj.backoffStep)).toEqual([1, 1]); // restarted at step 1
  });

  it('resets when the session record changes (project dir edit / provider id bound / relaunch)', async () => {
    seedSession('deck_sub_cursor5');
    await ensureTransportRuntimeAvailable('deck_sub_cursor5');
    advance(1_000);
    await ensureTransportRuntimeAvailable('deck_sub_cursor5');
    expect(restoreAttempts()).toBe(1);

    seedSession('deck_sub_cursor5', { projectDir: '/tmp/moved' }); // config change
    await ensureTransportRuntimeAvailable('deck_sub_cursor5');
    expect(restoreAttempts()).toBe(2);

    seedSession('deck_sub_cursor5', { projectDir: '/tmp/moved', runtimeEpoch: 'epoch-2' }); // relaunched
    await ensureTransportRuntimeAvailable('deck_sub_cursor5');
    expect(restoreAttempts()).toBe(3);
  });

  it('keeps sessions independent and drops a deleted session\'s entry (no leak) via the sweep prune', async () => {
    const { pruneTransportRestoreBackoff } = await import('../../src/agent/transport-restore-backoff.js');
    for (let i = 0; i < 20; i += 1) seedSession(`deck_sub_many${i}`);
    for (let i = 0; i < 20; i += 1) await ensureTransportRuntimeAvailable(`deck_sub_many${i}`);
    expect(restoreAttempts()).toBe(20);
    expect(transportRestoreBackoffSize()).toBe(20);
    for (let i = 0; i < 20; i += 1) await ensureTransportRuntimeAvailable(`deck_sub_many${i}`);
    expect(restoreAttempts()).toBe(20); // every one is backed off individually

    mocks.store.delete('deck_sub_many3'); // deleted while backed off
    pruneTransportRestoreBackoff((name) => mocks.store.has(name)); // what the 5s sweep does
    expect(transportRestoreBackoffSize()).toBe(19);
  });

  it('a session that does not exist is never gated and never cached', async () => {
    expect(await ensureTransportRuntimeAvailable('deck_sub_missing')).toBeUndefined();
    expect(transportRestoreBackoffSize()).toBe(0);
  });

  it('keeps retrying transient failures for a provider that CAN list sessions (no backoff)', async () => {
    seedSession('deck_sub_copilot1', {
      agentType: 'copilot-sdk', providerId: 'copilot-sdk', projectDir: '/tmp/copilot-work',
    });
    mocks.listFails = true;
    for (let i = 0; i < 4; i += 1) {
      await ensureTransportRuntimeAvailable('deck_sub_copilot1');
      advance(1_000);
    }
    expect(restoreAttempts()).toBe(4); // every call attempted
    expect(mocks.listCalls).toBeGreaterThanOrEqual(4);
    expect(transportRestoreBackoffSize()).toBe(0);
    expect(unboundWarns()).toHaveLength(0);
  });

  it('a directory-scoped provider without a usable project dir is also backed off (the other permanent reason)', async () => {
    seedSession('deck_sub_copilot2', {
      agentType: 'copilot-sdk', providerId: 'copilot-sdk', projectDir: '',
    });
    await ensureTransportRuntimeAvailable('deck_sub_copilot2');
    advance(1_000);
    await ensureTransportRuntimeAvailable('deck_sub_copilot2');
    expect(restoreAttempts()).toBe(1);
    expect(mocks.warns.filter((w) => w.msg.startsWith('Transport restore requires a valid project directory'))).toHaveLength(1);
  });
});

describe('providers that never reach the permanent branch', () => {
  it('only providers that resume by a provider resume id can be backed off (qwen, openclaw, codex-sdk, claude-code-sdk cannot)', async () => {
    const { usesProviderResumeId } = await import('../../src/agent/transport-resume-opts.js');
    expect(['qwen', 'openclaw', 'codex-sdk', 'claude-code-sdk'].map((id) => usesProviderResumeId(id))).toEqual([false, false, false, false]);
    expect(usesProviderResumeId('cursor-headless')).toBe(true);
  });
});

// ---- user-visible notice for a send to a permanently unbound session ----------------------------
const SEND = { bypassBackoff: true, notifyIfPermanentlyUnbound: true } as const;
const notices = () => mocks.emits.filter((e) => e.type === 'assistant.text' && e.payload.noticeCode === DAEMON_USER_NOTICE_CODE.TRANSPORT_RESTORE_UNBOUND);
function queueUserMessage(name: string, id: string): void {
  expect(enqueueResend(name, { text: `hello ${id}`, commandId: id, clientMessageId: id, queuedAt: Date.now() }).accepted).toBe(true);
}

describe('unbound-send notice (send path of a permanently unbound session)', () => {
  it('a send tells the user once, with a shared notice code, and the message stays queued', async () => {
    seedSession('deck_sub_notice1');
    queueUserMessage('deck_sub_notice1', 'msg-1');
    await ensureTransportRuntimeForPendingResend('deck_sub_notice1', SEND);
    expect(notices()).toHaveLength(1);
    const [notice] = notices();
    expect(notice!.session).toBe('deck_sub_notice1');
    expect(notice!.payload).toMatchObject({ noticeCode: 'transport_restore_unbound', streaming: false, memoryExcluded: true });
    expect(String(notice!.payload.text)).toContain('relaunch');
    expect(getResendCount('deck_sub_notice1')).toBe(1); // still queued, a relaunch can deliver it
  });

  it('a burst of sends inside one backoff step notices exactly once', async () => {
    seedSession('deck_sub_notice2');
    for (let i = 0; i < 6; i += 1) queueUserMessage('deck_sub_notice2', `burst-${i}`);
    await Promise.all(Array.from({ length: 6 }, () => ensureTransportRuntimeForPendingResend('deck_sub_notice2', SEND)));
    for (let i = 0; i < 4; i += 1) {
      advance(500);
      await ensureTransportRuntimeForPendingResend('deck_sub_notice2', SEND);
    }
    expect(notices()).toHaveLength(1);
    expect(getResendCount('deck_sub_notice2')).toBe(6);
  });

  it('notices again only when the backoff advances to a new step (5s, then 60s, then 300s), never per message', async () => {
    seedSession('deck_sub_notice3');
    await ensureTransportRuntimeForPendingResend('deck_sub_notice3', SEND); // step 1
    expect(notices()).toHaveLength(1);
    advance(1_000);
    await ensureTransportRuntimeForPendingResend('deck_sub_notice3', SEND); // same step: bypass attempt inside window
    expect(notices()).toHaveLength(1);
    // The 5 s sweep (not a user send) reaches the window end and advances the schedule to step 2 ...
    advance(TRANSPORT_RESTORE_BACKOFF_STEPS_MS[0]);
    await ensureTransportRuntimeAvailable('deck_sub_notice3');
    expect(notices()).toHaveLength(1); // ... which alone never notices,
    await ensureTransportRuntimeForPendingResend('deck_sub_notice3', SEND); // but the next send does, once
    expect(notices()).toHaveLength(2);
    await ensureTransportRuntimeForPendingResend('deck_sub_notice3', SEND);
    expect(notices()).toHaveLength(2);
    advance(TRANSPORT_RESTORE_BACKOFF_STEPS_MS[1]);
    await ensureTransportRuntimeAvailable('deck_sub_notice3'); // step 3
    await ensureTransportRuntimeForPendingResend('deck_sub_notice3', SEND);
    expect(notices()).toHaveLength(3);
  });

  it('background callers (sweep, cron, supervision) never notice: only a send that asks for it does', async () => {
    seedSession('deck_sub_notice4');
    await ensureTransportRuntimeForPendingResend('deck_sub_notice4'); // as the durable sweep calls it
    await ensureTransportRuntimeAvailable('deck_sub_notice4');
    expect(notices()).toHaveLength(0);
  });

  it('a transient failure (provider that CAN list sessions, listSessions throws) produces no notice', async () => {
    seedSession('deck_sub_notice5', { agentType: 'copilot-sdk', providerId: 'copilot-sdk', projectDir: '/tmp/copilot-work' });
    mocks.listFails = true;
    queueUserMessage('deck_sub_notice5', 'transient-1');
    for (let i = 0; i < 3; i += 1) await ensureTransportRuntimeForPendingResend('deck_sub_notice5', SEND);
    expect(notices()).toHaveLength(0);
    expect(getResendCount('deck_sub_notice5')).toBe(1);
  });

  it('the other permanent reason (directory-scoped provider without a project dir) notices too', async () => {
    seedSession('deck_sub_notice6', { agentType: 'copilot-sdk', providerId: 'copilot-sdk', projectDir: '' });
    await ensureTransportRuntimeForPendingResend('deck_sub_notice6', SEND);
    expect(notices()).toHaveLength(1);
  });

  it('a session deleted while its message is queued produces no notice and does not throw', async () => {
    seedSession('deck_sub_notice7');
    queueUserMessage('deck_sub_notice7', 'gone-1');
    await ensureTransportRuntimeForPendingResend('deck_sub_notice7', SEND);
    expect(notices()).toHaveLength(1);
    mocks.store.delete('deck_sub_notice7');
    advance(10_000);
    await expect(ensureTransportRuntimeForPendingResend('deck_sub_notice7', SEND)).resolves.toBeUndefined();
    expect(notices()).toHaveLength(1);
  });

  it('after a daemon restart (empty in-memory state) the first send notices once again, and only once', async () => {
    seedSession('deck_sub_notice8');
    await ensureTransportRuntimeForPendingResend('deck_sub_notice8', SEND);
    expect(notices()).toHaveLength(1);
    resetTransportRestoreBackoffForTests(); // daemon restart
    await ensureTransportRuntimeForPendingResend('deck_sub_notice8', SEND);
    await ensureTransportRuntimeForPendingResend('deck_sub_notice8', SEND);
    expect(notices()).toHaveLength(2);
  });

  it('a relaunch (record change) resets the notice: no further notice for the relaunched, restorable state', async () => {
    seedSession('deck_sub_notice9');
    await ensureTransportRuntimeForPendingResend('deck_sub_notice9', SEND);
    expect(notices()).toHaveLength(1);
    // The relaunch binds the provider conversation: the record changes, so the recorded failure no longer applies.
    seedSession('deck_sub_notice9', { providerResumeId: 'bound-resume-id', runtimeEpoch: 'epoch-2' });
    await ensureTransportRuntimeForPendingResend('deck_sub_notice9', SEND);
    expect(notices()).toHaveLength(1);
  });
});
