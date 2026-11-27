import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import {
  MEMORY_MCP_SESSION_CLOSE_HOOK_PATH,
  MEMORY_MCP_SESSION_MODEL_LIST_HOOK_PATH,
  MEMORY_MCP_SESSION_MODEL_SET_HOOK_PATH,
  MEMORY_MCP_SESSION_RESTART_BATCH_HOOK_PATH,
  MEMORY_MCP_SESSION_RESTART_HOOK_PATH,
} from '../../shared/memory-mcp-contracts.js';
import {
  MEMORY_MCP_DAEMON_RPC_PATH,
} from '../../shared/memory-mcp-daemon-rpc.js';
import {
  EXECUTION_POOL_DAEMON_RPC_PATH,
} from '../../shared/execution-pool-mcp.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';
import { IMCODES_EXTERNAL_CLI_SENDER } from '../../shared/imcodes-send.js';
import { SEND_COMMAND_HOOK_PATH } from '../../shared/send-command-mode.js';
import { HOOK_SESSION_CREDENTIAL_HEADER } from '../../shared/hook-session-credential.js';

const participantTurns = new Map<string, { actorUserId: string; authority: string | null }>();
const sessionsMap = new Map<string, {
  name: string;
  projectName: string;
  state: string;
  contextNamespace?: { scope: 'personal' | 'user_private' | 'project_shared'; projectId: string; userId?: string };
}>();

vi.mock('../../src/daemon/sender-participant-turn.js', () => ({
  AMBIGUOUS_PARTICIPANT_ACTOR: '__ambiguous_participant__',
  readSenderParticipantTurn: vi.fn((sessionName: string) => participantTurns.get(sessionName) ?? null),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn((name: string) => sessionsMap.get(name) ?? null),
  upsertSession: vi.fn(),
  listSessions: vi.fn(() => Array.from(sessionsMap.values())),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: vi.fn(() => undefined),
}));

const mockStopSessionNow = vi.fn(() => true);
const mockRestartSessionNow = vi.fn(async () => true);
const mockListSessionModelsNow = vi.fn(async () => ({
  status: 'ok' as const,
  target: 'deck_shared_main',
  currentModel: 'sonnet',
  currentThinking: 'medium',
  supportedModels: ['sonnet'],
  supportedThinking: ['medium'],
}));
const mockSwitchSessionModelNow = vi.fn(async () => ({
  status: 'ok' as const,
  target: 'deck_shared_main',
  model: 'sonnet',
}));
vi.mock('../../src/daemon/command-handler.js', () => ({
  stopSessionNow: (...args: unknown[]) => mockStopSessionNow(...args as []),
  restartSessionNow: (...args: unknown[]) => mockRestartSessionNow(...args as []),
  listSessionModelsNow: (...args: unknown[]) => mockListSessionModelsNow(...args as []),
  switchSessionModelNow: (...args: unknown[]) => mockSwitchSessionModelNow(...args as []),
}));

