/**
 * A pair can never say "dispatched" about a session that does not exist (tsk_4b924944b6).
 *
 * The field failure: pair_create reported a pair with an auto-created Haiku executor, but `deck_sub_pair_auto_...` answered
 * `session_not_found`. Cause: the stdio MCP child (not the daemon) ran pair_create, so the session was launched into the CHILD's private
 * session map and provider registry - invisible to the daemon, never announced to the server, gone with the child. The fixes pinned here:
 *   - pair_* tools run in the daemon (MEMORY_MCP_DAEMON_TOOL_NAMES) and the creation path refuses to run anywhere else;
 *   - a created session is verified live and announced (`subsession.sync`) BEFORE any brief goes out;
 *   - every failure leaves no pair and no session behind, each with a structured error;
 *   - an assigned session that is missing later is reported to the Brain by name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../../shared/context-types.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import { MEMORY_MCP_DAEMON_TOOL_NAMES } from '../../../shared/memory-mcp-daemon-rpc.js';
import { TASK_PAIR_CREATED_SESSION_REASONS, TASK_PAIR_CREATED_SESSION_SOURCE, type TaskPairCreatedSessionMetadata } from '../../../shared/task-pair.js';
import type { McpRuntimeCaller } from '../../../src/daemon/memory-mcp-caller.js';
import { createMemoryMcpToolHandlers } from '../../../src/daemon/memory-mcp-tools.js';
import { getSession, listSessions, removeSession, upsertSession, type SessionRecord } from '../../../src/store/session-store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { setPairSessionCreationDepsForTests, resolveCreationConfig } from '../../../src/daemon/task-pairs/session-creation.js';
import { createPairSubSession, pairSessionNotLiveReason, type PairSubSessionFailureReason, type PairSubSessionRequest, type PairSubSessionResult } from '../../../src/daemon/supervision-auto-provision.js';
import { resetActiveServerLinkForTests, setActiveServerLink } from '../../../src/daemon/active-server-link.js';

const PROJECT = 'liveproj';
const BRAIN = 'deck_liveproj_brain';
const caller: McpRuntimeCaller = {
  userId: 'u', namespace: { scope: 'user_private', userId: 'u', projectId: PROJECT } as ContextNamespace,
  sessionName: BRAIN, projectName: PROJECT, projectRoot: '/tmp/liveproj', serverId: 'srv', transport: 'in_process',
};

function session(name: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName: PROJECT, role: 'w1', agentType: 'claude-code-sdk', projectDir: '/tmp/liveproj', state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  } as SessionRecord;
}
const brainRecord = (): SessionRecord => session(BRAIN, { role: 'brain' });
const sonnet = (name: string, extra: Partial<SessionRecord> = {}): SessionRecord => session(name, { parentSession: BRAIN, activeModel: 'claude-sonnet-5', ...extra });

type CreateOutcome = PairSubSessionResult;

describe('the pair tools run in the daemon, and the creation path refuses to run anywhere else', () => {
  it('pair_create, pair_dispatch, pair_reassign, pair_close, pair_next_round and pair_verdict are daemon-owned tools', () => {
    for (const tool of [
      MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, MEMORY_MCP_TOOL_NAMES.PAIR_DISPATCH, MEMORY_MCP_TOOL_NAMES.PAIR_REASSIGN,
      MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE, MEMORY_MCP_TOOL_NAMES.PAIR_NEXT_ROUND, MEMORY_MCP_TOOL_NAMES.PAIR_VERDICT,
    ]) expect(MEMORY_MCP_DAEMON_TOOL_NAMES).toContain(tool);
  });

  it('a stdio MCP child hands pair_create to the daemon instead of launching a session into its own private map', async () => {
    const invokeDaemonMemoryTool = vi.fn(async () => ({ status: 'ok', ranIn: 'daemon' }));
    const handlers = createMemoryMcpToolHandlers({ ...caller, transport: 'stdio' }, { invokeDaemonMemoryTool });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({ brief: 'b' })).resolves.toMatchObject({ ranIn: 'daemon' });
    expect(invokeDaemonMemoryTool).toHaveBeenCalledWith(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: 'b' });
  });

  it('createPairSubSession launches nothing in a non-daemon process', async () => {
    const parent = brainRecord();
    const resolved = resolveCreationConfig(parent, undefined);
    if (!resolved.ok) throw new Error(resolved.error);
    const startSubSession = vi.fn();
    const result = await createPairSubSession({
      parentSessionName: BRAIN, config: resolved.config, label: 'l', idempotencyKey: 't:executor',
      metadata: { createdBy: BRAIN, pairTaskId: 't', role: 'executor', reason: TASK_PAIR_CREATED_SESSION_REASONS.DEFAULT },
    }, { nonDaemonProcess: true, getSession: () => parent, listSessions: () => [parent], startSubSession });
    expect(result).toMatchObject({ ok: false, reason: 'not_daemon_process' });
    expect(startSubSession).not.toHaveBeenCalled();
  });
});

describe('createPairSubSession: "created" means verified live and announced', () => {
  const parent = brainRecord();
  const resolved = resolveCreationConfig(parent, undefined);
  if (!resolved.ok) throw new Error(resolved.error);
  const request: PairSubSessionRequest = {
    parentSessionName: BRAIN, config: resolved.config, label: 'Pair tsk_live executor', idempotencyKey: 'tsk_live:executor',
    metadata: { createdBy: BRAIN, pairTaskId: 'tsk_live', role: 'executor', reason: TASK_PAIR_CREATED_SESSION_REASONS.DEFAULT },
  };
  function harness(overrides: Record<string, unknown> = {}) {
    const records = new Map<string, SessionRecord>([[BRAIN, parent]]);
    const events: string[] = [];
    const stopped: string[] = [];
    let clock = 1_000;
    const deps = {
      now: () => clock,
      wait: async () => { clock += 10; },
      readyTimeoutMs: 50,
      listSessions: () => [...records.values()],
      getSession: (name: string) => records.get(name),
      startSubSession: async (sub: { id: string; pairCreatedMetadata?: TaskPairCreatedSessionMetadata | null }) => {
        events.push('start');
        records.set(`deck_sub_${sub.id}`, sonnet(`deck_sub_${sub.id}`, { pairCreatedMetadata: sub.pairCreatedMetadata ?? undefined }));
      },
      stopSubSession: async (name: string) => { stopped.push(name); records.delete(name); return true; },
      hasRuntime: () => true,
      announce: async (name: string) => { events.push(`announce:${name}`); return 'announced' as const; },
      ...overrides,
    };
    return { records, events, stopped, deps };
  }

  it('success carries live:true and announced:true, and the server is told after the launch, before the call returns', async () => {
    const h = harness();
    const result = await createPairSubSession(request, h.deps);
    expect(result).toMatchObject({ ok: true, created: true, live: true, announced: true });
    expect(h.events).toEqual(['start', expect.stringMatching(/^announce:deck_sub_pair_auto_/u)]);
  });

  it('the runtime check: a transport session without a runtime in this process is not live and is removed', async () => {
    const h = harness({ hasRuntime: () => false, startSubSession: async (sub: { id: string }) => { h.records.set(`deck_sub_${sub.id}`, sonnet(`deck_sub_${sub.id}`, { runtimeType: 'transport' })); } });
    expect(await createPairSubSession(request, h.deps)).toMatchObject({ ok: false, reason: 'session_not_live' });
    expect(h.stopped).toHaveLength(1);
    expect(h.records.size).toBe(1);
  });

  it('a session removed between "ready" and the announce is reported, not announced', async () => {
    const h = harness({ announce: async () => 'announced' as const });
    let first = true;
    const original = h.deps.getSession;
    // The record is there while readiness is polled and gone when the final check looks.
    h.deps.getSession = (name: string) => {
      const record = original(name);
      if (record && name.startsWith('deck_sub_pair_auto_') && !first) return undefined;
      if (record && name.startsWith('deck_sub_pair_auto_')) first = false;
      return record;
    };
    const result = await createPairSubSession(request, h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'session_not_live' });
  });

  it('an announce that cannot describe the session removes it (announce_failed)', async () => {
    const h = harness({ announce: async () => 'failed' as const });
    expect(await createPairSubSession(request, h.deps)).toMatchObject({ ok: false, reason: 'announce_failed' });
    expect(h.stopped).toHaveLength(1);
  });

  it('no open server link: still live, announced:false (the reconnect resync tells the server)', async () => {
    const h = harness({ announce: async () => 'no_link' as const });
    expect(await createPairSubSession(request, h.deps)).toMatchObject({ ok: true, live: true, announced: false });
  });

  it('a retry with the same key reuses the session, verifies it again and announces it again (the server upsert is idempotent)', async () => {
    const h = harness();
    const first = await createPairSubSession(request, h.deps);
    const again = await createPairSubSession(request, h.deps);
    expect(first).toMatchObject({ ok: true, created: true });
    expect(again).toMatchObject({ ok: true, created: false, live: true, announced: true });
    expect(h.events.filter((event) => event === 'start')).toHaveLength(1);
    expect(h.events.filter((event) => event.startsWith('announce:'))).toHaveLength(2);
  });

  it('a retry whose session vanished does not report a stale success: it launches again', async () => {
    const h = harness();
    const first = await createPairSubSession(request, h.deps);
    if (!first.ok) throw new Error('setup');
    h.records.delete(first.target.name);
    const again = await createPairSubSession(request, h.deps);
    expect(again).toMatchObject({ ok: true, created: true, live: true });
    expect(h.events.filter((event) => event === 'start')).toHaveLength(2);
  });

  it('pairSessionNotLiveReason names the problem: missing, stopped, errored, no runtime', () => {
    expect(pairSessionNotLiveReason(undefined)).toMatch(/does not exist/u);
    expect(pairSessionNotLiveReason(sonnet('a', { state: 'stopped' }))).toMatch(/stopped/u);
    expect(pairSessionNotLiveReason(sonnet('a', { state: 'error' }))).toMatch(/error/u);
    expect(pairSessionNotLiveReason(sonnet('a', { runtimeType: 'transport' }), () => false)).toMatch(/no running runtime/u);
    expect(pairSessionNotLiveReason(sonnet('a', { runtimeType: 'transport' }), () => true)).toBeUndefined();
    expect(pairSessionNotLiveReason(sonnet('a'))).toBeUndefined();
  });
});

describe('pair_create end to end', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  let events: string[];
  let created: string[];
  let launches: number;
  let outcome: (request: PairSubSessionRequest, index: number) => CreateOutcome | undefined;
  const link = { send: vi.fn(), isConnected: () => true };

  /** A createSession that runs the REAL createPairSubSession against the real store, except for the launch itself. */
  function realCreate(overrides: Record<string, unknown> = {}) {
    return async (request: PairSubSessionRequest): Promise<CreateOutcome> => {
      launches += 1;
      const forced = outcome(request, launches);
      if (forced) return forced;
      return createPairSubSession(request, {
        readyTimeoutMs: 0,
        startSubSession: async (sub) => {
          const name = `deck_sub_${sub.id}`;
          events.push(`start:${request.metadata.role}`);
          created.push(name);
          upsertSession(sonnet(name, { pairCreatedMetadata: sub.pairCreatedMetadata ?? undefined, label: sub.label ?? undefined }));
        },
        stopSubSession: async (name) => { events.push(`discard:${name}`); removeSession(name); return true; },
        hasRuntime: () => true,
        ...overrides,
      });
    };
  }

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    events = [];
    created = [];
    launches = 0;
    outcome = () => undefined;
    link.send = vi.fn((message: { type?: string; id?: string }) => { events.push(`${message.type}:${message.id}`); });
    setActiveServerLink(link);
    setTaskPairDeliveryDepsForTests({ send: async (target) => { events.push(`brief:${target}`); } });
    upsertSession(brainRecord());
    setPairSessionCreationDepsForTests({
      createSession: realCreate(),
      stopSession: async (name) => { events.push(`discard:${name}`); removeSession(name); return true; },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setPairSessionCreationDepsForTests(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    resetActiveServerLinkForTests();
    for (const name of [BRAIN, ...created, 'deck_sub_mine', 'deck_sub_dead']) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  const handlers = () => createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => listSessions() } });
  const pairCreate = (input: Record<string, unknown>) => handlers()[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE](input);
  const pairs = () => getTaskPairStore().listActivePairs();

  it('the server hears subsession.sync for both new sessions before any brief is delivered', async () => {
    const result = await pairCreate({ brief: '# do it', title: 'Do it', idempotencyKey: 'live-1' });
    expect(result).toMatchObject({ status: 'ok' });
    const firstBrief = events.findIndex((event) => event.startsWith('brief:'));
    const syncs = events.map((event, index) => ({ event, index })).filter((entry) => entry.event.startsWith('subsession.sync:'));
    expect(syncs).toHaveLength(2);
    expect(firstBrief).toBeGreaterThan(-1);
    for (const sync of syncs) expect(sync.index).toBeLessThan(firstBrief);
    // each session was launched before it was announced
    for (const role of ['executor', 'auditor']) expect(events.indexOf(`start:${role}`)).toBeGreaterThan(-1);
    expect(events.lastIndexOf('start:auditor')).toBeLessThan(syncs[syncs.length - 1]!.index);
    expect(events.indexOf('start:executor')).toBeLessThan(syncs[0]!.index);
    const deliveries = result.deliveries as Array<{ target: string; status: string; live: boolean }>;
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((receipt) => receipt.live === true)).toBe(true);
  });

  const failures: Array<{ reason: PairSubSessionFailureReason; text: RegExp }> = [
    { reason: 'launch_failed', text: /failed to launch/u },
    { reason: 'readiness_timeout', text: /did not become ready/u },
    { reason: 'cap_reached', text: /limit of pair-created sub-sessions/u },
    { reason: 'provider_limited', text: /rate\/usage limited/u },
    { reason: 'provider_offline', text: /provider is offline/u },
    { reason: 'announce_failed', text: /server could not be told/u },
    { reason: 'session_not_live', text: /did not stay alive/u },
    { reason: 'not_daemon_process', text: /daemon process/u },
  ];
  for (const failure of failures) {
    it(`${failure.reason} on the auditor: a structured error, no pair, and the executor created a moment earlier is removed`, async () => {
      outcome = (request) => (request.metadata.role === 'auditor' ? { ok: false, reason: failure.reason, detail: 'injected' } : undefined);
      const result = await pairCreate({ brief: '# do it', idempotencyKey: `fail-${failure.reason}` });
      expect(result).toMatchObject({ status: 'error', message: expect.stringMatching(failure.text) });
      expect(String(result.message)).toContain('Nothing was created for this pair');
      expect(pairs()).toHaveLength(0);
      expect(created).toHaveLength(1);
      expect(getSession(created[0]!)).toBeUndefined();
      expect(events.filter((event) => event.startsWith('brief:'))).toHaveLength(0);
    });
  }

  it('an early error after the sessions exist (a named auditor that is stopped) removes the sessions it created', async () => {
    upsertSession(sonnet('deck_sub_dead', { state: 'stopped' }));
    const result = await pairCreate({ brief: 'b', auditor: 'deck_sub_dead', idempotencyKey: 'early-1' });
    expect(result).toMatchObject({ status: 'error' });
    expect(pairs()).toHaveLength(0);
    expect(created.length).toBeGreaterThan(0);
    for (const name of created) expect(getSession(name)).toBeUndefined();
  });

  it('a session removed after it was created and the pair persisted: the pair is cancelled, the missing session is named, no brief goes out', async () => {
    const original = taskPairService.implicitDispatch.bind(taskPairService);
    vi.spyOn(taskPairService, 'implicitDispatch').mockImplementation((...args: Parameters<typeof original>) => {
      const transition = original(...args);
      // the auditor vanishes right after the pair was persisted
      const auditor = created.find((name) => getSession(name)?.pairCreatedMetadata?.role === 'auditor');
      if (auditor) removeSession(auditor);
      return transition;
    });
    upsertSession(sonnet('deck_sub_mine'));
    const result = await pairCreate({ brief: 'b', executor: 'deck_sub_mine', idempotencyKey: 'gone-1' });
    expect(result).toMatchObject({ status: 'error', failure: 'session_not_live', nothingDispatched: true, pairCancelled: true });
    const problems = result.sessionsNotLive as Array<{ role: string; session: string }>;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ role: 'auditor', session: created[0] });
    expect(String(result.message)).toContain(created[0]);
    expect(getTaskPairStore().getPair(PROJECT, String(result.taskId))?.state.status).toBe('cancelled');
    expect(events.filter((event) => event.startsWith('brief:'))).toHaveLength(0);
    // a retry with the same key says the pair was cancelled instead of replaying a success
    const retry = await pairCreate({ brief: 'b', executor: 'deck_sub_mine', idempotencyKey: 'gone-1' });
    expect(retry).toMatchObject({ status: 'error', failure: 'pair_cancelled' });
  });

  it('a retry with the same key converges after a failed attempt: one pair, two distinct live sessions', async () => {
    outcome = (request, index) => (index === 2 && request.metadata.role === 'auditor' ? { ok: false, reason: 'launch_failed', detail: 'first attempt' } : undefined);
    const first = await pairCreate({ brief: 'b', idempotencyKey: 'retry-1' });
    expect(first).toMatchObject({ status: 'error' });
    expect(pairs()).toHaveLength(0);
    const second = await pairCreate({ brief: 'b', idempotencyKey: 'retry-1' });
    expect(second).toMatchObject({ status: 'ok' });
    expect(pairs()).toHaveLength(1);
    const pair = pairs()[0]!.state;
    expect(pair.executor).not.toBe(pair.auditor);
    expect(getSession(pair.executor!)).toBeDefined();
    expect(getSession(pair.auditor!)).toBeDefined();
  });

  it('a retry of a successful create replays it without a third session', async () => {
    const first = await pairCreate({ brief: 'b', idempotencyKey: 'replay-1' });
    const launchesAfterFirst = launches;
    const second = await pairCreate({ brief: 'b', idempotencyKey: 'replay-1' });
    expect(second).toMatchObject({ status: 'ok', idempotentReplay: true, taskId: first.taskId });
    expect(launches).toBe(launchesAfterFirst);
  });

  it('restart in between: the daemon lost the executor session; the same-key retry reports it by name instead of "ok"', async () => {
    const first = await pairCreate({ brief: 'b', idempotencyKey: 'restart-1' });
    expect(first).toMatchObject({ status: 'ok' });
    const pair = pairs()[0]!.state;
    removeSession(pair.executor!); // what a restart that did not restore the session leaves
    const retry = await pairCreate({ brief: 'b', idempotencyKey: 'restart-1' });
    expect(retry).toMatchObject({ status: 'error', failure: 'session_not_live', idempotentReplay: true });
    expect((retry.sessionsNotLive as Array<{ session: string }>).map((entry) => entry.session)).toEqual([pair.executor]);
  });

  it('pair_reassign to a session that does not exist changes nothing and names the session', async () => {
    const created1 = await pairCreate({ brief: 'b', idempotencyKey: 'reassign-1' });
    const pair = pairs()[0]!.state;
    const result = await handlers()[MEMORY_MCP_TOOL_NAMES.PAIR_REASSIGN]({ taskId: created1.taskId, executor: 'deck_sub_not_a_session' });
    expect(result).toMatchObject({ status: 'error', failure: 'session_not_live', nothingChanged: true });
    expect(String(result.message)).toContain('deck_sub_not_a_session');
    expect(getTaskPairStore().getPair(PROJECT, String(created1.taskId))?.state.executor).toBe(pair.executor);
  });
});

