import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WsBridge,
  __setShareBridgeClockForTests,
} from '../src/ws/bridge.js';
import { sha256Hex } from '../src/security/crypto.js';
import {
  SHARE_REASONS,
  SHARE_SCOPED_COMMAND_POLICY,
  SHARE_WS_COMMAND_POLICY_INVENTORY,
  evaluateShareCommand,
  filterShareDaemonMessage,
  shareTargetKey,
  type EffectiveCoverage,
  type ShareTarget,
} from '../src/ws/share-policy.js';
import { TRANSPORT_MSG } from '../../shared/transport-events.js';
import { FS_TRANSPORT_MSG } from '../../shared/fs-transport-messages.js';
import { P2P_WORKFLOW_MSG } from '../../shared/p2p-workflow-messages.js';
import { P2P_CONFIG_MSG } from '../../shared/p2p-config-events.js';
import { getShareScopedCommandPolicy } from '../../shared/tab-sharing.js';
import { REPO_MSG } from '../../shared/repo-types.js';
import { FS_SESSION_ROOT_PATH } from '../../src/shared/transport/fs.js';
import { resetSharedCommandRateLimitsForTests } from '../src/share/share-rate-limit.js';
import { TIMELINE_MESSAGES } from '../../shared/timeline-protocol.js';
import { DIRECT_FILE_TRANSFER_MSG } from '../../shared/direct-file-transfer.js';
import { MSG_COMMAND_ACK } from '../../shared/ack-protocol.js';
import { TRANSPORT_QUEUE_COMMANDS } from '../../shared/transport-queue-types.js';

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('socket closed');
      callback?.(err);
      if (!callback) throw err;
      return;
    }
    this.sent.push(data);
    callback?.();
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close');
  }

  get sentJson(): Record<string, unknown>[] {
    return this.sent
      .filter((item): item is string => typeof item === 'string')
      .flatMap((item) => {
        try {
          return [JSON.parse(item) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  }
}

type AuditInsert = {
  actorUserId: string | null;
  effectiveActorRole: string;
  targetKind: string;
  targetRef: string;
  actionType: string;
  decision: string;
  reason: string | null;
  actionId: string | null;
  idempotencyKey: string;
};

function makeDb(
  runtimeType: 'process' | 'transport' | null = null,
  auditRows: AuditInsert[] = [],
  options: {
    subSessions?: Array<{ id: string; parent_session: string | null }>;
  } = {},
) {
  const discussionComments = new Map<string, Record<string, unknown>>();
  const db = {
    queryOne: async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT token_hash')) return { token_hash: sha256Hex('t') };
      if (sql.includes('runtime_type')) return { runtime_type: runtimeType };
      if (sql.includes('SELECT 1 FROM sessions')) return { exists: 1 };
      if (sql.includes('SELECT 1 FROM sub_sessions')) return { exists: 1 };
      if (sql.includes('FROM users')) return { id: 'shared-user', display_name: 'Shared User', username: 'shared-user' };
      if (sql.includes('SELECT * FROM discussion_comments')) return discussionComments.get(String(params?.[0] ?? '')) ?? null;
      return null;
    },
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM sub_sessions')) {
        const serverIdParam = params?.[0];
        const parentSessionParam = params?.[1];
        return (options.subSessions ?? [])
          .filter((row) => (
            typeof serverIdParam !== 'string'
            || typeof parentSessionParam !== 'string'
            || row.parent_session === parentSessionParam
          ));
      }
      return [];
    },
    execute: async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO discussion_comments') && params) {
        discussionComments.set(String(params[0]), {
          id: params[0],
          server_id: params[1],
          thread_id: params[2],
          scope_kind: params[3],
          scope_server_id: params[4],
          scope_session_name: params[5],
          scope_sub_session_id: params[6],
          created_by_user_id: params[7],
          actor_envelope: params[8],
          authorization_snapshot: params[9],
          primary_share_id: params[10],
          covering_share_ids: params[11],
          visible_after_ms: params[12],
          history_cutoff_at_ms: params[13],
          body: params[14],
          created_at: params[15],
        });
      }
      if (sql.includes('INSERT INTO share_audit_events') && params) {
        auditRows.push({
          actorUserId: typeof params[3] === 'string' ? params[3] : null,
          effectiveActorRole: String(params[5]),
          targetKind: String(params[6]),
          targetRef: String(params[7]),
          actionType: String(params[8]),
          decision: String(params[9]),
          reason: typeof params[10] === 'string' ? params[10] : null,
          actionId: typeof params[13] === 'string' ? params[13] : null,
          idempotencyKey: String(params[14]),
        });
      }
      return { changes: 1 };
    },
    exec: async () => {},
    transaction: async <T>(fn: (tx: import('../src/db/client.js').Database) => Promise<T>) => fn(db as unknown as import('../src/db/client.js').Database),
    close: () => {},
  };
  return db as unknown as import('../src/db/client.js').Database;
}

