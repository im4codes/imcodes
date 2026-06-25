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
  filterShareDaemonMessage,
  shareTargetKey,
  type EffectiveCoverage,
  type ShareTarget,
} from '../src/ws/share-policy.js';
import { TRANSPORT_MSG } from '../../shared/transport-events.js';
import { FS_TRANSPORT_MSG } from '../../shared/fs-transport-messages.js';
import { P2P_WORKFLOW_MSG } from '../../shared/p2p-workflow-messages.js';
import { getShareScopedCommandPolicy } from '../../shared/tab-sharing.js';
import { REPO_MSG } from '../../shared/repo-types.js';
import { resetSharedCommandRateLimitsForTests } from '../src/share/share-rate-limit.js';

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
        expect(sharedPolicy).toMatchObject({
          disposition: 'deny',
          reason: actualPolicy.reason,
        });
      } else if (
        actualPolicy?.kind === 'participant-send'
        || actualPolicy?.kind === 'participant-cancel'
        || actualPolicy?.kind === 'participant-discussion-start'
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

  it('denies direct filesystem, repo, memory, and provider surfaces before request registration or daemon forwarding', async () => {
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
      { type: 'fs.ls', requestId: 'fs-ls-1', session: 'deck_proj_brain' },
      { type: 'fs.read', requestId: 'fs-read-1', session: 'deck_proj_brain' },
      { type: 'fs.write', requestId: 'fs-write-1', session: 'deck_proj_brain' },
      { type: FS_TRANSPORT_MSG.RENAME, requestId: 'fs-rename-1', session: 'deck_proj_brain' },
      { type: 'fs.edit', requestId: 'fs-edit-1', session: 'deck_proj_brain' },
      { type: 'fs.delete', requestId: 'fs-delete-1', session: 'deck_proj_brain' },
      { type: 'fs.patch', requestId: 'fs-patch-1', session: 'deck_proj_brain' },
      { type: 'fs.git_status', requestId: 'git-status-1', session: 'deck_proj_brain' },
      { type: 'fs.git_diff', requestId: 'git-diff-1', session: 'deck_proj_brain' },
      { type: 'file.search', requestId: 'file-search-1', session: 'deck_proj_brain' },
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
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'fs.ls' }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'fs.read' }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'fs.write' }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: FS_TRANSPORT_MSG.RENAME }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'fs.edit' }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'fs.delete' }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'fs.patch' }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'fs.git_status' }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'fs.git_diff' }),
      expect.objectContaining({ type: 'error', code: SHARE_REASONS.DIRECT_SURFACE_DENIED, originalType: 'file.search' }),
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
      'fs.ls',
      'fs.read',
      'fs.write',
      FS_TRANSPORT_MSG.RENAME,
      'fs.edit',
      'fs.delete',
      'fs.patch',
      'fs.git_status',
      'fs.git_diff',
      'file.search',
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
      text: 'hello',
      sharedActor: { actorUserId: 'spoofed' },
    }));
    await flushAsync();

    const forwarded = daemon.sentJson.find((msg) => msg.type === 'session.send');
    expect(forwarded).toMatchObject({
      commandId: 'cmd-participant',
      sharedActor: {
        actorUserId: 'shared-user',
        actorDisplayName: 'Shared User',
        effectiveActorRole: 'participant',
        actionId: 'cmd-participant',
        origin: 'shared-tab',
      },
    });
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
