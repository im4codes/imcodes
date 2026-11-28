import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  bindProcessSharedMachineActivity,
  clearProcessSharedMachineAuthoritiesForTests,
  markTreeSessionActive,
  markTreeSessionIdle,
  readActiveTreeAuthorityForSession,
  registerTreeSessionActivityProbe,
  releaseProcessSharedMachineAuthority,
  resolveDaemonRootSessionName,
  resolveSessionEffectiveSharedMachineAuthority,
} from '../../src/daemon/shared-machine-authority-context.js';
import {
  AMBIGUOUS_PARTICIPANT_ACTOR,
  readSenderOwnerMachineAuthority,
  readSenderParticipantTurn,
} from '../../src/daemon/sender-participant-turn.js';
import { setActiveServerLink } from '../../src/daemon/active-server-link.js';
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

    // Participant P2 sends into Tree 1 main session (P1 -> P2): Tree 1 immediately switches to P2!
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
});
