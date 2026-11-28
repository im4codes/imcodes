import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  bindProcessSharedMachineActivity,
  bindSdkTurnOriginsAuthority,
  bindTreeTurnAuthority,
  clearAllDaemonTurnAuthoritiesOnDisconnect,
  clearProcessSharedMachineAuthoritiesForTests,
  markTreeSessionActive,
  markTreeSessionIdle,
  markTreeSessionIdleIfInactive,
  readActiveTreeAuthorityForSession,
  readProcessSharedMachineActivityEpoch,
  registerTreeSessionActivityProbe,
  releaseProcessSharedMachineAuthority,
  resolveCanonicalTurnAuthority,
  resolveDaemonRootSessionName,
  resolveSessionEffectiveSharedMachineAuthority,
  summarizeSdkTurnOrigins,
} from '../../src/daemon/shared-machine-authority-context.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import type { TransportProvider } from '../../src/agent/transport-provider.js';
import {
  AMBIGUOUS_PARTICIPANT_ACTOR,
  readSenderOwnerMachineAuthority,
  readSenderParticipantTurn,
} from '../../src/daemon/sender-participant-turn.js';
import { setActiveServerLink } from '../../src/daemon/active-server-link.js';
import { listMachines as listMachinesHttp } from '../../src/daemon/machine-exec-client.js';
import { aliasMcpList } from '../../src/daemon/alias-mcp-client.js';
import { listVerificationMachineProfiles } from '../../src/daemon/verification-machine-mcp-client.js';
import { enqueueResend, getResendEntries, clearResend, scrubResendQueueTurnAuthorities } from '../../src/daemon/transport-resend-queue.js';
import { upsertSession, removeSession, listSessions, type SessionRecord } from '../../src/store/session-store.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import {
  SHARED_MACHINE_ACTIVITY_KIND,
  SHARED_MACHINE_AUTHORITY_ACTOR_KIND,
  SHARED_MACHINE_AUTHORITY_HOOK_PATH,
} from '../../shared/shared-machine-authority.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { MEMORY_MCP_TOOL_NAMES as N } from '../../shared/memory-mcp-contracts.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import { createMemoryMcpServer, mergeDefaultToolDeps } from '../../src/daemon/memory-mcp-server.js';
import { registerMemoryMcpTools } from '../../src/daemon/memory-mcp-tools.js';
import { createDaemonMachineToolDeps } from '../../src/daemon/machine-mcp-deps.js';
import { mcpToolPayload } from '../helpers/mcp-tool-result.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function makeSession(overrides: Partial<SessionRecord> & { name: string }): SessionRecord {
  const now = Date.now();
  return {
    projectName: 'proj-default',
    projectDir: '/tmp/proj-default',
    agentType: 'claude-code',
    role: 'brain',
    state: 'idle',
    createdAt: now,
    updatedAt: now,
    sessionInstanceId: `inst-${overrides.name}`,
    runtimeEpoch: `epoch-${overrides.name}`,
    ...overrides,
  };
}

const seedSessions: string[] = [];
function seed(rec: Partial<SessionRecord> & { name: string }): SessionRecord {
  const full = makeSession(rec);
  upsertSession(full);
  if (!seedSessions.includes(full.name)) seedSessions.push(full.name);
  return full;
}

