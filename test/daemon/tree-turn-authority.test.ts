import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  bindProcessSharedMachineActivity,
  bindTreeTurnAuthority,
  clearAllDaemonTurnAuthoritiesOnDisconnect,
  clearProcessSharedMachineAuthoritiesForTests,
  markTreeSessionActive,
  markTreeSessionIdle,
  markTreeSessionIdleIfInactive,
  readActiveTreeAuthorityForSession,
  registerTreeSessionActivityProbe,
  releaseProcessSharedMachineAuthority,
  resolveCanonicalTurnAuthority,
  resolveDaemonRootSessionName,
  resolveSessionEffectiveSharedMachineAuthority,
} from '../../src/daemon/shared-machine-authority-context.js';
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
    // Prior token revoked immediately and tree poisoned to mixed
    expect(sentFrames).toContainEqual({
      type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
      rootSessionName: main.name,
      tokenHash: sha256(tokP2),
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

  it('P0 #2: revokes fast (<1500ms) turns via idle guard timer, failed task-pair inactive cleanup, error probe, and link disconnect + generation fence', async () => {
    vi.useFakeTimers();
    try {
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

      // Turn finishes in 300ms (< 1500ms idle guard) and session becomes idle
      vi.advanceTimersByTime(300);
      upsertSession({ ...fastSess, state: 'idle' });
      releaseProcessSharedMachineAuthority(fastSess.name, Date.now());
      await flushMicrotasks();
      expect(sentFrames).toEqual([]);

      // Advancing past 1500ms guard fires automatic recheck & revoke!
      vi.advanceTimersByTime(1_300);
      await flushMicrotasks();
      expect(sentFrames).toEqual([{
        type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
        rootSessionName: fastSess.name,
        tokenHash: sha256(tokFast),
      }]);

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
    } finally {
      vi.useRealTimers();
    }
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
});