function coverage(target: ShareTarget, role: 'viewer' | 'participant', now: number, expiresAt: number | null = null): EffectiveCoverage {
  return {
    target,
    effectiveRole: role,
    historyCutoffAt: now - 1_000,
    nextCoverageRecheckAt: expiresAt,
    coveringShareIds: ['share-1'],
    primaryShareId: 'share-1',
    authorizedAt: now,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('WsBridge share-scoped sockets', () => {
  let serverId: string;
  let now: number;

  beforeEach(() => {
    serverId = `share-srv-${Math.random().toString(36).slice(2)}`;
    now = 1_000_000;
    __setShareBridgeClockForTests(() => now);
    resetSharedCommandRateLimitsForTests();
  });

  it('allows direct upload initiation only for participants inside the covered session', () => {
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    const makeState = (role: 'viewer' | 'participant') => ({
      userId: 'shared-user',
      actorDisplayName: 'Shared User',
      ticketId: `ticket-${role}`,
      target,
      snapshot: coverage(target, role, now),
      connectedAt: now,
    });
    const init = {
      type: DIRECT_FILE_TRANSFER_MSG.INIT,
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      clientUploadId: '123e4567-e89b-12d3-a456-426614174001',
      filename: 'shared.bin',
      size: 10,
      sessionName: 'deck_proj_brain',
    };

    expect(evaluateShareCommand({
      msg: init,
      state: makeState('participant'),
      now,
      runtimeType: 'transport',
      activeDispatchId: null,
    })).toMatchObject({ allowed: true });
    expect(evaluateShareCommand({
      msg: init,
      state: makeState('viewer'),
      now,
      runtimeType: 'transport',
      activeDispatchId: null,
    })).toEqual({ allowed: false, reason: SHARE_REASONS.ROLE_DENIED });
    expect(evaluateShareCommand({
      msg: { ...init, sessionName: 'deck_other_brain' },
      state: makeState('participant'),
      now,
      runtimeType: 'transport',
      activeDispatchId: null,
    })).toEqual({ allowed: false, reason: SHARE_REASONS.DIRECT_SURFACE_DENIED });
  });

  afterEach(() => {
    WsBridge.getAll().clear();
    __setShareBridgeClockForTests(null);
    resetSharedCommandRateLimitsForTests();
    vi.useRealTimers();
  });

  it('filters bootstrap/global daemon state and redacts session lists to the shared tab', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'viewer', now));

    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.emit('message', JSON.stringify({ type: TRANSPORT_MSG.PROVIDER_STATUS, providerId: 'qwen', connected: true }));
    await flushAsync();

    const member = new MockWs();
    bridge.handleBrowserConnection(member as never, 'member-user', makeDb());
    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', makeDb(), {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'viewer', now),
    });

    expect(member.sentJson.some((msg) => msg.type === TRANSPORT_MSG.PROVIDER_STATUS)).toBe(true);
    expect(shared.sentJson.some((msg) => msg.type === TRANSPORT_MSG.PROVIDER_STATUS)).toBe(false);

    member.sent.length = 0;
    shared.sent.length = 0;
    daemon.emit('message', JSON.stringify({
      type: 'session_list',
      sessions: [
        { name: 'deck_proj_brain', runtimeType: 'transport' },
        { name: 'deck_other_brain', runtimeType: 'transport' },
      ],
    }));
    await flushAsync();

    const memberList = member.sentJson.find((msg) => msg.type === 'session_list');
    const sharedList = shared.sentJson.find((msg) => msg.type === 'session_list');
    expect((memberList?.sessions as unknown[])).toHaveLength(2);
    expect(sharedList?.sessions).toEqual([{ name: 'deck_proj_brain', runtimeType: 'transport' }]);
  });

  it('persists and broadcasts share discussion comments without daemon relay', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'server', serverId };
    const auditRows: AuditInsert[] = [];
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'viewer', now));
    const db = makeDb(null, auditRows);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, db, {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', db, {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'viewer', now),
    });

    shared.emit('message', JSON.stringify({
      type: 'discussion.comment',
      requestId: 'comment-1',
      body: 'Human note, not agent input.',
    }));
    await flushAsync();
    await flushAsync();

    expect(daemon.sentJson.some((msg) => msg.type === 'discussion.comment')).toBe(false);
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'discussion.comment.created',
        requestId: 'comment-1',
        targetRef: serverId,
        comment: expect.objectContaining({
          body: 'Human note, not agent input.',
          created_by_user_id: 'shared-user',
        }),
      }),
    ]));
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorUserId: 'shared-user',
        targetKind: 'server',
        targetRef: serverId,
        actionType: 'discussion.comment',
        decision: 'accepted',
        reason: null,
        actionId: 'comment-1',
      }),
    ]));
  });

  it('delivers full share-scoped chat history for the covered target without invite-time cutoff', () => {
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    const delivered = filterShareDaemonMessage({
      type: TRANSPORT_MSG.CHAT_HISTORY,
      sessionId: 'deck_proj_brain',
      messages: [
        { id: 'old', ts: now - 1_001, role: 'user', content: 'before invite' },
        { id: 'visible', ts: now - 999, role: 'assistant', content: 'after invite' },
      ],
    }, {
      userId: 'shared-user',
      target,
      connectedAt: now,
      ticketId: 'share-ticket-1',
      snapshot: coverage(target, 'viewer', now),
    });

    expect(delivered?.messages).toEqual([
      { id: 'old', ts: now - 1_001, role: 'user', content: 'before invite' },
      { id: 'visible', ts: now - 999, role: 'assistant', content: 'after invite' },
    ]);
  });

  it('drops unknown daemon messages for share sockets while preserving member broadcast behavior', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'server', serverId };
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'viewer', now));
    const member = new MockWs();
    const shared = new MockWs();
    bridge.handleBrowserConnection(member as never, 'member-user', makeDb());
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', makeDb(), {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'viewer', now),
    });

    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.emit('message', JSON.stringify({ type: 'unlisted.daemon.message', secret: true }));
    await flushAsync();

    expect(member.sentJson.some((msg) => msg.type === 'unlisted.daemon.message')).toBe(true);
    expect(shared.sentJson.some((msg) => msg.type === 'unlisted.daemon.message')).toBe(false);
  });

  it('forwards a participant queue append and keeps it away from viewers', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'participant', now));
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const participant = new MockWs();
    bridge.handleShareBrowserConnection(participant as never, 'shared-user', makeDb(), {
      ticketId: 'share-ticket-append-participant',
      target,
      snapshot: coverage(target, 'participant', now),
    });
    participant.emit('message', JSON.stringify({
      type: TRANSPORT_QUEUE_COMMANDS.APPEND_MESSAGES,
      commandId: 'cmd-append-participant',
      sessionName: 'deck_proj_brain',
      clientMessageIds: ['queued-1'],
    }));
    await flushAsync();

    // A participant may steer already-queued text into the running turn.
    expect(daemon.sentJson.some((msg) => (
      msg.type === TRANSPORT_QUEUE_COMMANDS.APPEND_MESSAGES && msg.commandId === 'cmd-append-participant'
    ))).toBe(true);

    // A viewer may not, and the denial must carry the commandId so the browser
    // can roll its optimistic queue mutation back instead of silently losing
    // the row: a bare `error` frame has no commandId to match on.
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'viewer', now));
    const viewer = new MockWs();
    bridge.handleShareBrowserConnection(viewer as never, 'viewer-user', makeDb(), {
      ticketId: 'share-ticket-append-viewer',
      target,
      snapshot: coverage(target, 'viewer', now),
    });
    daemon.sent.length = 0;
    viewer.emit('message', JSON.stringify({
      type: TRANSPORT_QUEUE_COMMANDS.APPEND_MESSAGES,
      commandId: 'cmd-append-viewer',
      sessionName: 'deck_proj_brain',
      clientMessageIds: ['queued-1'],
    }));
    await flushAsync();

    expect(viewer.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: MSG_COMMAND_ACK,
        commandId: 'cmd-append-viewer',
        status: 'error',
      }),
    ]));
    expect(daemon.sentJson.some((msg) => msg.type === TRANSPORT_QUEUE_COMMANDS.APPEND_MESSAGES)).toBe(false);
  });

  it('denies unknown commands, terminal resize, and viewer sends before daemon forwarding', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'viewer', now));
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', makeDb(), {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'viewer', now),
    });

    shared.emit('message', JSON.stringify({ type: 'unknown.command', requestId: 'u1' }));
    shared.emit('message', JSON.stringify({ type: 'session.resize', requestId: 'r1', session: 'deck_proj_brain' }));
    shared.emit('message', JSON.stringify({ type: 'session.send', commandId: 'cmd-viewer', sessionName: 'deck_proj_brain' }));
    await flushAsync();

    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'unknown.command' }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'session.resize' }),
      expect.objectContaining({ type: 'command.failed', commandId: 'cmd-viewer', reason: SHARE_REASONS.ROLE_DENIED }),
    ]));
    expect(daemon.sentJson.some((msg) => msg.type === 'unknown.command' || msg.type === 'session.resize' || msg.type === 'session.send')).toBe(false);
  });

  it('keeps the bridge command policy inventory aligned with the shared share policy', () => {
    expect(SHARE_WS_COMMAND_POLICY_INVENTORY.length).toBe(SHARE_SCOPED_COMMAND_POLICY.size);
    expect(new Set(SHARE_WS_COMMAND_POLICY_INVENTORY.map((entry) => entry.bridgeCommand)).size)
      .toBe(SHARE_WS_COMMAND_POLICY_INVENTORY.length);

    for (const entry of SHARE_WS_COMMAND_POLICY_INVENTORY) {
      const actualPolicy = SHARE_SCOPED_COMMAND_POLICY.get(entry.bridgeCommand);
      const sharedPolicy = getShareScopedCommandPolicy(entry.sharedCommand);
      expect(actualPolicy).toEqual(entry.policy);

      if (actualPolicy?.kind === 'deny') {
        if (sharedPolicy.disposition === 'deny') {
          expect(sharedPolicy.reason).toBe(actualPolicy.reason);
        } else {
          // A conceptual surface may be shared while one legacy bridge command
          // for that surface remains intentionally unsupported.
          expect(sharedPolicy.disposition).toBe('allow');
        }
      } else if (
        actualPolicy?.kind === 'participant-send'
        || actualPolicy?.kind === 'participant-model-switch'
        || actualPolicy?.kind === 'participant-model-list'
        || actualPolicy?.kind === 'participant-cancel'
        || actualPolicy?.kind === 'participant-discussion-start'
        || actualPolicy?.kind === 'participant-covered-action'
        || actualPolicy?.kind === 'participant-bound-action'
      ) {
        expect(sharedPolicy).toMatchObject({
          disposition: 'allow',
          minRole: 'participant',
        });
      } else {
        expect(sharedPolicy.disposition).toBe('allow');
        if (actualPolicy?.kind === 'allow-covered-read') {
          expect(actualPolicy.requireTarget).toBe(sharedPolicy.scope === 'concrete-tab');
        }
      }
    }
  });

  it('denies targetless shared terminal and chat read commands before daemon forwarding', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'viewer', now));
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', makeDb(), {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'viewer', now),
    });

    const targetlessReadCommands = [
      'terminal.subscribe',
      'terminal.unsubscribe',
      'terminal.snapshot_request',
      TRANSPORT_MSG.CHAT_SUBSCRIBE,
      TRANSPORT_MSG.CHAT_UNSUBSCRIBE,
      TRANSPORT_MSG.CHAT_HISTORY,
      TIMELINE_MESSAGES.HISTORY_REQUEST,
      TIMELINE_MESSAGES.REPLAY_REQUEST,
      TIMELINE_MESSAGES.PAGE_REQUEST,
      TIMELINE_MESSAGES.DETAIL_REQUEST,
    ];
    for (const [index, type] of targetlessReadCommands.entries()) {
      shared.emit('message', JSON.stringify({ type, requestId: `targetless-${index}` }));
      await flushAsync();
    }

    for (const type of targetlessReadCommands) {
      expect(shared.sentJson).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          code: SHARE_REASONS.DIRECT_SURFACE_DENIED,
          originalType: type,
        }),
      ]));
    }
    expect(daemon.sentJson.some((msg) => targetlessReadCommands.includes(String(msg.type)))).toBe(false);
  });

  it('covers direct-surface bridge commands and denies unknown commands by inventory', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'participant', now));
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', makeDb(), {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'participant', now),
    });

    const deniedCommands = SHARE_WS_COMMAND_POLICY_INVENTORY.filter((entry) => entry.policy.kind === 'deny');
    for (const entry of deniedCommands) {
      shared.emit('message', JSON.stringify({
        type: entry.bridgeCommand,
        requestId: `req-${entry.bridgeCommand}`,
        session: 'deck_proj_brain',
        sessionName: 'deck_proj_brain',
        sessionId: 'deck_proj_brain',
      }));
      await flushAsync();
    }
    shared.emit('message', JSON.stringify({ type: 'future.unclassified.command', requestId: 'unknown-1' }));
    await flushAsync();

    for (const entry of deniedCommands) {
      expect(shared.sentJson).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          code: entry.policy.reason,
          originalType: entry.bridgeCommand,
        }),
      ]));
    }
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'error',
        code: SHARE_REASONS.DIRECT_SURFACE_DENIED,
        originalType: 'future.unclassified.command',
      }),
    ]));
    expect(daemon.sentJson.some((msg) => deniedCommands.some((entry) => entry.bridgeCommand === msg.type) || msg.type === 'future.unclassified.command')).toBe(false);
  });

  it('allows covered participant file operations while keeping unsupported and global repo surfaces denied', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'participant', now));
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', makeDb(), {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'participant', now),
    });

    for (const msg of [
      { type: 'fs.ls', requestId: 'fs-ls-1', sessionName: 'deck_proj_brain', path: '/repo' },
      { type: 'fs.read', requestId: 'fs-read-1', sessionName: 'deck_proj_brain', path: '/repo/a.ts' },
      { type: 'fs.write', requestId: 'fs-write-1', sessionName: 'deck_proj_brain', path: '/repo/a.ts', content: 'x' },
      { type: FS_TRANSPORT_MSG.RENAME, requestId: 'fs-rename-1', sessionName: 'deck_proj_brain', path: '/repo/a.ts', newPath: '/repo/b.ts' },
      { type: 'fs.mkdir', requestId: 'fs-mkdir-1', sessionName: 'deck_proj_brain', path: '/repo/new' },
      { type: 'fs.edit', requestId: 'fs-edit-1', sessionName: 'deck_proj_brain' },
      { type: FS_TRANSPORT_MSG.DELETE, requestId: 'fs-delete-1', sessionName: 'deck_proj_brain', path: '/repo/a.ts' },
      { type: 'fs.patch', requestId: 'fs-patch-1', sessionName: 'deck_proj_brain' },
      { type: 'fs.git_status', requestId: 'git-status-1', sessionName: 'deck_proj_brain', path: '/repo' },
      { type: 'fs.git_diff', requestId: 'git-diff-1', sessionName: 'deck_proj_brain', path: '/repo/a.ts' },
      { type: 'file.search', requestId: 'file-search-1', sessionName: 'deck_proj_brain', projectDir: '/repo', query: 'a' },
      { type: REPO_MSG.DETECT, requestId: 'repo-detect-1' },
      { type: REPO_MSG.LIST_BRANCHES, requestId: 'repo-branches-1' },
      { type: REPO_MSG.CHECKOUT_BRANCH, requestId: 'repo-checkout-1', branch: 'main' },
      { type: REPO_MSG.LIST_COMMITS, requestId: 'repo-commits-1' },
      { type: REPO_MSG.LIST_ISSUES, requestId: 'repo-issues-1' },
      { type: REPO_MSG.LIST_PRS, requestId: 'repo-prs-1' },
      { type: REPO_MSG.LIST_ACTIONS, requestId: 'repo-actions-1' },
      { type: 'memory.skill.query', requestId: 'memory-1' },
      { type: 'provider.sync_sessions', requestId: 'provider-1' },
    ]) {
      shared.emit('message', JSON.stringify(msg));
      await flushAsync();
    }

    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'fs.edit' }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'fs.patch' }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: REPO_MSG.DETECT }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: REPO_MSG.LIST_BRANCHES }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: REPO_MSG.CHECKOUT_BRANCH }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: REPO_MSG.LIST_COMMITS }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: REPO_MSG.LIST_ISSUES }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: REPO_MSG.LIST_PRS }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: REPO_MSG.LIST_ACTIONS }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'memory.skill.query' }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'provider.sync_sessions' }),
    ]));
    expect(daemon.sentJson.some((msg) => [
      'fs.edit',
      'fs.patch',
      REPO_MSG.DETECT,
      REPO_MSG.LIST_BRANCHES,
      REPO_MSG.CHECKOUT_BRANCH,
      REPO_MSG.LIST_COMMITS,
      REPO_MSG.LIST_ISSUES,
      REPO_MSG.LIST_PRS,
      REPO_MSG.LIST_ACTIONS,
      'memory.skill.query',
      'provider.sync_sessions',
    ].includes(String(msg.type)))).toBe(false);
    expect(daemon.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'fs.ls', requestId: 'fs-ls-1', sessionName: 'deck_proj_brain' }),
      expect.objectContaining({ type: 'fs.read', requestId: 'fs-read-1', sessionName: 'deck_proj_brain' }),
      expect.objectContaining({ type: 'fs.write', requestId: 'fs-write-1', sessionName: 'deck_proj_brain' }),
      expect.objectContaining({ type: FS_TRANSPORT_MSG.RENAME, requestId: 'fs-rename-1', sessionName: 'deck_proj_brain' }),
      expect.objectContaining({ type: 'fs.mkdir', requestId: 'fs-mkdir-1', sessionName: 'deck_proj_brain' }),
      expect.objectContaining({ type: FS_TRANSPORT_MSG.DELETE, requestId: 'fs-delete-1', sessionName: 'deck_proj_brain' }),
      expect.objectContaining({ type: 'fs.git_status', requestId: 'git-status-1', sessionName: 'deck_proj_brain' }),
      expect.objectContaining({ type: 'fs.git_diff', requestId: 'git-diff-1', sessionName: 'deck_proj_brain' }),
      expect.objectContaining({ type: 'file.search', requestId: 'file-search-1', sessionName: 'deck_proj_brain' }),
    ]));
  });

  it('allows covered viewer file reads but rejects writes and out-of-scope reads', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'viewer', now));
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'viewer-user', makeDb(), {
      ticketId: 'share-ticket-viewer-files',
      target,
      snapshot: coverage(target, 'viewer', now),
    });
    shared.emit('message', JSON.stringify({ type: 'fs.ls', requestId: 'viewer-list', sessionName: 'deck_proj_brain', path: '/repo' }));
    shared.emit('message', JSON.stringify({ type: 'fs.write', requestId: 'viewer-write', sessionName: 'deck_proj_brain', path: '/repo/a.ts', content: 'x' }));
    shared.emit('message', JSON.stringify({ type: 'fs.read', requestId: 'viewer-outside', sessionName: 'deck_other_brain', path: '/other/a.ts' }));
    await flushAsync();

    expect(daemon.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'fs.ls', requestId: 'viewer-list', sessionName: 'deck_proj_brain' }),
    ]));
    expect(daemon.sentJson.some((msg) => msg.requestId === 'viewer-write' || msg.requestId === 'viewer-outside')).toBe(false);
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.ROLE_DENIED, originalType: 'fs.write' }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'fs.read' }),
    ]));
  });

  it('single-casts covered repository reads and permits checkout only for participants', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'participant', now));
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const participant = new MockWs();
    bridge.handleShareBrowserConnection(participant as never, 'participant-user', makeDb(), {
      ticketId: 'repo-participant', target, snapshot: coverage(target, 'participant', now),
    });
    const member = new MockWs();
    bridge.handleBrowserConnection(member as never, 'member-user', makeDb());
    member.sent.length = 0;

    participant.emit('message', JSON.stringify({
      type: REPO_MSG.DETECT,
      requestId: 'repo-shared-detect',
      projectDir: FS_SESSION_ROOT_PATH,
      sessionName: 'deck_proj_brain',
    }));
    participant.emit('message', JSON.stringify({
      type: REPO_MSG.CHECKOUT_BRANCH,
      requestId: 'repo-shared-checkout',
      projectDir: FS_SESSION_ROOT_PATH,
      sessionId: 'deck_proj_brain',
      branch: 'feature/shared',
    }));
    participant.emit('message', JSON.stringify({
      type: REPO_MSG.LIST_COMMITS,
      requestId: 'repo-host-path-bypass',
      projectDir: '/owner/other-project',
      sessionName: 'deck_proj_brain',
    }));
    await flushAsync();

    expect(daemon.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: REPO_MSG.DETECT, requestId: 'repo-shared-detect' }),
      expect.objectContaining({ type: REPO_MSG.CHECKOUT_BRANCH, requestId: 'repo-shared-checkout' }),
    ]));
    expect(daemon.sentJson.some((msg) => msg.requestId === 'repo-host-path-bypass')).toBe(false);
    expect(participant.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: REPO_MSG.LIST_COMMITS }),
    ]));

    daemon.emit('message', JSON.stringify({
      type: REPO_MSG.DETECT_RESPONSE,
      requestId: 'repo-shared-detect',
      projectDir: '/owner/project',
      status: 'ok',
    }));
    await flushAsync();
    expect(participant.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: REPO_MSG.DETECT_RESPONSE, requestId: 'repo-shared-detect' }),
    ]));
    expect(member.sentJson.some((msg) => msg.requestId === 'repo-shared-detect')).toBe(false);

    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'viewer', now));
    const viewer = new MockWs();
    bridge.handleShareBrowserConnection(viewer as never, 'viewer-user', makeDb(), {
      ticketId: 'repo-viewer', target, snapshot: coverage(target, 'viewer', now),
    });
    viewer.emit('message', JSON.stringify({
      type: REPO_MSG.CHECKOUT_BRANCH,
      requestId: 'repo-viewer-checkout',
      projectDir: FS_SESSION_ROOT_PATH,
      sessionId: 'deck_proj_brain',
      branch: 'main',
    }));
    await flushAsync();
    expect(viewer.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.ROLE_DENIED, originalType: REPO_MSG.CHECKOUT_BRANCH }),
    ]));
  });

  it('allows participant send for a covered concrete tab and stamps a server-authored actor envelope', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'participant', now));
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', makeDb(), {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'participant', now),
    });
    await flushAsync();

    shared.emit('message', JSON.stringify({
      type: 'session.send',
      commandId: 'cmd-participant',
      sessionName: 'deck_proj_brain',
      text: '/model gpt-5.4',
      sharedActor: { actorUserId: 'spoofed' },
    }));
    await flushAsync();

    const forwarded = daemon.sentJson.find((msg) => msg.type === 'session.send');
    expect(forwarded).toMatchObject({
      commandId: 'cmd-participant',
      text: '/model gpt-5.4',
      sharedActor: {
        actorUserId: 'shared-user',
        actorDisplayName: 'Shared User',
        effectiveActorRole: 'participant',
        actionId: 'cmd-participant',
        origin: 'shared-tab',
      },
    });
  });

  it('allows only participants to switch a covered sub-session model and strips client paths', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'subsession', serverId, subSessionId: 'child_1' };
    const auditRows: AuditInsert[] = [];
    const db = makeDb(null, auditRows);
    bridge.setShareCoverageResolverForTests(async ({ userId }) => coverage(
      target,
      userId === 'viewer-user' ? 'viewer' : 'participant',
      now,
    ));
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, db, {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const participant = new MockWs();
    bridge.handleShareBrowserConnection(participant as never, 'participant-user', db, {
      ticketId: 'model-participant',
      target,
      snapshot: coverage(target, 'participant', now),
    });
    await flushAsync();

    participant.emit('message', JSON.stringify({
      type: 'subsession.set_model',
      sessionName: 'deck_sub_child_1',
      model: ' gpt-5.4 ',
      cwd: '/untrusted/browser/path',
    }));
    participant.emit('message', JSON.stringify({
      type: 'subsession.set_model',
      sessionName: 'deck_sub_outside',
      model: 'gpt-5.4',
    }));
    await flushAsync();

    expect(daemon.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'subsession.set_model',
        sessionName: 'deck_sub_child_1',
        model: 'gpt-5.4',
      }),
    ]));
    const forwarded = daemon.sentJson.find((msg) => msg.type === 'subsession.set_model');
    expect(forwarded).not.toHaveProperty('cwd');
    expect(daemon.sentJson.some((msg) => msg.sessionName === 'deck_sub_outside')).toBe(false);
    expect(participant.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'error',
        code: SHARE_REASONS.DIRECT_SURFACE_DENIED,
        originalType: 'subsession.set_model',
      }),
    ]));

    const viewer = new MockWs();
    bridge.handleShareBrowserConnection(viewer as never, 'viewer-user', db, {
      ticketId: 'model-viewer',
      target,
      snapshot: coverage(target, 'viewer', now),
    });
    viewer.emit('message', JSON.stringify({
      type: 'subsession.set_model',
      sessionName: 'deck_sub_child_1',
      model: 'gpt-5.4',
    }));
    await flushAsync();

    expect(viewer.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'error',
        code: SHARE_REASONS.ROLE_DENIED,
        originalType: 'subsession.set_model',
      }),
    ]));
    expect(daemon.sentJson.filter((msg) => msg.type === 'subsession.set_model')).toHaveLength(1);

    participant.emit('message', JSON.stringify({
      type: TRANSPORT_MSG.LIST_MODELS,
      sessionName: 'deck_sub_child_1',
      agentType: 'grok-sdk',
      requestId: 'models-participant',
      force: true,
      ccPreset: 'must-not-cross-share-boundary',
      unexpected: 'drop-me',
    }));
    viewer.emit('message', JSON.stringify({
      type: TRANSPORT_MSG.LIST_MODELS,
      sessionName: 'deck_sub_child_1',
      agentType: 'grok-sdk',
      requestId: 'models-viewer',
    }));
    await flushAsync();

    const modelRequests = daemon.sentJson.filter((msg) => msg.type === TRANSPORT_MSG.LIST_MODELS);
    expect(modelRequests).toEqual([{
      type: TRANSPORT_MSG.LIST_MODELS,
      sessionName: 'deck_sub_child_1',
      agentType: 'grok-sdk',
      requestId: 'models-participant',
      force: true,
    }]);
    participant.sent.length = 0;
    viewer.sent.length = 0;
    daemon.emit('message', JSON.stringify({
      type: TRANSPORT_MSG.MODELS_RESPONSE,
      sessionName: 'deck_sub_child_1',
      agentType: 'grok-sdk',
      requestId: 'models-participant',
      models: [{ id: 'grok-code-fast-1' }],
    }));
    await flushAsync();

    expect(participant.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: TRANSPORT_MSG.MODELS_RESPONSE,
        requestId: 'models-participant',
        models: [{ id: 'grok-code-fast-1' }],
      }),
    ]));
    expect(viewer.sentJson.some((msg) => msg.type === TRANSPORT_MSG.MODELS_RESPONSE)).toBe(false);
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionType: 'session.send', decision: 'accepted', actorUserId: 'participant-user' }),
      expect.objectContaining({ actionType: 'session.send', decision: 'rejected', actorUserId: 'participant-user', reason: SHARE_REASONS.DIRECT_SURFACE_DENIED }),
      expect.objectContaining({ actionType: 'session.send', decision: 'rejected', actorUserId: 'viewer-user', reason: SHARE_REASONS.ROLE_DENIED }),
    ]));
  });

  it('treats a shared main tab as covering its existing child sub-sessions over WS', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'participant', now));
    const db = makeDb('transport', [], {
      subSessions: [{ id: 'child_1', parent_session: 'deck_proj_brain' }],
    });
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, db, {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', db, {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'participant', now),
    });
    await flushAsync();

    shared.emit('message', JSON.stringify({
      type: 'session.send',
      commandId: 'cmd-child',
      sessionName: 'deck_sub_child_1',
      text: 'hello child',
    }));
    await flushAsync();

    expect(daemon.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'session.send',
        commandId: 'cmd-child',
        sessionName: 'deck_sub_child_1',
        sharedActor: expect.objectContaining({ actorUserId: 'shared-user' }),
      }),
    ]));

    shared.emit('message', JSON.stringify({
      type: TRANSPORT_MSG.CHAT_SUBSCRIBE,
      sessionId: 'deck_sub_child_1',
    }));
    await flushAsync();
    shared.sent.length = 0;
    daemon.emit('message', JSON.stringify({
      type: 'chat.delta',
      sessionId: 'deck_sub_child_1',
      text: 'child output',
    }));
    await flushAsync();

    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'chat.delta',
        sessionId: 'deck_sub_child_1',
        text: 'child output',
      }),
    ]));

    const requestId = 'shared-child-history';
    shared.sent.length = 0;
    shared.emit('message', JSON.stringify({
      type: TIMELINE_MESSAGES.HISTORY_REQUEST,
      requestId,
      sessionName: 'deck_sub_child_1',
      limit: 50,
    }));
    await flushAsync();

    expect(daemon.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        requestId,
        sessionName: 'deck_sub_child_1',
      }),
    ]));

    daemon.emit('message', JSON.stringify({
      type: TIMELINE_MESSAGES.HISTORY,
      requestId,
      sessionName: 'deck_sub_child_1',
      epoch: 1,
      events: [{ eventId: 'child-history-1', sessionId: 'deck_sub_child_1', ts: 1, type: 'assistant.text', payload: { text: 'history' } }],
    }));
    await flushAsync();
    await flushAsync();

    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: TIMELINE_MESSAGES.HISTORY,
        requestId,
        sessionName: 'deck_sub_child_1',
        events: [expect.objectContaining({ eventId: 'child-history-1' })],
      }),
    ]));

    daemon.sent.length = 0;
    shared.sent.length = 0;
    shared.emit('message', JSON.stringify({
      type: TIMELINE_MESSAGES.HISTORY_REQUEST,
      requestId: 'outside-history',
      sessionName: 'deck_sub_outside',
    }));
    await flushAsync();

    expect(daemon.sentJson.some((msg) => msg.requestId === 'outside-history')).toBe(false);
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'error',
        code: SHARE_REASONS.DIRECT_SURFACE_DENIED,
        originalType: TIMELINE_MESSAGES.HISTORY_REQUEST,
        requestId: 'outside-history',
      }),
    ]));
  });

  it('validates share-scoped P2P routing extras before participant session.send forwarding', async () => {
    const bridge = WsBridge.get(serverId);
    const tabTarget: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    bridge.setShareCoverageResolverForTests(async ({ target: requested }) => coverage(requested, 'participant', now));
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const tabShare = new MockWs();
    bridge.handleShareBrowserConnection(tabShare as never, 'tab-user', makeDb(), {
      ticketId: 'share-ticket-tab',
      target: tabTarget,
      snapshot: coverage(tabTarget, 'participant', now),
    });

    tabShare.emit('message', JSON.stringify({
      type: 'session.send',
      commandId: 'cmd-p2p-outside',
      sessionName: 'deck_proj_brain',
      text: 'dispatch outside',
      p2pAtTargets: [{ session: 'deck_other_brain', mode: 'review' }],
    }));
    await flushAsync();
    tabShare.emit('message', JSON.stringify({
      type: 'session.send',
      commandId: 'cmd-p2p-implicit',
      sessionName: 'deck_proj_brain',
      text: 'implicit team',
      p2pMode: 'review',
    }));
    await flushAsync();

    expect(tabShare.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'command.failed', commandId: 'cmd-p2p-outside', reason: SHARE_REASONS.DIRECT_SURFACE_DENIED }),
      expect.objectContaining({ type: 'command.failed', commandId: 'cmd-p2p-implicit', reason: SHARE_REASONS.DIRECT_SURFACE_DENIED }),
    ]));
    expect(daemon.sentJson.some((msg) => msg.commandId === 'cmd-p2p-outside' || msg.commandId === 'cmd-p2p-implicit')).toBe(false);

    const serverTarget: ShareTarget = { kind: 'server', serverId };
    const serverShare = new MockWs();
    bridge.handleShareBrowserConnection(serverShare as never, 'server-user', makeDb(), {
      ticketId: 'share-ticket-server',
      target: serverTarget,
      snapshot: coverage(serverTarget, 'participant', now),
    });
    serverShare.emit('message', JSON.stringify({
      type: 'session.send',
      commandId: 'cmd-p2p-server',
      sessionName: 'deck_proj_brain',
      text: 'server-wide team',
      p2pMode: 'review',
    }));
    await flushAsync();
    expect(daemon.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'session.send', commandId: 'cmd-p2p-server', p2pMode: 'review' }),
    ]));

    tabShare.sent.length = 0;
    daemon.emit('message', JSON.stringify({
      type: P2P_WORKFLOW_MSG.RUN_STARTED,
      runId: 'run-covered',
      session: 'deck_proj_brain',
    }));
    await flushAsync();
    expect(tabShare.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: P2P_WORKFLOW_MSG.RUN_STARTED, runId: 'run-covered' }),
    ]));

    tabShare.sent.length = 0;
    daemon.emit('message', JSON.stringify({
      type: P2P_WORKFLOW_MSG.RUN_STARTED,
      runId: 'run-outside',
      session: 'deck_other_brain',
    }));
    await flushAsync();
    expect(tabShare.sentJson.some((msg) => msg.type === P2P_WORKFLOW_MSG.RUN_STARTED)).toBe(false);

    tabShare.sent.length = 0;
    daemon.emit('message', JSON.stringify({
      type: P2P_WORKFLOW_MSG.RUN_UPDATE,
      run: {
        id: 'run-update-covered',
        shareScope: { target: tabTarget },
      },
    }));
    await flushAsync();
    expect(tabShare.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: P2P_WORKFLOW_MSG.RUN_UPDATE }),
    ]));

    tabShare.sent.length = 0;
    daemon.emit('message', JSON.stringify({
      type: P2P_WORKFLOW_MSG.RUN_UPDATE,
      run: {
        id: 'run-update-outside',
        shareScope: { target: { kind: 'main', serverId, sessionName: 'deck_other_brain' } },
      },
    }));
    await flushAsync();
    expect(tabShare.sentJson.some((msg) => msg.type === P2P_WORKFLOW_MSG.RUN_UPDATE)).toBe(false);
  });

  it('allows share participants to start scoped Team discussions and filters scoped discussion broadcasts', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    const otherTarget: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_other_brain' };
    const auditRows: AuditInsert[] = [];
    bridge.setShareCoverageResolverForTests(async ({ target: requested }) => (
      coverage(requested, requested.kind === 'main' && requested.sessionName === 'deck_viewer_brain' ? 'viewer' : 'participant', now)
    ));
    const db = makeDb(null, auditRows);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, db, {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', db, {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'participant', now),
    });
    const otherShared = new MockWs();
    bridge.handleShareBrowserConnection(otherShared as never, 'other-shared-user', db, {
      ticketId: 'share-ticket-2',
      target: otherTarget,
      snapshot: coverage(otherTarget, 'participant', now),
    });
    const member = new MockWs();
    bridge.handleBrowserConnection(member as never, 'member-user', db);

    shared.emit('message', JSON.stringify({
      type: 'discussion.start',
      requestId: 'disc-1',
      topic: 'Scoped discussion',
      cwd: '/tmp/project',
      participants: [
        { agentType: 'codex', roleId: 'review', sessionName: 'deck_proj_brain' },
        { agentType: 'codex', roleId: 'plan', sessionName: 'deck_proj_brain' },
      ],
      sharedActor: { actorUserId: 'spoofed' },
    }));
    await flushAsync();

    const forwarded = daemon.sentJson.find((msg) => msg.type === 'discussion.start');
    expect(forwarded).toMatchObject({
      requestId: 'disc-1',
      sharedActor: {
        actorUserId: 'shared-user',
        effectiveActorRole: 'participant',
        actionId: 'disc-1',
        origin: 'shared-tab',
      },
      shareScope: {
        target,
        primaryShareId: 'share-1',
      },
    });
    expect((forwarded?.participants as unknown[])).toHaveLength(2);
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorUserId: 'shared-user',
        effectiveActorRole: 'participant',
        targetKind: 'main',
        targetRef: 'deck_proj_brain',
        actionType: 'p2p.orchestration',
        decision: 'accepted',
        reason: null,
        actionId: 'disc-1',
      }),
    ]));

    shared.sent.length = 0;
    otherShared.sent.length = 0;
    member.sent.length = 0;
    daemon.emit('message', JSON.stringify({
      type: 'discussion.started',
      requestId: 'disc-1',
      discussionId: 'discussion-1',
      topic: 'Scoped discussion',
      maxRounds: 2,
      filePath: '',
      participants: [],
      sharedActor: forwarded?.sharedActor,
      shareScope: forwarded?.shareScope,
    }));
    await flushAsync();

    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'discussion.started', discussionId: 'discussion-1' }),
    ]));
    expect(member.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'discussion.started', discussionId: 'discussion-1' }),
    ]));
    expect(otherShared.sentJson.some((msg) => msg.type === 'discussion.started')).toBe(false);
  });

  it('allows participants to save only covered Team config and denies viewers or outside session entries', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    const auditRows: AuditInsert[] = [];
    let role: 'viewer' | 'participant' = 'participant';
    bridge.setShareCoverageResolverForTests(async () => coverage(target, role, now));
    const db = makeDb(null, auditRows, {
      subSessions: [{ id: 'child_1', parent_session: 'deck_proj_brain' }],
    });
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, db, {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const participant = new MockWs();
    bridge.handleShareBrowserConnection(participant as never, 'participant-user', db, {
      ticketId: 'share-team-config',
      target,
      snapshot: coverage(target, 'participant', now),
    });
    participant.emit('message', JSON.stringify({
      type: P2P_CONFIG_MSG.SAVE,
      requestId: 'team-config-covered',
      scopeSession: 'deck_proj_brain',
      config: {
        sessions: { deck_sub_child_1: { enabled: true, mode: 'review' } },
        rounds: 2,
      },
      sharedActor: { actorUserId: 'spoofed' },
      unexpected: 'drop-me',
    }));
    await flushAsync();

    expect(daemon.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: P2P_CONFIG_MSG.SAVE,
        requestId: 'team-config-covered',
        scopeSession: 'deck_proj_brain',
        config: {
          sessions: { deck_sub_child_1: { enabled: true, mode: 'review' } },
          rounds: 2,
        },
      }),
    ]));
    const forwarded = daemon.sentJson.find((msg) => msg.requestId === 'team-config-covered');
    expect(forwarded).not.toHaveProperty('unexpected');
    expect(forwarded).not.toHaveProperty('sharedActor');
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorUserId: 'participant-user',
        actionType: 'p2p.orchestration',
        decision: 'accepted',
        actionId: 'team-config-covered',
      }),
    ]));

    daemon.sent.length = 0;
    participant.emit('message', JSON.stringify({
      type: P2P_CONFIG_MSG.SAVE,
      requestId: 'team-config-outside',
      scopeSession: 'deck_proj_brain',
      config: {
        sessions: { deck_other_worker: { enabled: true, mode: 'review' } },
        rounds: 1,
      },
    }));
    await flushAsync();
    expect(participant.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'error',
        code: SHARE_REASONS.DIRECT_SURFACE_DENIED,
        originalType: P2P_CONFIG_MSG.SAVE,
      }),
    ]));
    expect(daemon.sentJson.some((msg) => msg.requestId === 'team-config-outside')).toBe(false);

    participant.emit('message', JSON.stringify({
      type: P2P_CONFIG_MSG.SAVE,
      requestId: 'team-config-nested-outside',
      scopeSession: 'deck_proj_brain',
      config: {
        sessions: {},
        rounds: 1,
        workflowDraft: {
          participants: [{ sessionName: 'deck_other_worker' }],
        },
      },
    }));
    await flushAsync();
    expect(participant.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'error',
        code: SHARE_REASONS.DIRECT_SURFACE_DENIED,
        originalType: P2P_CONFIG_MSG.SAVE,
        requestId: 'team-config-nested-outside',
      }),
    ]));
    expect(daemon.sentJson.some((msg) => msg.requestId === 'team-config-nested-outside')).toBe(false);

    role = 'viewer';
    now += 1;
    const viewer = new MockWs();
    bridge.handleShareBrowserConnection(viewer as never, 'viewer-user', db, {
      ticketId: 'share-team-config-viewer',
      target,
      snapshot: coverage(target, 'viewer', now),
    });
    viewer.emit('message', JSON.stringify({
      type: P2P_CONFIG_MSG.SAVE,
      requestId: 'team-config-viewer',
      scopeSession: 'deck_proj_brain',
      config: { sessions: {}, rounds: 1 },
    }));
    await flushAsync();
    expect(viewer.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'error',
        code: SHARE_REASONS.ROLE_DENIED,
        originalType: P2P_CONFIG_MSG.SAVE,
      }),
    ]));
    expect(daemon.sentJson.some((msg) => msg.requestId === 'team-config-viewer')).toBe(false);
  });

  it('denies viewer and out-of-scope share Team discussion starts before daemon forwarding', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    const auditRows: AuditInsert[] = [];
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'viewer', now));
    const db = makeDb(null, auditRows);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, db, {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const viewer = new MockWs();
    bridge.handleShareBrowserConnection(viewer as never, 'viewer-user', db, {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'viewer', now),
    });
    viewer.emit('message', JSON.stringify({
      type: 'discussion.start',
      requestId: 'disc-viewer',
      topic: 'Denied viewer discussion',
      cwd: '/tmp/project',
      participants: [
        { agentType: 'codex', roleId: 'review', sessionName: 'deck_proj_brain' },
        { agentType: 'codex', roleId: 'plan' },
      ],
    }));
    await flushAsync();
    expect(viewer.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.ROLE_DENIED, originalType: 'discussion.start' }),
    ]));
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorUserId: 'viewer-user',
        actionType: 'p2p.orchestration',
        decision: 'rejected',
        reason: SHARE_REASONS.ROLE_DENIED,
        actionId: 'disc-viewer',
      }),
    ]));

    now += 1;
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'participant', now));
    const participant = new MockWs();
    bridge.handleShareBrowserConnection(participant as never, 'participant-user', db, {
      ticketId: 'share-ticket-2',
      target,
      snapshot: coverage(target, 'participant', now),
    });
    participant.emit('message', JSON.stringify({
      type: 'discussion.start',
      requestId: 'disc-outside',
      topic: 'Outside target',
      cwd: '/tmp/project',
      participants: [
        { agentType: 'codex', roleId: 'review', sessionName: 'deck_other_brain' },
        { agentType: 'codex', roleId: 'plan' },
      ],
    }));
    await flushAsync();
    expect(participant.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'discussion.start' }),
    ]));
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorUserId: 'participant-user',
        actionType: 'p2p.orchestration',
        decision: 'rejected',
        reason: SHARE_REASONS.DIRECT_SURFACE_DENIED,
        actionId: 'disc-outside',
      }),
    ]));
    expect(daemon.sentJson.some((msg) => msg.type === 'discussion.start')).toBe(false);
  });

  it('rate-limits share participant sends by per-actor pending depth before daemon forwarding', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    const auditRows: AuditInsert[] = [];
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'participant', now));
    const db = makeDb(null, auditRows);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, db, {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', db, {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'participant', now),
    });

    for (let index = 0; index < 11; index += 1) {
      shared.emit('message', JSON.stringify({
        type: 'session.send',
        commandId: `cmd-${index}`,
        sessionName: 'deck_proj_brain',
        text: `message ${index}`,
      }));
      await flushAsync();
    }

    expect(daemon.sentJson.filter((msg) => msg.type === 'session.send')).toHaveLength(10);
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'command.failed',
        commandId: 'cmd-10',
        reason: SHARE_REASONS.RATE_LIMITED,
      }),
    ]));
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorUserId: 'shared-user',
        targetKind: 'main',
        targetRef: 'deck_proj_brain',
        actionType: 'session.send',
        decision: 'accepted',
        reason: null,
        actionId: 'cmd-0',
      }),
      expect.objectContaining({
        actorUserId: 'shared-user',
        targetKind: 'main',
        targetRef: 'deck_proj_brain',
        actionType: 'session.send',
        decision: 'rejected',
        reason: SHARE_REASONS.RATE_LIMITED,
        actionId: 'cmd-10',
      }),
    ]));
    expect(daemon.sentJson.some((msg) => msg.commandId === 'cmd-10')).toBe(false);
  });

  it('rate-limits share participant cancel attempts separately from sends', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    const auditRows: AuditInsert[] = [];
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'participant', now));
    const db = makeDb('transport', auditRows);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, db, {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.emit('message', JSON.stringify({
      type: 'session_list',
      sessions: [{ name: 'deck_proj_brain', runtimeType: 'transport' }],
    }));
    await flushAsync();
    daemon.sent.length = 0;

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', db, {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'participant', now),
    });
    shared.emit('message', JSON.stringify({ type: 'session.send', commandId: 'cmd-active', sessionName: 'deck_proj_brain', text: 'run' }));
    await flushAsync();

    for (let index = 0; index < 11; index += 1) {
      shared.emit('message', JSON.stringify({
        type: 'session.cancel',
        commandId: `cancel-${index}`,
        sessionName: 'deck_proj_brain',
        observedDispatchId: 'cmd-active',
      }));
      await flushAsync();
    }

    expect(daemon.sentJson.filter((msg) => msg.type === 'session.cancel')).toHaveLength(10);
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'command.failed',
        commandId: 'cancel-10',
        reason: SHARE_REASONS.RATE_LIMITED,
      }),
    ]));
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorUserId: 'shared-user',
        targetKind: 'main',
        targetRef: 'deck_proj_brain',
        actionType: 'session.cancel',
        decision: 'accepted',
        reason: null,
        actionId: 'cancel-0',
      }),
      expect.objectContaining({
        actorUserId: 'shared-user',
        targetKind: 'main',
        targetRef: 'deck_proj_brain',
        actionType: 'session.cancel',
        decision: 'rejected',
        reason: SHARE_REASONS.RATE_LIMITED,
        actionId: 'cancel-10',
      }),
    ]));
    expect(daemon.sentJson.some((msg) => msg.commandId === 'cancel-10')).toBe(false);
  });

  it('enforces transport cancel observedDispatchId and process cancel unsupported', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    bridge.setShareCoverageResolverForTests(async () => coverage(target, 'participant', now));
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.emit('message', JSON.stringify({
      type: 'session_list',
      sessions: [{ name: 'deck_proj_brain', runtimeType: 'transport' }],
    }));
    await flushAsync();
    daemon.sent.length = 0;

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', makeDb(), {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'participant', now),
    });
    shared.emit('message', JSON.stringify({ type: 'session.send', commandId: 'cmd-active', sessionName: 'deck_proj_brain', text: 'run' }));
    await flushAsync();

    shared.emit('message', JSON.stringify({ type: 'session.cancel', commandId: 'cancel-stale', sessionName: 'deck_proj_brain', observedDispatchId: 'wrong' }));
    await flushAsync();
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'command.failed', commandId: 'cancel-stale', reason: SHARE_REASONS.TARGET_UNAVAILABLE }),
    ]));
    expect(daemon.sentJson.some((msg) => msg.commandId === 'cancel-stale')).toBe(false);

    shared.emit('message', JSON.stringify({ type: 'session.cancel', commandId: 'cancel-ok', sessionName: 'deck_proj_brain', observedDispatchId: 'cmd-active' }));
    await flushAsync();
    expect(daemon.sentJson.some((msg) => msg.type === 'session.cancel' && msg.commandId === 'cancel-ok')).toBe(true);

    daemon.emit('message', JSON.stringify({
      type: 'session_list',
      sessions: [{ name: 'deck_proj_brain', runtimeType: 'process' }],
    }));
    await flushAsync();
    shared.emit('message', JSON.stringify({ type: 'session.cancel', commandId: 'cancel-process', sessionName: 'deck_proj_brain', observedDispatchId: 'cmd-active' }));
    await flushAsync();
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'command.failed', commandId: 'cancel-process', reason: SHARE_REASONS.CANCEL_UNSUPPORTED }),
    ]));
  });

  it('sweeps expired share sockets and stops later delivery', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    let live = true;
    bridge.setShareCoverageResolverForTests(async () => live ? coverage(target, 'viewer', now, now + 10) : null);
    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', makeDb(), {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'viewer', now, now + 10),
    });

    now += 11;
    live = false;
    await bridge.sweepShareSocketsForTests();

    expect(shared.closed).toBe(true);
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'share.teardown', reason: SHARE_REASONS.EXPIRED }),
    ]));
  });

  it('rejects stale share commands after revoke or target deletion before daemon forwarding', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    let liveCoverage: EffectiveCoverage | null = coverage(target, 'participant', now);
    bridge.setShareCoverageResolverForTests(async () => liveCoverage);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb('transport'), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', makeDb('transport'), {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'participant', now),
    });

    liveCoverage = null;
    shared.emit('message', JSON.stringify({ type: 'session.send', commandId: 'cmd-after-revoke', sessionName: 'deck_proj_brain', text: 'run' }));
    await flushAsync();

    expect(shared.closed).toBe(true);
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'command.failed', commandId: 'cmd-after-revoke', reason: SHARE_REASONS.REVOKED }),
    ]));
    expect(daemon.sentJson.some((msg) => msg.commandId === 'cmd-after-revoke')).toBe(false);
  });

  it('rejects stale share commands after role downgrade without closing the socket', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    let liveCoverage = coverage(target, 'participant', now);
    bridge.setShareCoverageResolverForTests(async () => liveCoverage);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb('transport'), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', makeDb('transport'), {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'participant', now),
    });

    liveCoverage = coverage(target, 'viewer', now);
    shared.emit('message', JSON.stringify({ type: 'session.send', commandId: 'cmd-after-downgrade', sessionName: 'deck_proj_brain', text: 'run' }));
    await flushAsync();

    expect(shared.closed).toBe(false);
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'share.role_changed', reason: SHARE_REASONS.ROLE_CHANGED, effectiveRole: 'viewer' }),
      expect.objectContaining({ type: 'command.failed', commandId: 'cmd-after-downgrade', reason: SHARE_REASONS.ROLE_DENIED }),
    ]));
    expect(daemon.sentJson.some((msg) => msg.commandId === 'cmd-after-downgrade')).toBe(false);
  });

  it('proactively revalidates share sockets for manager-driven role changes and revokes', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    let liveCoverage: EffectiveCoverage | null = coverage(target, 'participant', now);
    bridge.setShareCoverageResolverForTests(async () => liveCoverage);
    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', makeDb('transport'), {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'participant', now),
    });

    liveCoverage = coverage(target, 'viewer', now);
    await bridge.revalidateShareSocketsForUser('shared-user');

    expect(shared.closed).toBe(false);
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'share.role_changed', reason: SHARE_REASONS.ROLE_CHANGED, effectiveRole: 'viewer' }),
    ]));

    liveCoverage = null;
    await bridge.revalidateShareSocketsForUser('shared-user');

    expect(shared.closed).toBe(true);
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'share.teardown', reason: SHARE_REASONS.REVOKED }),
    ]));
  });

  it('proactively revalidates only sockets covered by a deleted concrete target', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    const otherTarget: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_other_brain' };
    const live = new Map<string, EffectiveCoverage | null>([
      [shareTargetKey(target), coverage(target, 'participant', now)],
      [shareTargetKey(otherTarget), coverage(otherTarget, 'participant', now)],
    ]);
    bridge.setShareCoverageResolverForTests(async ({ target: requested }) => live.get(shareTargetKey(requested)) ?? null);

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', makeDb('transport'), {
      ticketId: 'share-ticket-1',
      target,
      snapshot: coverage(target, 'participant', now),
    });
    const otherShared = new MockWs();
    bridge.handleShareBrowserConnection(otherShared as never, 'other-shared-user', makeDb('transport'), {
      ticketId: 'share-ticket-2',
      target: otherTarget,
      snapshot: coverage(otherTarget, 'participant', now),
    });

    live.set(shareTargetKey(target), null);
    await bridge.revalidateShareSocketsForTarget(target);

    expect(shared.closed).toBe(true);
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'share.teardown', reason: SHARE_REASONS.REVOKED }),
    ]));
    expect(otherShared.closed).toBe(false);
    expect(otherShared.sentJson.some((msg) => msg.type === 'share.teardown')).toBe(false);
  });

  it('stops an idle shared terminal stream on expiry sweep within the bridge interval', async () => {
    const bridge = WsBridge.get(serverId);
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    let liveCoverage: EffectiveCoverage | null = coverage(target, 'viewer', now, now + 30_000);
    bridge.setShareCoverageResolverForTests(async () => liveCoverage);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const shared = new MockWs();
    bridge.handleShareBrowserConnection(shared as never, 'shared-user', makeDb(), {
      ticketId: 'share-ticket-terminal',
      target,
      snapshot: coverage(target, 'viewer', now, now + 30_000),
    });
    shared.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_proj_brain', raw: true }));
    await flushAsync();

    daemon.emit('message', JSON.stringify({ type: 'terminal_update', diff: { sessionName: 'deck_proj_brain', text: 'after invite' } }));
    await flushAsync();
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terminal.diff', diff: expect.objectContaining({ text: 'after invite' }) }),
    ]));

    shared.sent.length = 0;
    daemon.sent.length = 0;
    now += 30_000;
    liveCoverage = null;
    await bridge.sweepShareSocketsForTests();

    expect(shared.closed).toBe(true);
    expect(shared.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'share.teardown', reason: SHARE_REASONS.EXPIRED }),
    ]));
    expect(daemon.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terminal.unsubscribe', session: 'deck_proj_brain' }),
    ]));

    shared.sent.length = 0;
    daemon.emit('message', JSON.stringify({ type: 'terminal_update', diff: { sessionName: 'deck_proj_brain', text: 'too late' } }));
    await flushAsync();
    expect(shared.sentJson.some((msg) => msg.type === 'terminal.diff')).toBe(false);
  });

  it('does not apply share direct-surface denials to ordinary member sockets', async () => {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    daemon.sent.length = 0;

    const member = new MockWs();
    bridge.handleBrowserConnection(member as never, 'member-user', makeDb());
    member.emit('message', JSON.stringify({ type: 'session.resize', sessionName: 'deck_proj_brain', cols: 120, rows: 30 }));
    member.emit('message', JSON.stringify({ type: 'fs.ls', requestId: 'member-fs-ls', path: '/repo' }));
    member.emit('message', JSON.stringify({ type: 'fs.git_status', requestId: 'member-git-status', projectDir: '/repo' }));
    await flushAsync();

    expect(member.sentJson.some((msg) => msg.code === SHARE_REASONS.DIRECT_SURFACE_DENIED)).toBe(false);
    expect(daemon.sentJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'session.resize', sessionName: 'deck_proj_brain', cols: 120, rows: 30 }),
      expect.objectContaining({ type: 'fs.ls', requestId: 'member-fs-ls', path: '/repo' }),
      expect.objectContaining({ type: 'fs.git_status', requestId: 'member-git-status', projectDir: '/repo' }),
    ]));
  });
});