const idOf = (s: SessionRecord) => ({ sessionInstanceId: s.sessionInstanceId!, runtimeEpoch: s.runtimeEpoch! });

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('daemon unified main-tree turn authority', () => {
  let sentFrames: unknown[] = [];
  let unregisterProbe: (() => void) | undefined;

  beforeEach(() => {
    clearProcessSharedMachineAuthoritiesForTests();
    sentFrames = [];
    setActiveServerLink({
      send(msg) { sentFrames.push(msg); },
      trySend(msg) { sentFrames.push(msg); return true; },
      isConnected() { return true; },
    });
  });

  afterEach(() => {
    unregisterProbe?.();
    unregisterProbe = undefined;
    clearProcessSharedMachineAuthoritiesForTests();
    setActiveServerLink(null);
    for (const name of seedSessions.splice(0)) {
      removeSession(name);
    }
    vi.restoreAllMocks();
  });

  it('keeps tree grant alive when Brain goes idle while child/nested sub-sessions run, then revokes once whole tree idles', async () => {
    const brain = seed({ name: 'deck_tree1_brain', projectName: 'tree1', role: 'brain' });
    const exec = seed({ name: 'deck_sub_t1_exec', projectName: 'tree1', role: 'w1', parentSession: brain.name });
    const nested = seed({ name: 'deck_sub_t1_nested', projectName: 'tree1', role: 'w1', parentSession: exec.name });

    expect(resolveDaemonRootSessionName(brain.name)).toBe(brain.name);
    expect(resolveDaemonRootSessionName(exec.name)).toBe(brain.name);
    expect(resolveDaemonRootSessionName(nested.name)).toBe(brain.name);

    const token = 'trg_owner_tree1_token_1234567890';
    let t = 1_000_000;
    const bBind = bindProcessSharedMachineActivity(brain.name, idOf(brain), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER,
      authority: token,
    }, { now: t });
    bBind.typed(t);
    upsertSession({ ...exec, state: 'running' });
    markTreeSessionActive(exec.name, t);
    upsertSession({ ...nested, state: 'running' });
    markTreeSessionActive(nested.name, t);

    // Brain finishes its dispatch turn and goes idle while child sub-sessions keep executing.
    t += 5_000;
    upsertSession({ ...brain, state: 'idle' });
    releaseProcessSharedMachineAuthority(brain.name, t);
    await flushMicrotasks();

    // Grant MUST stay alive in daemon RAM and MUST NOT emit turn_authority.revoke yet!
    expect(sentFrames).toEqual([]);
    expect(readActiveTreeAuthorityForSession(exec.name)).toMatchObject({ kind: 'owner', authority: token, rootSessionName: brain.name });
    expect(readSenderOwnerMachineAuthority(exec.name)).toBe(token);
    expect(readSenderOwnerMachineAuthority(nested.name)).toBe(token);
    expect(resolveSessionEffectiveSharedMachineAuthority({
      sessionName: exec.name,
      identity: idOf(exec),
      sessionRunning: true,
      now: t,
    })).toEqual({ required: false, actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.OWNER, authority: token });
    expect(resolveSessionEffectiveSharedMachineAuthority({
      sessionName: nested.name,
      identity: idOf(nested),
      sessionRunning: true,
      now: t,
    })).toEqual({ required: false, actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.OWNER, authority: token });

    // Direct child finishes, nested grandchild still runs -> still alive!
    t += 5_000;
    upsertSession({ ...exec, state: 'idle' });
    releaseProcessSharedMachineAuthority(exec.name, t);
    await flushMicrotasks();
    expect(sentFrames).toEqual([]);
    expect(readActiveTreeAuthorityForSession(nested.name)?.authority).toBe(token);

    // Last session in tree finishes -> immediate RAM deletion + WS turn_authority.revoke with sha256(token)!
    t += 5_000;
    upsertSession({ ...nested, state: 'idle' });
    releaseProcessSharedMachineAuthority(nested.name, t);
    await flushMicrotasks();

    expect(readActiveTreeAuthorityForSession(brain.name)).toBeNull();
    expect(sentFrames).toEqual([{
      type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
      rootSessionName: brain.name,
      tokenHash: sha256(token),
    }]);
  });

  it('resolves standalone sub-sessions to themselves without bleeding into or from other trees', async () => {
    const brain = seed({ name: 'deck_proj_a_brain', projectName: 'proj-a', role: 'brain' });
    const solo = seed({ name: 'deck_sub_solo1', projectName: 'solo', role: 'w1', parentSession: undefined });

    expect(resolveDaemonRootSessionName(solo.name)).toBe(solo.name);

    const t = 2_000_000;
    bindProcessSharedMachineActivity(brain.name, idOf(brain), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER,
      authority: 'trg_proj_a_owner_token_abc123456',
    }, { now: t }).typed(t);
    bindProcessSharedMachineActivity(solo.name, idOf(solo), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'part-solo',
      authority: 'trg_solo_participant_token_xyz123',
    }, { now: t }).typed(t);

    expect(readActiveTreeAuthorityForSession(brain.name)).toMatchObject({ kind: 'owner', authority: 'trg_proj_a_owner_token_abc123456' });
    expect(readActiveTreeAuthorityForSession(solo.name)).toMatchObject({ kind: 'participant', actorUserId: 'part-solo', authority: 'trg_solo_participant_token_xyz123' });

    releaseProcessSharedMachineAuthority(solo.name, t + 5_000);
    await flushMicrotasks();
    expect(sentFrames).toEqual([{
      type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
      rootSessionName: solo.name,
      tokenHash: sha256('trg_solo_participant_token_xyz123'),
    }]);
    expect(readActiveTreeAuthorityForSession(brain.name)?.authority).toBe('trg_proj_a_owner_token_abc123456');
  });

  it('isolates 3 concurrent project trees (O, P1, P2) on the same daemon and supports O -> P1 -> P2 tree sender switch', async () => {
    const p1Brain = seed({ name: 'deck_iso1_brain', projectName: 'iso1', role: 'brain' });
    const p1Sub = seed({ name: 'deck_sub_iso1', projectName: 'iso1', role: 'w1', parentSession: p1Brain.name });
    const p2Brain = seed({ name: 'deck_iso2_brain', projectName: 'iso2', role: 'brain' });
    const p3Brain = seed({ name: 'deck_iso3_brain', projectName: 'iso3', role: 'brain' });

    const tokO = 'trg_owner_iso1_1234567890abcdef';
    const tokP1 = 'trg_part1_iso2_1234567890abcdef';
    const tokP2 = 'trg_part2_iso3_1234567890abcdef';
    let t = 3_000_000;

    bindProcessSharedMachineActivity(p1Brain.name, idOf(p1Brain), { kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER, authority: tokO }, { now: t }).typed(t);
    bindProcessSharedMachineActivity(p2Brain.name, idOf(p2Brain), { kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT, actorUserId: 'user-p1', authority: tokP1 }, { now: t }).typed(t);
    bindProcessSharedMachineActivity(p3Brain.name, idOf(p3Brain), { kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT, actorUserId: 'user-p2', authority: tokP2 }, { now: t }).typed(t);

    expect(readSenderOwnerMachineAuthority(p1Sub.name)).toBe(tokO);
    expect(readSenderParticipantTurn(p2Brain.name)).toEqual({ actorUserId: 'user-p1', authority: tokP1 });
    expect(readSenderParticipantTurn(p3Brain.name)).toEqual({ actorUserId: 'user-p2', authority: tokP2 });

    // Finish Tree 1's owner turn before P1 starts a serial turn on Tree 1 (O -> P1), while Trees 2 & 3 stay isolated.
    t += 5_000;
    releaseProcessSharedMachineAuthority(p1Brain.name, t);
    await flushMicrotasks();
    expect(sentFrames.pop()).toEqual({
      type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
      rootSessionName: p1Brain.name,
      tokenHash: sha256(tokO),
    });

    // Participant P1 sends a message into Tree 1's sub-session (O -> P1): Tree 1 switches to P1 while Trees 2 & 3 stay untouched.
    const tokP1Tree1 = 'trg_part1_switch_tree1_abcdef12';
    t += 5_000;
    bindProcessSharedMachineActivity(p1Sub.name, idOf(p1Sub), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p1',
      authority: tokP1Tree1,
    }, { now: t }).typed(t);
    expect(readSenderParticipantTurn(p1Brain.name)).toEqual({ actorUserId: 'user-p1', authority: tokP1Tree1 });
    expect(readSenderOwnerMachineAuthority(p1Brain.name)).toBeNull();
    expect(readSenderParticipantTurn(p3Brain.name)).toEqual({ actorUserId: 'user-p2', authority: tokP2 });

    // Finish Tree 1's P1 sub-session turn before P2 starts on Tree 1 (P1 -> P2).
    t += 5_000;
    releaseProcessSharedMachineAuthority(p1Sub.name, t);
    await flushMicrotasks();
    expect(sentFrames.pop()).toEqual({
      type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
      rootSessionName: p1Brain.name,
      tokenHash: sha256(tokP1Tree1),
    });

    // Participant P2 sends into Tree 1 main session (P1 -> P2): Tree 1 cleanly binds P2!
    const tokP2Tree1 = 'trg_part2_switch_tree1_abcdef12';
    t += 5_000;
    bindProcessSharedMachineActivity(p1Brain.name, idOf(p1Brain), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p2',
      authority: tokP2Tree1,
    }, { now: t }).typed(t);
    expect(readSenderParticipantTurn(p1Sub.name)).toEqual({ actorUserId: 'user-p2', authority: tokP2Tree1 });

    // Finishing Tree 2 revokes ONLY Tree 2!
    releaseProcessSharedMachineAuthority(p2Brain.name, t + 5_000);
    await flushMicrotasks();
    expect(sentFrames).toEqual([{
      type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
      rootSessionName: p2Brain.name,
      tokenHash: sha256(tokP1),
    }]);
    expect(readActiveTreeAuthorityForSession(p1Brain.name)?.authority).toBe(tokP2Tree1);
    expect(readActiveTreeAuthorityForSession(p3Brain.name)?.authority).toBe(tokP2);
  });

  it('fails closed when P1 and P2 interleave in the same active process or transport session turn', async () => {
    const sess = seed({ name: 'deck_interleave_brain', projectName: 'interleave', role: 'brain', state: 'running' });
    const t = Date.now();

    // 1. Process session: P1 active, then P2 interleaves into the same turn
    bindProcessSharedMachineActivity(sess.name, idOf(sess), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p1',
      authority: 'trg_p1_turn_1111111111111111',
    }, { now: t }).typed(t);
    bindProcessSharedMachineActivity(sess.name, idOf(sess), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p2',
      authority: 'trg_p2_turn_2222222222222222',
    }, { now: t + 100 }).typed(t + 100);

    expect(resolveSessionEffectiveSharedMachineAuthority({
      sessionName: sess.name,
      identity: idOf(sess),
      sessionRunning: true,
      now: t + 200,
    })).toEqual({ required: true, authority: null });
    expect(readSenderParticipantTurn(sess.name)).toEqual({
      actorUserId: AMBIGUOUS_PARTICIPANT_ACTOR,
      authority: null,
    });
    expect(readSenderOwnerMachineAuthority(sess.name)).toBeNull();

    // 2. Transport runtime: active turn has P1 and P2 entries -> fails closed even if a tree grant exists!
    clearProcessSharedMachineAuthoritiesForTests();
    const mixedTransportRuntime = {
      requiresSharedMachineAuthority: () => true,
      getActiveSharedMachineAuthority: () => null,
      getActiveOwnerMachineAuthority: () => null,
    };
    expect(resolveSessionEffectiveSharedMachineAuthority({
      sessionName: sess.name,
      identity: idOf(sess),
      sessionRunning: true,
      now: t + 300,
      runtime: mixedTransportRuntime,
    })).toEqual({ required: true, authority: null });
  });

  it('retains tree grant while registered activity probe reports transport/task-pair child active', async () => {
    const brain = seed({ name: 'deck_probe_brain', projectName: 'probe', role: 'brain' });
    const exec = seed({ name: 'deck_sub_probe_exec', projectName: 'probe', role: 'w1', parentSession: brain.name });
    let execTransportBusy = true;
    unregisterProbe = registerTreeSessionActivityProbe((name) => name === exec.name && execTransportBusy);

    const token = 'trg_probe_keepalive_1234567890';
    const t = 5_000_000;
    bindProcessSharedMachineActivity(brain.name, idOf(brain), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER,
      authority: token,
    }, { now: t }).typed(t);

    // Brain finishes; exec is reported busy via probe -> MUST stay alive
    releaseProcessSharedMachineAuthority(brain.name, t + 5_000);
    await flushMicrotasks();
    expect(sentFrames).toEqual([]);
    expect(readActiveTreeAuthorityForSession(exec.name)?.authority).toBe(token);

    // Probe clears and exec finishes -> revokes immediately
    execTransportBusy = false;
    markTreeSessionIdle(exec.name, t + 10_000);
    await flushMicrotasks();
    expect(sentFrames).toEqual([{
      type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
      rootSessionName: brain.name,
      tokenHash: sha256(token),
    }]);
  });

  it('allows local computer_use for opaque trg_ owner hook reply while blocking participant trg_ hook reply', async () => {
    const home = process.env.IMCODES_HOME!;
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'server.json'), JSON.stringify({ workerUrl: 'http://127.0.0.1:1', serverId: 'full-src', token: 'tok' }));

    let hookPayload: Record<string, unknown> = {
      ok: true,
      required: false,
      actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.OWNER,
      authority: 'trg_opaque_owner_token_123456',
    };
    const hook = createServer((req, res) => {
      expect(req.url).toBe(SHARED_MACHINE_AUTHORITY_HOOK_PATH);
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(hookPayload));
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    const port = (hook.address() as { port: number }).port;
    const localCall = vi.fn(async () => ({ outcome: 'completed' as const, result: { ok: true } as never }));
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ machines: [] }), { headers: { 'content-type': 'application/json' } }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub as unknown as typeof fetch;

    const caller: McpRuntimeCaller = {
      userId: 'owner',
      namespace: { scope: 'user_private', userId: 'owner', projectId: 'fixture' },
      sessionName: 'deck_sub_child',
      projectName: 'fixture',
      transport: 'in_process',
    };
    const merged = mergeDefaultToolDeps(
      caller,
      {},
      { sessionName: caller.sessionName!, sessionInstanceId: 'inst', runtimeEpoch: 'ep' },
      { resolveHookAuthority: async () => ({ ok: true, port } as never) },
    );
    const deps = createDaemonMachineToolDeps({
      ...merged,
      loadCredential: async () => ({ serverUrl: 'http://127.0.0.1:1', serverId: 'full-src', token: 'tok' }),
      loadSharedMachineAuthority: merged.machineDeps!.execRemote ? async () => String(hookPayload.authority ?? '') : undefined,
      participantTurnRequired: merged.participantTurnRequired,
      isOwnerTurnAuthority: async () => hookPayload.required === false && hookPayload.actorKind === SHARED_MACHINE_AUTHORITY_ACTOR_KIND.OWNER,
      localComputerUseCall: localCall as never,
    });
    const mcp = createMemoryMcpServer(caller, merged);
    const localMcp = new (await import('@modelcontextprotocol/sdk/server/mcp.js')).McpServer({ name: 'opaque-test', version: '1.0.0' });
    registerMemoryMcpTools(localMcp, caller, { machineDeps: deps, nodeRole: 'full' });
    const client = new Client({ name: 'opaque-cu', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([localMcp.connect(b), client.connect(a)]);
    try {
      await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: N.COMPUTER_USE_CALL } });
      await client.listTools();
      // Owner opaque trg_ token uses local computer use cleanly
      const ownerRes = await client.callTool({ name: N.COMPUTER_USE_CALL, arguments: { machine: 'local', tool: 'list_apps' } });
      expect(ownerRes.isError).not.toBe(true);
      expect(localCall).toHaveBeenCalledTimes(1);

      // Participant opaque trg_ token MUST NEVER touch owner's local computer use
      hookPayload = { ok: true, required: true, authority: 'trg_opaque_part_token_123456' };
      const partRes = await client.callTool({ name: N.COMPUTER_USE_CALL, arguments: { machine: 'local', tool: 'list_apps' } });
      expect(localCall).toHaveBeenCalledTimes(1);
      expect(mcpToolPayload(partRes)).toMatchObject({ reason: MCP_ERROR_REASONS.MACHINE_NOT_FOUND });
    } finally {
      globalThis.fetch = originalFetch;
      await client.close();
      await localMcp.close();
      await mcp.close();
      await new Promise<void>((resolve, reject) => hook.close((err) => err ? reject(err) : resolve()));
    }
  });

  it('P0 #1: poisons tree fail-closed when main (P2) and sub (P1) are simultaneously active, and rejects local/tree/generation mismatch across all canonical readers', async () => {
    const main = seed({ name: 'deck_mix_main', projectName: 'mix', role: 'brain', state: 'running' });
    const sub = seed({ name: 'deck_sub_mix', projectName: 'mix', role: 'w1', parentSession: main.name, state: 'running' });
    const tokP2 = 'trg_p2_concurrent_11111111111111';
    const tokP1 = 'trg_p1_concurrent_22222222222222';
    const t = Date.now();

    const genMain = bindTreeTurnAuthority(main.name, {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p2',
      authority: tokP2,
    }, { now: t });
    // Simultaneously (before main goes idle), child admits a DIFFERENT actor P1 in the same tree!
    const genSub = bindTreeTurnAuthority(sub.name, {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p1',
      authority: tokP1,
    }, { now: t + 50 });

    expect(genSub).toBeGreaterThan(genMain);
    // Both prior P2 token and new conflicting P1 token are revoked immediately, and tree stays mixed fail-closed
    expect(sentFrames).toContainEqual({
      type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
      rootSessionName: main.name,
      tokenHash: sha256(tokP2),
    });
    expect(sentFrames).toContainEqual({
      type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
      rootSessionName: main.name,
      tokenHash: sha256(tokP1),
    });
    expect(readActiveTreeAuthorityForSession(main.name)).toMatchObject({ kind: 'mixed', authority: null });

    // Local runtime claiming P1 with an old/mismatched treeGeneration MUST NOT borrow any token
    const p1Runtime = {
      sending: true,
      activeDispatchEntries: [{ sharedActor: { effectiveActorRole: 'participant', actorUserId: 'user-p1' }, sharedMachineAuthority: tokP1 }],
      requiresSharedMachineAuthority: () => true,
      getActiveSharedMachineAuthority: () => tokP1,
      getActiveOwnerMachineAuthority: () => null,
      activeTurnParticipantUserIds: () => ['user-p1'],
      getActiveTreeGeneration: () => genMain,
    };
    expect(resolveSessionEffectiveSharedMachineAuthority({
      sessionName: sub.name,
      identity: idOf(sub),
      sessionRunning: true,
      now: t + 100,
      runtime: p1Runtime,
    })).toEqual({ required: true, authority: null });

    // Even if a test tree holds P2 directly, a runtime claiming local P1 cannot combine P1 actorUserId with P2 authority!
    clearProcessSharedMachineAuthoritiesForTests();
    const genTreeP2 = bindTreeTurnAuthority(main.name, {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p2',
      authority: tokP2,
    }, { now: t + 200 });
    expect(resolveCanonicalTurnAuthority({
      sessionName: sub.name,
      identity: idOf(sub),
      sessionRunning: true,
      now: t + 201,
      runtime: { ...p1Runtime, getActiveTreeGeneration: () => genTreeP2 },
    })).toMatchObject({ required: true, isParticipantScoped: true, actorUserId: AMBIGUOUS_PARTICIPANT_ACTOR, authority: null });

    // Local owner turn when tree holds participant ALSO fails closed (never borrows participant or leaks owner)
    expect(resolveCanonicalTurnAuthority({
      sessionName: sub.name,
      identity: idOf(sub),
      sessionRunning: true,
      now: t + 202,
      runtime: {
        sending: true,
        activeDispatchEntries: [{}],
        requiresSharedMachineAuthority: () => false,
        getActiveSharedMachineAuthority: () => null,
        getActiveOwnerMachineAuthority: () => null,
      },
    })).toMatchObject({ required: true, isParticipantScoped: true, authority: null });
  });

  it('P0 #2: allows same sender (O or P1) follow-up turns across active tree sessions without mixed conflict and blocks stale token regression', async () => {
    const main = seed({ name: 'deck_same_main', projectName: 'same', role: 'brain', state: 'running' });
    const sub = seed({ name: 'deck_sub_same', projectName: 'same', role: 'w1', parentSession: main.name, state: 'running' });
    const t = Date.now();

    // 1. Participant P1 active on main (`tokP1A`), then SAME P1 starts a follow-up turn on child (`tokP1B`).
    const tokP1A = 'trg_same_p1_turn_aaaaaaaaaaaa1111';
    const tokP1B = 'trg_same_p1_turn_bbbbbbbbbbbb2222';
    const genA = bindTreeTurnAuthority(main.name, {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p1',
      authority: tokP1A,
    }, { now: t });
    const genB = bindTreeTurnAuthority(sub.name, {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p1',
      authority: tokP1B,
    }, { now: t + 50 });

    expect(genB).toBeGreaterThan(genA);
    expect(readActiveTreeAuthorityForSession(main.name)).toMatchObject({
      kind: 'participant',
      actorUserId: 'user-p1',
      authority: tokP1B,
    });
    // Earlier-started main (`genA`, `tokP1A`) & child (`genB`, `tokP1B`) BOTH inherit live `tokP1B`!
    const p1OldRuntime = {
      sending: true,
      activeDispatchEntries: [{ sharedActor: { effectiveActorRole: 'participant', actorUserId: 'user-p1' }, sharedMachineAuthority: tokP1A }],
      requiresSharedMachineAuthority: () => true,
      getActiveSharedMachineAuthority: () => tokP1A,
      getActiveOwnerMachineAuthority: () => null,
      activeTurnParticipantUserIds: () => ['user-p1'],
      getActiveTreeGeneration: () => genA,
    };
    expect(resolveSessionEffectiveSharedMachineAuthority({
      sessionName: main.name,
      identity: idOf(main),
      sessionRunning: true,
      now: t + 60,
      runtime: p1OldRuntime,
    })).toEqual({
      required: true,
      actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.PARTICIPANT,
      authority: tokP1B,
    });
    expect(readSenderParticipantTurn(sub.name)).toEqual({ actorUserId: 'user-p1', authority: tokP1B });

    // Stale callback attempting to re-bind superseded `tokP1A` CANNOT regress `tokP1B`!
    const genStale = bindTreeTurnAuthority(main.name, {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p1',
      authority: tokP1A,
    }, { now: t + 70 });
    expect(genStale).toBe(genB);
    expect(readActiveTreeAuthorityForSession(main.name)?.authority).toBe(tokP1B);

    // Clear tree and test Owner O: child running on `tokO1`, SAME O starts new turn on main with `tokO2`.
    markTreeSessionIdle(main.name, t + 80);
    markTreeSessionIdle(sub.name, t + 80);
    await flushMicrotasks();
    sentFrames.length = 0;

    const tokO1 = 'trg_same_owner_11111111111111111';
    const tokO2 = 'trg_same_owner_22222222222222222';
    const genO1 = bindTreeTurnAuthority(sub.name, {
      kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER,
      authority: tokO1,
    }, { now: t + 100 });
    const genO2 = bindTreeTurnAuthority(main.name, {
      kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER,
      authority: tokO2,
    }, { now: t + 150 });
    expect(genO2).toBeGreaterThan(genO1);

    const ownerOldChildRuntime = {
      sending: true,
      activeDispatchEntries: [{}],
      requiresSharedMachineAuthority: () => false,
      getActiveSharedMachineAuthority: () => null,
      getActiveOwnerMachineAuthority: () => tokO1,
      getActiveTreeGeneration: () => genO1,
    };
    expect(resolveSessionEffectiveSharedMachineAuthority({
      sessionName: sub.name,
      identity: idOf(sub),
      sessionRunning: true,
      now: t + 160,
      runtime: ownerOldChildRuntime,
    })).toEqual({
      required: false,
      actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.OWNER,
      authority: tokO2,
    });
  });

  it('P0 #3: revokes fast turns immediately via matching activityEpoch, drops stale idle epochs, and settles stop/error windows', async () => {
    const fastSess = seed({ name: 'deck_fast_brain', projectName: 'fast', role: 'brain', state: 'running' });
    const tokFast = 'trg_fast_short_turn_111111111111';
    let linkGen = 1;
    let linkOpen = true;
    setActiveServerLink({
      send: (msg) => { sentFrames.push(msg as Record<string, unknown>); },
      trySend: (msg) => {
        if (!linkOpen) return false;
        sentFrames.push(msg as Record<string, unknown>);
        return true;
      },
      isConnected: () => linkOpen,
      getConnectionGeneration: () => linkGen,
    });

    const t0 = Date.now();
    bindProcessSharedMachineActivity(fastSess.name, idOf(fastSess), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER,
      authority: tokFast,
    }, { now: t0 }).typed(t0);
    const epoch1 = readProcessSharedMachineActivityEpoch(fastSess.name)!;
    expect(typeof epoch1).toBe('number');

    // Turn finishes in 300ms (< 1500ms) with matching activityEpoch -> revokes IMMEDIATELY (0ms wait)!
    upsertSession({ ...fastSess, state: 'idle' });
    releaseProcessSharedMachineAuthority(fastSess.name, { now: t0 + 300, expectedActivityEpoch: epoch1 });
    await flushMicrotasks();
    expect(sentFrames).toEqual([{
      type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
      rootSessionName: fastSess.name,
      tokenHash: sha256(tokFast),
    }]);

    // Stale idle carrying old epoch1 after turn 2 bound (epoch2) MUST NOT revoke turn 2!
    sentFrames.length = 0;
    const tokTurn2 = 'trg_turn2_keep_alive_2222222222';
    upsertSession({ ...fastSess, state: 'running' });
    bindProcessSharedMachineActivity(fastSess.name, idOf(fastSess), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER,
      authority: tokTurn2,
    }, { now: t0 + 400 }).typed(t0 + 400);
    const epoch2 = readProcessSharedMachineActivityEpoch(fastSess.name)!;
    expect(epoch2).toBeGreaterThan(epoch1);

    releaseProcessSharedMachineAuthority(fastSess.name, { now: t0 + 450, expectedActivityEpoch: epoch1 });
    await flushMicrotasks();
    expect(sentFrames).toEqual([]);
    expect(readActiveTreeAuthorityForSession(fastSess.name)?.authority).toBe(tokTurn2);

    // Stop / error path uses `forceSettle: true`: clears window (`turns > 0`) AND revokes tree authority immediately!
    upsertSession({ ...fastSess, state: 'stopped' });
    releaseProcessSharedMachineAuthority(fastSess.name, { forceSettle: true });
    await flushMicrotasks();
    expect(sentFrames).toEqual([{
      type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
      rootSessionName: fastSess.name,
      tokenHash: sha256(tokTurn2),
    }]);
    expect(readActiveTreeAuthorityForSession(fastSess.name)).toBeNull();

    // Errored runtime + failed task-pair dispatch (`markTreeSessionIdleIfInactive`) both revoke cleanly
    sentFrames.length = 0;
    const errTok = 'trg_error_turn_22222222222222222';
    const errSub = seed({ name: 'deck_sub_err', projectName: 'fast', role: 'w1', parentSession: fastSess.name });
    let probeBusy = false;
    unregisterProbe = registerTreeSessionActivityProbe((name) => name === errSub.name && probeBusy);
    bindTreeTurnAuthority(fastSess.name, { kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER, authority: errTok }, { now: Date.now() });
    markTreeSessionActive(errSub.name);
    markTreeSessionIdleIfInactive(errSub.name);
    markTreeSessionIdle(fastSess.name);
    await flushMicrotasks();
    expect(sentFrames).toEqual([{
      type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
      rootSessionName: fastSess.name,
      tokenHash: sha256(errTok),
    }]);

    // Disconnect scrubs treeAuthorities, windows, and resend RAM tokens + fences old link generation
    sentFrames.length = 0;
    const partSess = seed({ name: 'deck_dc_part', projectName: 'dc', role: 'brain', state: 'running' });
    const tokDcPart = 'trg_dc_participant_333333333333';
    bindProcessSharedMachineActivity(partSess.name, idOf(partSess), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p1',
      authority: tokDcPart,
    }, { now: Date.now(), sessionRunning: true }).typed(Date.now());
    clearResend(partSess.name);
    enqueueResend(partSess.name, {
      commandId: 'cmd-dc-1',
      text: 'hello',
      queuedAt: Date.now(),
      sharedActor: { actorUserId: 'user-p1', actorDisplayName: 'P1', effectiveActorRole: 'participant', actionId: 'a1', origin: 'shared-tab', authorizedAt: 1, primaryShareId: null, snapshot: { target: { kind: 'main', serverId: 's1', sessionName: partSess.name }, effectiveRole: 'participant', historyCutoffAt: 0, coveringShareIds: [], authorizedAt: 1, nextCoverageRecheckAt: null } },
      sharedMachineAuthority: tokDcPart,
    }, true);

    linkOpen = false;
    clearAllDaemonTurnAuthoritiesOnDisconnect({ scrubResendQueues: scrubResendQueueTurnAuthorities });

    // Active participant remains fail-closed (required: true, authority: null) with zero RAM tokens anywhere!
    expect(readSenderParticipantTurn(partSess.name)).toEqual({ actorUserId: 'user-p1', authority: null });
    expect(getResendEntries(partSess.name)[0]?.sharedMachineAuthority).toBeUndefined();
    expect(getResendEntries(partSess.name)[0]?.sharedActor?.actorUserId).toBe('user-p1');
    clearResend(partSess.name);

    // Reconnecting at generation 2 must ignore late idle revoke from generation 1 tree entry
    linkGen = 2;
    linkOpen = true;
    const gen1Tok = 'trg_gen1_old_44444444444444444444';
    const genSess = seed({ name: 'deck_gen_fence', projectName: 'gf', role: 'brain' });
    linkGen = 1;
    bindTreeTurnAuthority(genSess.name, { kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER, authority: gen1Tok }, { now: Date.now() });
    linkGen = 2;
    markTreeSessionIdle(genSess.name);
    await flushMicrotasks();
    expect(sentFrames).toEqual([]);
  });

  it('P0 #4: source daemon HTTP clients always include ?serverId= for ingress sticky pod routing', async () => {
    const urls: string[] = [];
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (String(input).includes('/api/machines')) {
        return new Response(JSON.stringify({ machines: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (String(input).includes('/api/verification-machines')) {
        return new Response(JSON.stringify({ profiles: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ aliases: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await listMachinesHttp({
      serverUrl: 'https://im.example.test',
      sourceServerId: 'srv-src-sticky',
      sourceToken: 'secret',
      fetchImpl: fetchStub as unknown as typeof fetch,
    });
    await listVerificationMachineProfiles('proj-1', {
      endpoint: { workerUrl: 'https://im.example.test', serverId: 'srv-src-sticky', token: 'secret' },
      fetchImpl: fetchStub as unknown as typeof fetch,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub as unknown as typeof fetch;
    try {
      await aliasMcpList({ endpoint: { workerUrl: 'https://im.example.test', serverId: 'srv-src-sticky', token: 'secret' } });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(urls[0]).toBe('https://im.example.test/api/machines?serverId=srv-src-sticky');
    expect(urls[1]).toBe('https://im.example.test/api/verification-machines?projectKey=proj-1&serverId=srv-src-sticky');
    expect(urls[2]).toContain('https://im.example.test/api/aliases?');
    expect(urls[2]).toContain('serverId=srv-src-sticky');
  });

  it('Round 3 P0 #1: SDK queue-coalesce and active-turn append keep same-sender tokens non-mixed and advance to latest grant while failing closed on P1/P2 or O/P1 mix', async () => {
    const p1Actor = (userId: string, sessionName: string) => ({
      actorUserId: userId,
      actorDisplayName: userId,
      effectiveActorRole: 'participant' as const,
      actionId: `act-${userId}`,
      origin: 'shared-tab' as const,
      authorizedAt: Date.now(),
      primaryShareId: null,
      snapshot: {
        target: { kind: 'main' as const, serverId: 'srv-1', sessionName },
        effectiveRole: 'participant' as const,
        historyCutoffAt: 0,
        coveringShareIds: [],
        authorizedAt: Date.now(),
        nextCoverageRecheckAt: null,
      },
    });

    const makeSdkHarness = (sess: SessionRecord) => {
      let sendGateResolve: (() => void) | null = null;
      let completeHandler: ((sid: string, msg: any) => void) | undefined;
      let statusHandler: ((sid: string, status: any) => void) | undefined;
      let appendHandler: ((sid: string, payload: any) => Promise<'delivered' | 'stale' | 'unsupported'>) | undefined;
      const provider: TransportProvider = {
        id: 'codex-sdk',
        connectionMode: 'persistent',
        sessionOwnership: 'provider',
        capabilities: {
          streaming: true,
          toolCalling: false,
          approval: false,
          sessionRestore: false,
          multiTurn: true,
          attachments: false,
          contextSupport: 'full-normalized-context-injection',
          activeDelegationNotification: 'native',
        },
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        createSession: vi.fn().mockResolvedValue(`prov-${sess.name}`),
        endSession: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockImplementation(
          () => new Promise<void>((resolve) => {
            sendGateResolve = resolve;
          }),
        ),
        notifyActiveDelegation: vi.fn().mockImplementation(async (sid, payload) => {
          if (appendHandler) return appendHandler(sid, payload);
          return 'delivered';
        }),
        cancel: vi.fn().mockResolvedValue(undefined),
        onDelta: () => () => undefined,
        onComplete: (cb) => { completeHandler = cb; return () => undefined; },
        onError: () => () => undefined,
        onApprovalRequest: () => undefined,
        onStatus: (cb) => { statusHandler = cb; return () => undefined; },
        onUsage: () => () => undefined,
        onToolCall: () => () => undefined,
        respondApproval: vi.fn().mockResolvedValue(undefined),
      };
      const runtime = new TransportSessionRuntime(provider, sess.name);
      runtime.onTurnAdmitted = (origins) => bindSdkTurnOriginsAuthority(sess.name, origins);
      return {
        provider,
        runtime,
        setAppendHandler: (fn: typeof appendHandler) => { appendHandler = fn; },
        finishSend: () => {
          const resolve = sendGateResolve;
          sendGateResolve = null;
          resolve?.();
          completeHandler?.(`prov-${sess.name}`, { id: 'm1', role: 'assistant', content: 'ok', status: 'complete', timestamp: Date.now() });
          statusHandler?.(`prov-${sess.name}`, 'idle');
        },
      };
    };

    // 1. Queue-coalesce (`_drainPending`) merges two admitted messages from SAME P1 with distinct tokens
    const sessMain = seed({ name: 'deck_sdk_r3_brain', projectName: 'sdk-r3', role: 'brain', runtimeType: 'transport', agentType: 'codex-sdk', state: 'running' });
    const h = makeSdkHarness(sessMain);
    await h.runtime.initialize({ sessionName: sessMain.name, projectName: sessMain.projectName, cwd: sessMain.projectDir });

    const tokP1_1 = 'trg_sdk_p1_coalesce_111111111111';
    const tokP1_2 = 'trg_sdk_p1_coalesce_222222222222';
    const tokP1_3 = 'trg_sdk_p1_append_33333333333333';

    // Enqueue both via `send()` while runtime is busy so `_drainPending` coalesces both into one dispatched turn
    (h.runtime as any)._sending = true;
    expect(h.runtime.send('msg 1 from P1', 'cm-1', undefined, undefined, {
      sharedActor: p1Actor('user-p1', sessMain.name),
      sharedMachineAuthority: tokP1_1,
    })).toBe('queued');
    expect(h.runtime.send('msg 2 from P1', 'cm-2', undefined, undefined, {
      sharedActor: p1Actor('user-p1', sessMain.name),
      sharedMachineAuthority: tokP1_2,
    })).toBe('queued');
    (h.runtime as any)._sending = false;
    expect((h.runtime as any)._drainPending()).toBe(true);

    // Coalesced origins `[tokP1_1, tokP1_2]` from same P1 MUST resolve to latest `tokP1_2` (NOT mixed!)
    expect(h.runtime.getActiveSharedMachineAuthority()).toBe(tokP1_2);
    expect(readActiveTreeAuthorityForSession(sessMain.name)?.authority).toBe(tokP1_2);
    expect(resolveSessionEffectiveSharedMachineAuthority({
      sessionName: sessMain.name,
      identity: idOf(sessMain),
      sessionRunning: true,
      now: Date.now(),
      runtime: h.runtime,
    })).toEqual({
      required: true,
      actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.PARTICIPANT,
      authority: tokP1_2,
    });

    // Late bind with superseded `tokP1_1` must NOT regress `tokP1_2`
    bindTreeTurnAuthority(sessMain.name, {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p1',
      authority: tokP1_1,
    });
    expect(readActiveTreeAuthorityForSession(sessMain.name)?.authority).toBe(tokP1_2);

    // 2. Active-turn append from SAME P1 with `tokP1_3` advances both runtime & tree to `tokP1_3` without mixed
    expect(h.runtime.send('msg 3 append from P1', 'cm-3', undefined, undefined, {
      sharedActor: p1Actor('user-p1', sessMain.name),
      sharedMachineAuthority: tokP1_3,
    })).toBe('queued');
    const appendRes = await h.runtime.appendPendingMessagesToActiveTurn(['cm-3'], 'notif-3');
    expect(appendRes.status).toBe('delivered');
    expect(h.runtime.getActiveSharedMachineAuthority()).toBe(tokP1_3);
    expect(readActiveTreeAuthorityForSession(sessMain.name)?.authority).toBe(tokP1_3);
    expect(resolveSessionEffectiveSharedMachineAuthority({
      sessionName: sessMain.name,
      identity: idOf(sessMain),
      sessionRunning: true,
      now: Date.now(),
      runtime: h.runtime,
    })).toEqual({
      required: true,
      actorKind: SHARED_MACHINE_AUTHORITY_ACTOR_KIND.PARTICIPANT,
      authority: tokP1_3,
    });

    // 3. Contrast: P2 appends into P1's active SDK turn -> immediately mixed fail-closed AND revokes BOTH P1 (`tokP1_3`) AND P2 (`tokP2_conf`)
    sentFrames.length = 0;
    const tokP2_conf = 'trg_sdk_p2_conflict_444444444444';
    expect(h.runtime.send('msg 4 conflict from P2', 'cm-4', undefined, undefined, {
      sharedActor: p1Actor('user-p2', sessMain.name),
      sharedMachineAuthority: tokP2_conf,
    })).toBe('queued');
    const appendP2 = await h.runtime.appendPendingMessagesToActiveTurn(['cm-4'], 'notif-4');
    expect(appendP2.status).toBe('delivered');
    expect(h.runtime.getActiveSharedMachineAuthority()).toBeNull();
    expect(h.runtime.requiresSharedMachineAuthority()).toBe(true);
    expect(readActiveTreeAuthorityForSession(sessMain.name)).toMatchObject({ kind: 'mixed', authority: null });
    expect(resolveSessionEffectiveSharedMachineAuthority({
      sessionName: sessMain.name,
      identity: idOf(sessMain),
      sessionRunning: true,
      now: Date.now(),
      runtime: h.runtime,
    })).toEqual({ required: true, authority: null });
    expect(sentFrames).toEqual(expect.arrayContaining([
      { type: DAEMON_MSG.TURN_AUTHORITY_REVOKE, rootSessionName: sessMain.name, tokenHash: sha256(tokP1_3) },
      { type: DAEMON_MSG.TURN_AUTHORITY_REVOKE, rootSessionName: sessMain.name, tokenHash: sha256(tokP2_conf) },
    ]));

    h.finishSend();
    await h.runtime.kill();
    await flushMicrotasks();

    // 4. Same Owner O coalesced tokens advance cleanly; O + P1 conflict fails closed and revokes BOTH tokens
    sentFrames.length = 0;
    const ownerSummary = summarizeSdkTurnOrigins([
      { ownerMachineAuthority: 'trg_o_1' },
      { ownerMachineAuthority: 'trg_o_2' },
    ]);
    expect(ownerSummary).toEqual({
      state: 'owner',
      actorUserId: null,
      authority: 'trg_o_2',
      revokeTokenHashes: [sha256('trg_o_1')],
    });
    const mixedSummary = summarizeSdkTurnOrigins([
      { ownerMachineAuthority: 'trg_o_conflict' },
      { sharedActor: p1Actor('user-p1', sessMain.name), sharedMachineAuthority: 'trg_p1_conflict' },
    ]);
    expect(mixedSummary).toEqual({
      state: 'mixed',
      actorUserId: 'user-p1',
      authority: null,
      revokeTokenHashes: [sha256('trg_o_conflict'), sha256('trg_p1_conflict')],
    });
  });

  it('Round 3 P0 #2: process conflict (`P1->P2`, `O->P1`, `P1->O`) revokes both old and newly minted hashes, preserves offline retry, and fences linkGeneration', async () => {
    let linkGen = 10;
    let trySendOk = true;
    setActiveServerLink({
      send: (msg) => { sentFrames.push(msg as Record<string, unknown>); },
      trySend: (msg) => {
        if (!trySendOk) return false;
        sentFrames.push(msg as Record<string, unknown>);
        return true;
      },
      isConnected: () => true,
      getConnectionGeneration: () => linkGen,
    });

    // Case A: P1(tok1) -> P2(tok2) in SAME active process window -> revokes BOTH tok1 AND tok2 immediately
    const procA = seed({ name: 'deck_proc_c1_brain', projectName: 'proc-c1', role: 'brain', state: 'running' });
    const tokP1 = 'trg_proc_p1_old_1111111111111111';
    const tokP2 = 'trg_proc_p2_new_2222222222222222';
    const b1 = bindProcessSharedMachineActivity(procA.name, idOf(procA), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p1',
      authority: tokP1,
    }, { now: Date.now(), sessionRunning: true });
    b1.typed(Date.now());
    sentFrames.length = 0;

    const b2 = bindProcessSharedMachineActivity(procA.name, idOf(procA), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p2',
      authority: tokP2,
    }, { now: Date.now() + 10, sessionRunning: true });
    b2.typed(Date.now() + 10);

    expect(readActiveTreeAuthorityForSession(procA.name)).toMatchObject({ kind: 'mixed', authority: null });
    expect(resolveSessionEffectiveSharedMachineAuthority({
      sessionName: procA.name,
      identity: idOf(procA),
      sessionRunning: true,
      now: Date.now() + 20,
    })).toEqual({ required: true, authority: null });
    expect(sentFrames).toEqual(expect.arrayContaining([
      { type: DAEMON_MSG.TURN_AUTHORITY_REVOKE, rootSessionName: procA.name, tokenHash: sha256(tokP1) },
      { type: DAEMON_MSG.TURN_AUTHORITY_REVOKE, rootSessionName: procA.name, tokenHash: sha256(tokP2) },
    ]));

    // Case B: O(tokO) -> P1(tokP1b) -> revokes BOTH tokO and tokP1b immediately
    const procB = seed({ name: 'deck_proc_c2_brain', projectName: 'proc-c2', role: 'brain', state: 'running' });
    const tokO = 'trg_proc_o_old_33333333333333333';
    const tokP1b = 'trg_proc_p1_new_4444444444444444';
    bindProcessSharedMachineActivity(procB.name, idOf(procB), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER,
      authority: tokO,
    }, { now: Date.now(), sessionRunning: true }).typed(Date.now());
    sentFrames.length = 0;
    bindProcessSharedMachineActivity(procB.name, idOf(procB), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p1',
      authority: tokP1b,
    }, { now: Date.now() + 10, sessionRunning: true }).typed(Date.now() + 10);
    expect(readActiveTreeAuthorityForSession(procB.name)).toMatchObject({ kind: 'mixed', authority: null });
    expect(sentFrames).toEqual(expect.arrayContaining([
      { type: DAEMON_MSG.TURN_AUTHORITY_REVOKE, rootSessionName: procB.name, tokenHash: sha256(tokO) },
      { type: DAEMON_MSG.TURN_AUTHORITY_REVOKE, rootSessionName: procB.name, tokenHash: sha256(tokP1b) },
    ]));

    // Case C: Failed revoke send (`trySendOk = false`) keeps hashes in `pendingRevokeHashes` and retries at final idle on SAME linkGen
    const procC = seed({ name: 'deck_proc_c3_brain', projectName: 'proc-c3', role: 'brain', state: 'running' });
    const tokC1 = 'trg_retry_c1_5555555555555555555';
    const tokC2 = 'trg_retry_c2_6666666666666666666';
    bindProcessSharedMachineActivity(procC.name, idOf(procC), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p1',
      authority: tokC1,
    }, { now: Date.now(), sessionRunning: true }).typed(Date.now());
    trySendOk = false;
    sentFrames.length = 0;
    bindProcessSharedMachineActivity(procC.name, idOf(procC), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p2',
      authority: tokC2,
    }, { now: Date.now() + 10, sessionRunning: true }).typed(Date.now() + 10);
    expect(sentFrames).toEqual([]);

    trySendOk = true;
    upsertSession({ ...procC, state: 'idle' });
    releaseProcessSharedMachineAuthority(procC.name, { forceSettle: true });
    await flushMicrotasks();
    expect(sentFrames).toEqual(expect.arrayContaining([
      { type: DAEMON_MSG.TURN_AUTHORITY_REVOKE, rootSessionName: procC.name, tokenHash: sha256(tokC1) },
      { type: DAEMON_MSG.TURN_AUTHORITY_REVOKE, rootSessionName: procC.name, tokenHash: sha256(tokC2) },
    ]));

    // Case D: If linkGeneration changed before final idle, stale linkGen revoke hashes are fenced cleanly
    const procD = seed({ name: 'deck_proc_c4_brain', projectName: 'proc-c4', role: 'brain', state: 'running' });
    const tokD1 = 'trg_fence_d1_7777777777777777777';
    const tokD2 = 'trg_fence_d2_8888888888888888888';
    linkGen = 20;
    trySendOk = false;
    bindProcessSharedMachineActivity(procD.name, idOf(procD), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p1',
      authority: tokD1,
    }, { now: Date.now(), sessionRunning: true }).typed(Date.now());
    bindProcessSharedMachineActivity(procD.name, idOf(procD), {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p2',
      authority: tokD2,
    }, { now: Date.now() + 10, sessionRunning: true }).typed(Date.now() + 10);
    sentFrames.length = 0;
    linkGen = 21;
    trySendOk = true;
    upsertSession({ ...procD, state: 'idle' });
    releaseProcessSharedMachineAuthority(procD.name, { forceSettle: true });
    await flushMicrotasks();
    expect(sentFrames).toEqual([]);
  });
});