const mockDispatchHookSend = vi.fn(async ({ targetRecords }: { targetRecords: Array<{ name: string }> }) => ({
  dispatchId: 'disp-participant-1',
  delivered: targetRecords.map((target) => target.name),
  queued: [],
  errors: [],
  messages: targetRecords.map((target) => ({ target: target.name, messageId: 'msg-participant-1' })),
}));
vi.mock('../../src/daemon/send-tool.js', () => ({
  dispatchHookSend: (...args: unknown[]) => mockDispatchHookSend(...args as [{ targetRecords: Array<{ name: string }> }]),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('../../src/daemon/watcher-controls.js', () => ({ refreshSessionWatcher: vi.fn() }));
vi.mock('../../src/context/memory-recall-client.js', () => ({
  searchLocalMemoryForManagement: vi.fn(async () => ({ items: [] })),
  searchLocalMemorySemanticForManagement: vi.fn(async () => ({ items: [] })),
}));
vi.mock('../../src/store/memory-daemon-switch.js', () => ({
  isMemoryDaemonEnabled: vi.fn(() => true),
}));
vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { clearQueues, startHookServer } from '../../src/daemon/hook-server.js';
import { aliasMcpList, aliasMcpResolve } from '../../src/daemon/alias-mcp-client.js';
import { listVerificationMachineProfiles } from '../../src/daemon/verification-machine-mcp-client.js';
import { messagePinMcpList } from '../../src/daemon/message-pin-mcp-client.js';
import { cronMcpList } from '../../src/daemon/cron-mcp-client.js';
import { searchMcpMemoryRecall } from '../../src/daemon/memory-mcp-search.js';
import { getMemorySourcesOrchestrated } from '../../src/daemon/memory-get-sources-orchestrator.js';
import { createProjectionOwnerCache } from '../../src/daemon/memory-projection-owner-cache.js';
import { createSessionSharedMachineAuthorityLoader } from '../../src/daemon/shared-machine-authority.js';
import { ServerCapabilityService } from '../../src/capability/server-capability-service.js';

function requestHook(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  sender?: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const matchedSession = sender ? sessionsMap.get(sender) as { hookCredential?: string } | undefined : undefined;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      agent: false,
      headers: {
        Connection: 'close',
        ...(body !== undefined
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {}),
        ...(sender ? { 'x-imcodes-session': sender } : {}),
        ...(matchedSession?.hookCredential ? { [HOOK_SESSION_CREDENTIAL_HEADER]: matchedSession.hookCredential } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(data);
    else req.end();
  });
}

describe('hook-server shared participant isolation', () => {
  let server: http.Server;
  let port: number;
  const invokeMemoryMcpTool = vi.fn(async () => ({ status: 'ok', entries: [] }));
  const closeSession = vi.fn(async () => ({
    status: 'closed' as const,
    target: 'deck_sub_other',
    authority: 'brain' as const,
    serverNotified: true,
    forced: false,
  }));
  const restartSession = vi.fn(async () => true);
  const listSessionModels = vi.fn(async () => ({
    status: 'ok' as const,
    target: 'deck_shared_main',
    currentModel: 'sonnet',
    currentThinking: 'medium',
    supportedModels: ['sonnet'],
    supportedThinking: ['medium'],
  }));
  const switchSessionModel = vi.fn(async () => ({
    status: 'ok' as const,
    target: 'deck_shared_main',
    model: 'sonnet',
  }));
  const onHook = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    clearQueues();
    participantTurns.clear();
    sessionsMap.clear();
    participantTurns.set('deck_shared_main', { actorUserId: 'participant_user_1', authority: 'sma.jwt.part.1' });
    sessionsMap.set('deck_shared_main', {
      name: 'deck_shared_main',
      projectName: 'proj-shared',
      state: 'idle',
      hookCredential: 'cred-shared-main',
      contextNamespace: { scope: 'personal', projectId: 'proj_shared', userId: 'owner_user_1' },
    } as never);
    sessionsMap.set('deck_shared_sub', {
      name: 'deck_shared_sub',
      projectName: 'proj-shared',
      state: 'idle',
      hookCredential: 'cred-shared-sub',
    } as never);
    sessionsMap.set('deck_private_main', {
      name: 'deck_private_main',
      projectName: 'proj-private',
      state: 'idle',
      contextNamespace: { scope: 'personal', projectId: 'proj_private', userId: 'owner_user_1' },
    });

    const started = await startHookServer(onHook, {
      invokeMemoryMcpTool,
      closeSession,
      restartSession,
      listSessionModels,
      switchSessionModel,
    });
    server = started.server;
    port = started.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('scopes participant memory tool callers to actorUserId while keeping session/identity/pair/send tools at owner parity and save_preference forbidden', async () => {
    const ownerParityTools = [
      ['session_identity_get', {}],
      ['session_identity_set', { identityScope: 'session', content: 'Updated role' }],
      ['session_identity_clear', { identityScope: 'session' }],
      ['session_identity_refresh', { all: false }],
      ['session_history', { kind: 'text', limit: 10 }],
      ['send_message', { to: 'deck_shared_sub', message: 'hi sibling' }],
      ['pair_create', { title: 'Test', brief: 'Brief' }],
      ['memory_injection_set', { enabled: false }],
    ] as const;

    for (const [tool, input] of ownerParityTools) {
      const res = await requestHook(port, 'POST', MEMORY_MCP_DAEMON_RPC_PATH, 'deck_shared_main', {
        tool,
        input,
      });
      expect(res.status, tool).toBe(200);
      expect(res.body, tool).toMatchObject({ ok: true, result: { status: 'ok' } });
      const [callerArg] = invokeMemoryMcpTool.mock.calls.at(-1)! as [{ userId: string; namespace: { userId?: string }; isParticipantTurn?: boolean }, string];
      expect(callerArg.userId, `${tool} keeps owner parity`).toBe('owner_user_1');
      expect(callerArg.isParticipantTurn, `${tool} does not downgrade operational scope`).toBeUndefined();
    }

    const participantScopedMemoryTools = [
      ['search_memory', { query: 'hello' }],
      ['list_memory_summaries', { limit: 5 }],
      ['get_memory_sources', { projectionId: 'proj_1' }],
      ['archive_memory', { projectionId: 'proj_1' }],
      ['restore_memory', { projectionId: 'proj_1' }],
      ['delete_memory', { projectionId: 'proj_1' }],
      ['update_memory', { projectionId: 'proj_1', text: 'edited' }],
      ['memory_feedback', { projectionId: 'proj_1', feedback: 'relevant' }],
      ['save_observation', { content: 'fact' }],
    ] as const;

    for (const [tool, input] of participantScopedMemoryTools) {
      const res = await requestHook(port, 'POST', MEMORY_MCP_DAEMON_RPC_PATH, 'deck_shared_main', {
        tool,
        input,
      });
      expect(res.status, tool).toBe(200);
      expect(res.body, tool).toMatchObject({ ok: true, result: { status: 'ok' } });
      const [callerArg] = invokeMemoryMcpTool.mock.calls.at(-1)! as [{
        userId: string;
        namespace: { userId?: string };
        isParticipantTurn?: boolean;
        participantAuthority?: string | null;
      }, string];
      expect(callerArg.userId, `${tool} caller.userId`).toBe('participant_user_1');
      expect(callerArg.namespace.userId, `${tool} caller.namespace.userId`).toBe('participant_user_1');
      expect(callerArg.isParticipantTurn, `${tool} isParticipantTurn`).toBe(true);
      expect(callerArg.participantAuthority, `${tool} participantAuthority`).toBe('sma.jwt.part.1');
    }

    // Ambiguous participant turn fails closed with the sentinel actor and null authority on memory calls.
    participantTurns.set('deck_shared_main', { actorUserId: '__ambiguous_participant__', authority: null });
    const ambigRes = await requestHook(port, 'POST', MEMORY_MCP_DAEMON_RPC_PATH, 'deck_shared_main', {
      tool: 'search_memory',
      input: { query: 'secret' },
    });
    expect(ambigRes.status).toBe(200);
    const [ambigCaller] = invokeMemoryMcpTool.mock.calls.at(-1)! as [{
      userId: string;
      namespace: { userId?: string };
      isParticipantTurn?: boolean;
      participantAuthority?: string | null;
    }];
    expect(ambigCaller.userId).toBe('__ambiguous_participant__');
    expect(ambigCaller.namespace.userId).toBe('__ambiguous_participant__');
    expect(ambigCaller.isParticipantTurn).toBe(true);
    expect(ambigCaller.participantAuthority).toBeNull();

    const blockedPref = await requestHook(port, 'POST', MEMORY_MCP_DAEMON_RPC_PATH, 'deck_shared_main', {
      tool: 'save_preference',
      input: { text: 'prefer concise answers' },
    });
    expect(blockedPref.status).toBe(200);
    expect(blockedPref.body).toMatchObject({
      ok: true,
      result: { status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN },
    });
    expect(invokeMemoryMcpTool).toHaveBeenCalledTimes(ownerParityTools.length + participantScopedMemoryTools.length + 1);

    const ownerPref = await requestHook(port, 'POST', MEMORY_MCP_DAEMON_RPC_PATH, 'deck_private_main', {
      tool: 'save_preference',
      input: { text: 'prefer concise answers' },
    });
    expect(ownerPref.status).toBe(200);
    expect(ownerPref.body).toMatchObject({ ok: true, result: { status: 'ok' } });
    expect(invokeMemoryMcpTool).toHaveBeenCalledTimes(ownerParityTools.length + participantScopedMemoryTools.length + 2);
  });

  it('allows participant turns to list and switch models on self and other sessions with owner parity', async () => {
    const selfList = await requestHook(port, 'POST', MEMORY_MCP_SESSION_MODEL_LIST_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_shared_main',
    });
    expect(selfList.status).toBe(200);

    const otherList = await requestHook(port, 'POST', MEMORY_MCP_SESSION_MODEL_LIST_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_private_main',
    });
    expect(otherList.status).toBe(200);

    const selfSet = await requestHook(port, 'POST', MEMORY_MCP_SESSION_MODEL_SET_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_shared_main',
      model: 'opus',
    });
    expect(selfSet.status).toBe(200);

    const siblingSet = await requestHook(port, 'POST', MEMORY_MCP_SESSION_MODEL_SET_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_shared_sub',
      model: 'opus',
    });
    expect(siblingSet.status).toBe(200);
    expect(switchSessionModel).toHaveBeenCalledTimes(2);
  });

  it('allows participant turns to reset self, restart sibling sessions, and close sessions while preserving project scope', async () => {
    const crossProjectRestart = await requestHook(port, 'POST', MEMORY_MCP_SESSION_RESTART_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_private_main',
      reset: false,
    });
    // Cross-project targets still fail project-scope lookup with 404 (same as owner), not shared_participant_forbidden.
    expect(crossProjectRestart.status).toBe(404);

    const siblingRestart = await requestHook(port, 'POST', MEMORY_MCP_SESSION_RESTART_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_shared_sub',
      reset: true,
    });
    expect(siblingRestart.status).toBe(202);

    const resetSelf = await requestHook(port, 'POST', MEMORY_MCP_SESSION_RESTART_BATCH_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      targets: [{ target: 'deck_shared_main', reset: true }],
    });
    expect(resetSelf.status).toBe(202);

    const selfSoftRestart = await requestHook(port, 'POST', MEMORY_MCP_SESSION_RESTART_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_shared_main',
      reset: false,
    });
    expect(selfSoftRestart.status).toBe(202);

    const closeRes = await requestHook(port, 'POST', MEMORY_MCP_SESSION_CLOSE_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      target: 'deck_shared_sub',
    });
    expect(closeRes.status).toBe(200);
    expect(closeSession).toHaveBeenCalledWith('deck_shared_main', { target: 'deck_shared_sub' });
  });

  it('allows participant turns to /send, /stop, and /send /stop on sibling sessions with owner parity', async () => {
    const sendRes = await requestHook(port, 'POST', '/send', 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_shared_sub',
      message: 'coordinate work',
    });
    expect(sendRes.status).toBe(200);
    expect(mockDispatchHookSend).toHaveBeenCalledTimes(1);

    const stopRes = await requestHook(port, 'POST', '/stop', 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_shared_sub',
    });
    expect(stopRes.status).toBe(200);
    expect(stopRes.body).toMatchObject({ ok: true, stopped: true, target: 'deck_shared_sub' });

    const sendStopRes = await requestHook(port, 'POST', '/send', 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_shared_sub',
      message: '/stop',
    });
    expect(sendStopRes.status).toBe(200);
    expect(sendStopRes.body).toMatchObject({ ok: true, stopped: true, target: 'deck_shared_sub' });
    expect(mockStopSessionNow).toHaveBeenCalledTimes(2);
  });

  it('scopes /sessions/live to caller projectName when x-imcodes-session resolves a session record', async () => {
    const scoped = await requestHook(port, 'POST', '/sessions/live', 'deck_shared_main', {});
    expect(scoped.status).toBe(200);
    expect((scoped.body.sessions as Array<{ name: string }>).map((s) => s.name)).toEqual([
      'deck_shared_main',
      'deck_shared_sub',
    ]);

    const cliUnscoped = await requestHook(port, 'POST', '/sessions/live', undefined, {});
    expect(cliUnscoped.status).toBe(200);
    expect((cliUnscoped.body.sessions as Array<{ name: string }>).map((s) => s.name)).toEqual([
      'deck_shared_main',
      'deck_shared_sub',
      'deck_private_main',
    ]);
  });

  it('blocks unauthenticated external /send, /send-command, /send "/stop", and /stop while any active session runs a shared participant turn', async () => {
    for (const from of [IMCODES_EXTERNAL_CLI_SENDER, 'cli']) {
      const sendRes = await requestHook(port, 'POST', '/send', undefined, {
        from,
        to: 'deck_private_main',
        message: 'elevate',
      });
      expect(sendRes, `${from} /send`).toEqual({ status: 403, body: { ok: false, error: 'external_send_blocked_during_participant_turn' } });

      const cmdRes = await requestHook(port, 'POST', SEND_COMMAND_HOOK_PATH, undefined, {
        from,
        to: 'deck_private_main',
        message: '/status',
      });
      expect(cmdRes, `${from} /send-command`).toEqual({ status: 403, body: { ok: false, error: 'external_send_blocked_during_participant_turn' } });

      const sendStopRes = await requestHook(port, 'POST', '/send', undefined, {
        from,
        to: 'deck_private_main',
        message: '/stop',
      });
      expect(sendStopRes, `${from} /send /stop`).toEqual({ status: 403, body: { ok: false, error: 'external_send_blocked_during_participant_turn' } });

      const stopRes = await requestHook(port, 'POST', '/stop', undefined, {
        from,
        to: 'deck_private_main',
      });
      expect(stopRes, `${from} /stop`).toEqual({ status: 403, body: { ok: false, error: 'external_send_blocked_during_participant_turn' } });
    }
    expect(mockDispatchHookSend).not.toHaveBeenCalled();
    expect(mockStopSessionNow).not.toHaveBeenCalled();

    // Authenticated managed owner session (sibling deck_shared_sub with matching credential) is NOT blocked by another session's participant turn
    const { HOOK_SESSION_CREDENTIAL_HEADER } = await import('../../shared/hook-session-credential.js');
    const ownerSend = await requestHook(port, 'POST', '/send', 'deck_shared_sub', {
      from: 'deck_shared_sub',
      to: 'deck_shared_main',
      message: 'owner message',
    }, {
      [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-shared-sub',
    });
    expect(ownerSend.status).toBe(200);
    expect(mockDispatchHookSend).toHaveBeenCalledTimes(1);

    // Legacy/adopted active session WITHOUT stored hookCredential MUST use external policy only:
    // blocked 403 while participant turn is active, and cannot broadcast/resolve labels even when idle.
    sessionsMap.set('deck_legacy_pane', {
      name: 'deck_legacy_pane',
      projectName: 'proj-shared',
      label: 'LegacyPane',
      state: 'idle',
    } as never);
    for (const legacyAttempt of [
      { path: '/send', body: { from: 'deck_legacy_pane', to: 'deck_private_main', message: 'elevate' } },
      { path: '/send', body: { from: 'LegacyPane', to: 'deck_private_main', message: 'elevate' } },
      { path: SEND_COMMAND_HOOK_PATH, body: { from: 'deck_legacy_pane', to: 'deck_private_main', message: '/status' } },
      { path: '/send', body: { from: 'deck_legacy_pane', to: 'deck_private_main', message: '/stop' } },
      { path: '/stop', body: { from: 'deck_legacy_pane', to: 'deck_private_main' } },
    ] as const) {
      const blockedLegacy = await requestHook(port, 'POST', legacyAttempt.path, undefined, legacyAttempt.body);
      expect(blockedLegacy, `${legacyAttempt.path}`).toEqual({
        status: 403,
        body: { ok: false, error: 'external_send_blocked_during_participant_turn' },
      });
    }
    expect(mockDispatchHookSend).toHaveBeenCalledTimes(1);
    expect(mockStopSessionNow).not.toHaveBeenCalled();

    // Stopped participant session must not permanently block external CLI sends
    sessionsMap.set('deck_shared_main', {
      name: 'deck_shared_main',
      projectName: 'proj-shared',
      state: 'stopped',
      contextNamespace: { scope: 'personal', projectId: 'proj_shared', userId: 'owner_user_1' },
    });
    const afterStopSend = await requestHook(port, 'POST', '/send', undefined, {
      from: IMCODES_EXTERNAL_CLI_SENDER,
      to: 'deck_private_main',
      message: 'callback after participant stopped',
    });
    expect(afterStopSend.status).toBe(200);

    // Once active participant turn finishes, external /send succeeds again;
    // pure external-CLI restricted turns do not block external callbacks
    sessionsMap.set('deck_shared_main', {
      name: 'deck_shared_main',
      projectName: 'proj-shared',
      state: 'idle',
      hookCredential: 'cred-shared-main',
      contextNamespace: { scope: 'personal', projectId: 'proj_shared', userId: 'owner_user_1' },
    } as never);
    participantTurns.clear();
    participantTurns.set('deck_private_main', { actorUserId: IMCODES_EXTERNAL_CLI_SENDER, authority: null });
    const extTurnSend = await requestHook(port, 'POST', '/send', undefined, {
      from: IMCODES_EXTERNAL_CLI_SENDER,
      to: 'deck_private_main',
      message: 'second webhook callback',
    });
    expect(extTurnSend.status).toBe(200);
    expect(mockDispatchHookSend.mock.calls.at(-1)?.[0]).toMatchObject({
      from: IMCODES_EXTERNAL_CLI_SENDER,
      senderRecord: null,
    });

    // When idle, legacy credential-less active session can use exact active target ONLY (restricted external policy),
    // never broadcast or sibling label resolution (`senderRecord: null`, NOT trusted dispatch).
    if (sessionsMap.has('deck_legacy_pane')) {
      const legacyBroadcast = await requestHook(port, 'POST', '/send', undefined, {
        from: 'deck_legacy_pane',
        to: '*',
        message: 'broadcast forbidden',
      });
      expect(legacyBroadcast.status).toBe(404);
      const legacyExact = await requestHook(port, 'POST', '/send', undefined, {
        from: 'LegacyPane',
        to: 'deck_private_main',
        message: 'restricted local callback',
      });
      expect(legacyExact.status).toBe(200);
      expect(mockDispatchHookSend.mock.calls.at(-1)?.[0]).toMatchObject({
        from: 'LegacyPane',
        senderRecord: null,
      });
    }
  });

  it('verifies hookCredential against canonical session identity on label claims and propagates canonical identity on authenticated labels', async () => {
    const { HOOK_SESSION_CREDENTIAL_ERROR, HOOK_SESSION_CREDENTIAL_HEADER } = await import('../../shared/hook-session-credential.js');
    participantTurns.clear();
    mockDispatchHookSend.mockClear();
    mockStopSessionNow.mockClear();

    const credBrain = {
      name: 'deck_cred_brain',
      projectName: 'proj-cred',
      label: 'CredBrain',
      state: 'idle',
      hookCredential: 'cred-brain-secret',
      contextNamespace: { scope: 'personal' as const, projectId: 'proj_cred', userId: 'owner_user_1' },
    };
    const credWorker = {
      name: 'deck_cred_w1',
      projectName: 'proj-cred',
      label: 'CredWorker',
      state: 'idle',
      hookCredential: 'cred-w1-secret',
      contextNamespace: { scope: 'personal' as const, projectId: 'proj_cred', userId: 'owner_user_1' },
    };
    sessionsMap.set(credBrain.name, credBrain);
    sessionsMap.set(credWorker.name, credWorker);

    // Unauthenticated label claim (and header label claim) against credentialed session must fail closed 403 across all 3 routes + /send "/stop"
    for (const attempt of [
      { path: '/send', body: { from: 'CredBrain', to: 'deck_cred_w1', message: 'hi' } },
      { path: SEND_COMMAND_HOOK_PATH, body: { from: 'CredBrain', to: 'deck_cred_w1', message: '/status' } },
      { path: '/send', body: { from: 'CredBrain', to: 'deck_cred_w1', message: '/stop' } },
      { path: '/stop', body: { from: 'CredBrain', to: 'deck_cred_w1' } },
    ] as const) {
      const noCred = await requestHook(port, 'POST', attempt.path, undefined, attempt.body);
      expect(noCred).toEqual({ status: 403, body: { ok: false, error: HOOK_SESSION_CREDENTIAL_ERROR } });
      const wrongCred = await requestHook(port, 'POST', attempt.path, 'CredBrain', attempt.body, {
        [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-wrong',
      });
      expect(wrongCred).toEqual({ status: 403, body: { ok: false, error: HOOK_SESSION_CREDENTIAL_ERROR } });
    }
    expect(mockDispatchHookSend).not.toHaveBeenCalled();
    expect(mockStopSessionNow).not.toHaveBeenCalled();

    // Ambiguous unauthenticated label never resolves a trusted sender
    sessionsMap.set('deck_amb_1', { name: 'deck_amb_1', projectName: 'proj-cred', label: 'DupLabel', state: 'idle' });
    sessionsMap.set('deck_amb_2', { name: 'deck_amb_2', projectName: 'proj-cred', label: 'DupLabel', state: 'idle' });
    const ambIdle = await requestHook(port, 'POST', '/send', undefined, { from: 'DupLabel', to: 'deck_cred_w1', message: 'hi' });
    expect(ambIdle.status).toBe(404);
    participantTurns.set('deck_shared_main', { actorUserId: 'part-user-1', authority: null });
    const ambDuringPart = await requestHook(port, 'POST', '/send', undefined, { from: 'DupLabel', to: 'deck_cred_w1', message: 'hi' });
    expect(ambDuringPart).toEqual({ status: 403, body: { ok: false, error: 'external_send_blocked_during_participant_turn' } });
    expect(mockDispatchHookSend).not.toHaveBeenCalled();

    // Authenticated label sender passes canonical session identity (name + senderRecord) to dispatchHookSend even while participant turn is active
    const authLabelSend = await requestHook(port, 'POST', '/send', undefined, {
      from: 'CredWorker',
      to: 'deck_cred_brain',
      message: 'authorized callback',
    }, {
      [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-w1-secret',
    });
    expect(authLabelSend.status).toBe(200);
    expect(mockDispatchHookSend).toHaveBeenCalledTimes(1);
    expect(mockDispatchHookSend.mock.calls[0]?.[0]).toMatchObject({
      from: 'deck_cred_w1',
      senderRecord: credWorker,
    });
  });

  it('keeps exec_remote/aliases/save_preference/execution_pool fail-closed during external-CLI turns while permitting purpose=cron only for pure external-CLI turns', async () => {
    const {
      createSessionCronAuthorityLoader,
    } = await import('../../src/daemon/shared-machine-authority.js');
    const {
      bindProcessSharedMachineActivity,
      clearProcessSharedMachineAuthoritiesForTests,
    } = await import('../../src/daemon/shared-machine-authority-context.js');
    const {
      SHARED_MACHINE_ACTIVITY_KIND,
      SHARED_MACHINE_AUTHORITY_HOOK_PATH,
    } = await import('../../shared/shared-machine-authority.js');

    clearProcessSharedMachineAuthoritiesForTests();
    participantTurns.clear();
    participantTurns.set('deck_private_main', { actorUserId: IMCODES_EXTERNAL_CLI_SENDER, authority: null });
    sessionsMap.set('deck_private_main', {
      name: 'deck_private_main',
      projectName: 'proj-private',
      state: 'idle',
      sessionInstanceId: 'inst-priv-1',
      runtimeEpoch: 'epoch-priv-1',
      contextNamespace: { scope: 'personal', projectId: 'proj_private', userId: 'owner_user_1' },
    } as never);
    bindProcessSharedMachineActivity(
      'deck_private_main',
      { sessionInstanceId: 'inst-priv-1', runtimeEpoch: 'epoch-priv-1' },
      { kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT, actorUserId: IMCODES_EXTERNAL_CLI_SENDER },
    );

    try {
      // Non-cron authority lookup (exec_remote, aliases, etc.) still fails closed 403
      const ordinaryHook = await requestHook(port, 'POST', SHARED_MACHINE_AUTHORITY_HOOK_PATH, 'deck_private_main', {
        sessionInstanceId: 'inst-priv-1',
        runtimeEpoch: 'epoch-priv-1',
      });
      expect(ordinaryHook.status).toBe(403);

      const stdLoader = createSessionSharedMachineAuthorityLoader({
        callerSessionName: 'deck_private_main',
        resourceOwner: { sessionName: 'deck_private_main', sessionInstanceId: 'inst-priv-1', runtimeEpoch: 'epoch-priv-1' },
        requireHookPort: async () => port,
      });
      await expect(stdLoader()).rejects.toThrow();

      // Cron authority lookup identifies pure external-CLI turn cleanly
      const cronLoader = createSessionCronAuthorityLoader({
        callerSessionName: 'deck_private_main',
        resourceOwner: { sessionName: 'deck_private_main', sessionInstanceId: 'inst-priv-1', runtimeEpoch: 'epoch-priv-1' },
        requireHookPort: async () => port,
      });
      expect(await cronLoader()).toEqual({ authority: null, restrictedExternalCli: true });

      // save_preference and execution_pool daemon RPCs stay forbidden during external-CLI turns
      const prefRes = await requestHook(port, 'POST', MEMORY_MCP_DAEMON_RPC_PATH, 'deck_private_main', {
        sessionInstanceId: 'inst-priv-1',
        runtimeEpoch: 'epoch-priv-1',
        tool: 'save_preference',
        input: { text: 'hijack' },
      });
      expect(prefRes.body).toMatchObject({ ok: true, result: { status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN } });

      const poolRes = await requestHook(port, 'POST', EXECUTION_POOL_DAEMON_RPC_PATH, 'deck_private_main', {
        sessionInstanceId: 'inst-priv-1',
        runtimeEpoch: 'epoch-priv-1',
        tool: 'execution_pool_set',
        input: { concurrencyCap: 2 },
      });
      expect(poolRes.body).toMatchObject({ ok: true, result: { status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN } });

      // Mixed/ambiguous web participant turn MUST stay 403 even with purpose=cron
      participantTurns.set('deck_private_main', { actorUserId: '__ambiguous_participant__', authority: null });
      await expect(cronLoader()).rejects.toThrow();
    } finally {
      clearProcessSharedMachineAuthoritiesForTests();
    }
  });
});

describe('daemon MCP HTTP clients propagate shared-machine authority and fail closed on loader failure', () => {
  const endpoint = { serverId: 'srv_shared', workerUrl: 'http://127.0.0.1:9999', token: 'tok_secret' };

  function mockOkFetch() {
    return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, items: [], pins: [], entries: [], capabilities: [], jobs: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
  }

  function extractHeader(fetchMock: ReturnType<typeof mockOkFetch>, name: string): string | null {
    const call = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | Headers | undefined;
    if (!headers) return null;
    if (headers instanceof Headers) return headers.get(name);
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === name.toLowerCase()) return v;
    }
    return null;
  }

  it('sends X-IMCodes-Shared-Machine-Authority across all daemon MCP HTTP clients when loaded', async () => {
    const authToken = 'sma.jwt.participant.token';
    const loader = async () => authToken;

    const fAlias = mockOkFetch();
    await aliasMcpList({ endpoint, fetchImpl: fAlias, loadSharedMachineAuthority: loader });
    expect(extractHeader(fAlias, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);

    const fAliasResolve = mockOkFetch();
    await aliasMcpResolve('deploy', { endpoint, fetchImpl: fAliasResolve, loadSharedMachineAuthority: loader });
    expect(extractHeader(fAliasResolve, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);

    const fVm = mockOkFetch();
    await listVerificationMachineProfiles(undefined, { endpoint, fetchImpl: fVm, loadSharedMachineAuthority: loader });
    expect(extractHeader(fVm, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);

    const fPins = mockOkFetch();
    await messagePinMcpList({}, { endpoint, fetchImpl: fPins, loadSharedMachineAuthority: loader });
    expect(extractHeader(fPins, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);

    const fCron = mockOkFetch();
    await cronMcpList({}, { endpoint, fetchImpl: fCron, loadSharedMachineAuthority: loader });
    expect(extractHeader(fCron, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);

    const fMem = mockOkFetch();
    await searchMcpMemoryRecall({
      query: 'hello',
      namespace: { scope: 'personal', projectId: 'proj' },
    }, { credentials: endpoint, fetchImpl: fMem, loadSharedMachineAuthority: loader });
    expect(extractHeader(fMem, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);

    const fSources = mockOkFetch();
    await getMemorySourcesOrchestrated('proj_1', {
      namespace: { scope: 'personal', projectId: 'proj' },
    }, {
      loadCredentials: async () => endpoint,
      fetchImpl: fSources,
      loadSharedMachineAuthority: loader,
    });
    expect(extractHeader(fSources, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);

    const fCap = mockOkFetch();
    const capSvc = new ServerCapabilityService({
      serverId: endpoint.serverId,
      loadCredentials: async () => endpoint,
      fetchImpl: fCap,
      loadSharedMachineAuthority: loader,
    });
    await capSvc.list({ scope: 'account' });
    expect(extractHeader(fCap, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);
  });

  it('fails closed without issuing fetch when loadSharedMachineAuthority throws', async () => {
    const failingLoader = async () => {
      throw new Error('authority_lookup_failed');
    };
    const fetchNever = mockOkFetch();

    const r1 = await aliasMcpList({ endpoint, fetchImpl: fetchNever, loadSharedMachineAuthority: failingLoader });
    expect(r1).toMatchObject({ status: 'error' });

    const r2 = await listVerificationMachineProfiles(undefined, { endpoint, fetchImpl: fetchNever, loadSharedMachineAuthority: failingLoader });
    expect(r2).toMatchObject({ status: 'error' });

    const r3 = await messagePinMcpList({}, { endpoint, fetchImpl: fetchNever, loadSharedMachineAuthority: failingLoader });
    expect(r3).toMatchObject({ status: 'error' });

    const r4 = await cronMcpList({}, { endpoint, fetchImpl: fetchNever, loadSharedMachineAuthority: failingLoader });
    expect(r4).toMatchObject({ status: 'error' });

    const capSvc = new ServerCapabilityService({
      serverId: endpoint.serverId,
      loadCredentials: async () => endpoint,
      fetchImpl: fetchNever,
      loadSharedMachineAuthority: failingLoader,
    });
    const r5 = await capSvc.list({ scope: 'account' });
    expect(r5).toMatchObject({ status: 'error' });

    const r6 = await getMemorySourcesOrchestrated('proj_fail_1', {
      namespace: { scope: 'personal', projectId: 'proj' },
    }, {
      loadCredentials: async () => endpoint,
      fetchImpl: fetchNever,
      loadSharedMachineAuthority: failingLoader,
    });
    expect(r6).toMatchObject({ status: 'error', reason: 'scope_forbidden' });

    const remoteCache = createProjectionOwnerCache();
    remoteCache.set('proj_fail_cached_remote', 'srv_other');
    const r7 = await getMemorySourcesOrchestrated('proj_fail_cached_remote', {
      namespace: { scope: 'personal', projectId: 'proj' },
    }, {
      cache: remoteCache,
      skipCloudLookup: true,
      loadCredentials: async () => endpoint,
      fetchImpl: fetchNever,
      loadSharedMachineAuthority: failingLoader,
    });
    expect(r7).toMatchObject({ status: 'error', reason: 'scope_forbidden' });

    expect(fetchNever).not.toHaveBeenCalled();
  });

  it('allows local get_memory_sources without credentials when loadSharedMachineAuthority throws, and allows un-scoped standalone stdio MCP without hook port', async () => {
    const fetchNever = mockOkFetch();
    const localGetSources = vi.fn(async (projectionId: string) => ({
      projectionId,
      sourceEventCount: 1,
      sources: [{ eventId: 'evt-local-1', status: 'archived' as const, content: 'local source', eventType: 'chat.assistant', createdAt: 1 }],
    }));
    const localOnly = await getMemorySourcesOrchestrated('proj_local_only', {
      namespace: { scope: 'personal', projectId: 'proj', userId: 'u1' },
    }, {
      loadCredentials: async () => null,
      fetchImpl: fetchNever,
      localGetSources,
      loadSharedMachineAuthority: async () => {
        throw new Error('shared_machine_authority_incomplete_session_context');
      },
    });
    expect(localOnly).toMatchObject({ status: 'ok', projectionId: 'proj_local_only', sourceEventCount: 1 });
    expect(localGetSources).toHaveBeenCalledOnce();
    expect(fetchNever).not.toHaveBeenCalled();

    // Outside session context (standalone stdio MCP without hook port or session env),
    // the loader resolves null cleanly without sending a forged header.
    const standaloneLoader = createSessionSharedMachineAuthorityLoader({ env: {}, callerSessionName: null, resourceOwner: null });
    expect(await standaloneLoader()).toBeNull();
    const fAlias = mockOkFetch();
    const aliasResult = await aliasMcpList({ endpoint, fetchImpl: fAlias, loadSharedMachineAuthority: standaloneLoader });
    expect(aliasResult.status).toBe('ok');
    expect(extractHeader(fAlias, SHARED_MACHINE_AUTHORITY_HEADER)).toBeNull();
  });
});