describe('the heartbeat reports an assigned session that is missing, by name', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  let now = 1_800_000_000_000;
  let sent: Array<{ target: string; text: string }>;
  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text) => { sent.push({ target, text }); } });
    upsertSession(brainRecord());
    upsertSession(sonnet('deck_sub_hb_exec'));
    upsertSession(sonnet('deck_sub_hb_aud'));
  });
  afterEach(() => {
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, 'deck_sub_hb_exec', 'deck_sub_hb_aud']) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('a removed executor is named to the Brain once, however many heartbeats pass, and the pair is left for the Brain to reassign or cancel', async () => {
    const automation = new TaskPairAutomation({ now: () => now, importLegacy: () => undefined, mainCheckoutRoots: () => [] });
    taskPairService.setScheduler(automation);
    const created = await createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => listSessions() } })[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
      brief: 'b', executor: 'deck_sub_hb_exec', auditor: 'deck_sub_hb_aud', idempotencyKey: 'hb-1',
    });
    expect(created).toMatchObject({ status: 'ok', state: 'working' });
    sent.length = 0;
    removeSession('deck_sub_hb_exec');

    for (let beat = 0; beat < 3; beat += 1) { now += 6 * 60_000; await automation.tick(); }
    const notices = sent.filter((entry) => entry.target === BRAIN && entry.text.includes('deck_sub_hb_exec'));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toMatch(/does not exist/u);
    expect(notices[0]!.text).toContain(String(created.taskId));
    expect(notices[0]!.text).toContain('pair_reassign');
    // nothing is nudged at the missing session
    expect(sent.filter((entry) => entry.target === 'deck_sub_hb_exec')).toHaveLength(0);
    expect(getTaskPairStore().getPair(PROJECT, String(created.taskId))?.state.status).toBe('working');
  });

  it('a pair whose sessions all exist raises no such notice (the normal-use case that must not trigger)', async () => {
    const automation = new TaskPairAutomation({ now: () => now, importLegacy: () => undefined, mainCheckoutRoots: () => [] });
    taskPairService.setScheduler(automation);
    await createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => listSessions() } })[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
      brief: 'b', executor: 'deck_sub_hb_exec', auditor: 'deck_sub_hb_aud', idempotencyKey: 'hb-2',
    });
    sent.length = 0;
    for (let beat = 0; beat < 3; beat += 1) { now += 6 * 60_000; await automation.tick(); }
    expect(sent.filter((entry) => /does not exist/u.test(entry.text))).toHaveLength(0);
  });
});
