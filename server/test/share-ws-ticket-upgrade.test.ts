import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { setupWebSocketUpgrade } from '../src/index.js';
import { signJwt } from '../src/security/crypto.js';
import { WsBridge } from '../src/ws/bridge.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import type { ShareAuthorizationSnapshot, ShareTarget } from '../../shared/tab-sharing.js';

type ConnectResult = { opened: true; ws: WebSocket } | { opened: false; statusCode?: number };

type ShareRowInput = {
  id: string;
  target: ShareTarget;
  targetUserId: string;
  role: 'viewer' | 'participant';
  createdAt?: number;
  expiresAt?: number | null;
  revokedAt?: number | null;
};

type ShareDbOptions = {
  shares?: ShareRowInput[];
  existingSessions?: string[];
  existingSubSessions?: string[];
  memberUserIds?: string[];
};

function makeDb(serverId: string, options: ShareDbOptions = {}): Database {
  const shares = options.shares ?? [{
    id: 'share-1',
    target: { kind: 'server' as const, serverId },
    targetUserId: 'share-user',
    role: 'viewer' as const,
    createdAt: 1_000,
    expiresAt: null,
    revokedAt: null,
  }];
  const existingSessions = new Set(options.existingSessions ?? ['deck_proj_brain']);
  const existingSubSessions = new Set(options.existingSubSessions ?? ['sub-1']);
  const memberUserIds = new Set(options.memberUserIds ?? ['member-user']);
  return {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (normalized.includes('select exists (select 1 from servers where id = $1)')) {
        return { exists: params[0] === serverId } as T;
      }
      if (normalized.includes('select exists (select 1 from sessions where server_id = $1 and name = $2)')) {
        return { exists: params[0] === serverId && existingSessions.has(String(params[1])) } as T;
      }
      if (normalized.includes('select exists (select 1 from sub_sessions where server_id = $1 and id = $2')) {
        return { exists: params[0] === serverId && existingSubSessions.has(String(params[1])) } as T;
      }
      if (normalized.includes('select team_id, user_id from servers where id = $1')) {
        return { team_id: null, user_id: 'member-user' } as T;
      }
      if (normalized.includes('runtime_type')) return { runtime_type: 'transport' } as T;
      return null;
    },
    query: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (normalized.includes('from team_members')) return [] as T[];
      if (normalized.includes('from server_shares') || normalized.includes('from session_shares') || normalized.includes('from sub_session_shares')) {
        const now = Number(params[0]);
        const userId = String(params[1]);
        const requestedServerId = String(params[2]);
        const sessionName = params[3] == null ? null : String(params[3]);
        const rows = shares
          .filter((share) => share.targetUserId === userId && share.target.serverId === requestedServerId)
          .filter((share) => share.revokedAt == null && (share.expiresAt == null || share.expiresAt > now))
          .filter((share) => {
            if (normalized.includes('from session_shares')) return share.target.kind === 'main' && share.target.sessionName === sessionName;
            if (normalized.includes('from sub_session_shares')) return share.target.kind === 'subsession' && share.target.subSessionId === sessionName;
            return share.target.kind === 'server';
          })
          .map(toDbShareRow);
        return rows as T[];
      }
      if (normalized.includes('from users') && params[0] && memberUserIds.has(String(params[0]))) return [{ id: params[0] }] as T[];
      return [];
    },
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;
}

function toDbShareRow(share: ShareRowInput) {
  return {
    target_kind: share.target.kind,
    id: share.id,
    server_id: share.target.serverId,
    session_name: share.target.kind === 'main' ? share.target.sessionName : null,
    sub_session_id: share.target.kind === 'subsession' ? share.target.subSessionId : null,
    target_user_id: share.targetUserId,
    role: share.role,
    created_by: 'member-user',
    created_at: share.createdAt ?? 1_000,
    updated_at: share.createdAt ?? 1_000,
    expires_at: share.expiresAt ?? null,
    revoked_at: share.revokedAt ?? null,
  };
}

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '0',
    NODE_ENV: 'development',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
  } as Env;
}

function connect(url: string): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    const done = (result: ConnectResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    ws.on('unexpected-response', (_req, res) => done({ opened: false, statusCode: res.statusCode }));
    ws.on('error', () => done({ opened: false }));
    ws.on('open', () => done({ opened: true, ws }));
    setTimeout(() => done({ opened: false }), 2_000);
  });
}

function snapshotFor(target: ShareTarget, overrides: Partial<ShareAuthorizationSnapshot> = {}): ShareAuthorizationSnapshot {
  return {
    target,
    effectiveRole: 'viewer',
    historyCutoffAt: 1_000,
    nextCoverageRecheckAt: null,
    coveringShareIds: ['share-1'],
    primaryShareId: 'share-1',
    authorizedAt: Date.now(),
    ...overrides,
  };
}

function shareTicket(env: Env, claims: {
  serverId: string;
  sub?: string;
  jti?: string;
  target: unknown;
  snapshot?: unknown;
  issuedAt?: number;
  expiresAt?: number;
  jwtTtlSeconds?: number;
}): string {
  return signJwt({
    type: 'share-ws-ticket',
    sub: claims.sub ?? 'share-user',
    jti: claims.jti ?? `share-jti-${Math.random().toString(36).slice(2)}`,
    serverId: claims.serverId,
    target: claims.target,
    snapshot: claims.snapshot ?? snapshotFor(claims.target as ShareTarget),
    issuedAt: claims.issuedAt ?? Date.now(),
    expiresAt: claims.expiresAt ?? Date.now() + 30_000,
  }, env.JWT_SIGNING_KEY, claims.jwtTtlSeconds ?? 30);
}

function wsUrl(port: number, serverId: string, ticket: string): string {
  return `ws://127.0.0.1:${port}/api/server/${serverId}/ws?ticket=${encodeURIComponent(ticket)}`;
}

describe('share websocket ticket upgrade semantics', () => {
  let httpServer: HttpServer;
  let port: number;
  let serverId: string;
  let env: Env;

  beforeEach(async () => {
    serverId = `srv-share-ticket-${Math.random().toString(36).slice(2)}`;
    env = makeEnv(makeDb(serverId));
    httpServer = createServer();
    setupWebSocketUpgrade(httpServer, env);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    port = (httpServer.address() as { port: number }).port;
  });

  afterEach(async () => {
    WsBridge.getAll().clear();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('allows the same unexpired share ticket to reconnect while member tickets remain single-use', async () => {
    const target: ShareTarget = { kind: 'server', serverId };
    const reusableShareTicket = shareTicket(env, {
      serverId,
      jti: `share-jti-${serverId}`,
      target,
      snapshot: snapshotFor(target),
    });
    const memberTicket = signJwt({
      type: 'ws-ticket',
      sub: 'member-user',
      sid: serverId,
      jti: `member-jti-${serverId}`,
    }, env.JWT_SIGNING_KEY, 30);

    const shareUrl = wsUrl(port, serverId, reusableShareTicket);
    const shareFirst = await connect(shareUrl);
    expect(shareFirst.opened).toBe(true);
    if (shareFirst.opened) shareFirst.ws.close();
    const shareSecond = await connect(shareUrl);
    expect(shareSecond.opened).toBe(true);
    if (shareSecond.opened) shareSecond.ws.close();

    const memberUrl = `ws://127.0.0.1:${port}/api/server/${serverId}/ws?ticket=${encodeURIComponent(memberTicket)}`;
    const memberFirst = await connect(memberUrl);
    expect(memberFirst.opened).toBe(true);
    if (memberFirst.opened) memberFirst.ws.close();
    const memberSecond = await connect(memberUrl);
    expect(memberSecond.opened).toBe(false);
    if (!memberSecond.opened) expect(memberSecond.statusCode).toBe(401);
  });

  it('admits share-only concrete main-tab and sub-session tickets without server membership', async () => {
    const mainTarget: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    env = makeEnv(makeDb(serverId, {
      shares: [
        { id: 'main-share', target: mainTarget, targetUserId: 'share-user', role: 'participant' },
      ],
      memberUserIds: ['member-user'],
      existingSessions: ['deck_proj_brain'],
    }));
    httpServer.close();
    await new Promise<void>((resolve) => httpServer.once('close', resolve));
    httpServer = createServer();
    setupWebSocketUpgrade(httpServer, env);
    await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve()));

    const mainConnect = await connect(wsUrl(port, serverId, shareTicket(env, {
      serverId,
      target: mainTarget,
      snapshot: snapshotFor(mainTarget, { effectiveRole: 'participant', coveringShareIds: ['main-share'], primaryShareId: 'main-share' }),
    })));
    expect(mainConnect.opened).toBe(true);
    if (mainConnect.opened) mainConnect.ws.close();

    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    const subTarget: ShareTarget = { kind: 'subsession', serverId, subSessionId: 'sub-1' };
    env = makeEnv(makeDb(serverId, {
      shares: [
        { id: 'sub-share', target: subTarget, targetUserId: 'share-user', role: 'viewer' },
      ],
      memberUserIds: ['member-user'],
      existingSubSessions: ['sub-1'],
    }));
    httpServer = createServer();
    setupWebSocketUpgrade(httpServer, env);
    await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve()));

    const subConnect = await connect(wsUrl(port, serverId, shareTicket(env, {
      serverId,
      target: subTarget,
      snapshot: snapshotFor(subTarget, { coveringShareIds: ['sub-share'], primaryShareId: 'sub-share' }),
    })));
    expect(subConnect.opened).toBe(true);
    if (subConnect.opened) subConnect.ws.close();
  });

  it('rejects malformed, target-mismatched, expired, revoked, and target-unavailable share tickets before upgrade', async () => {
    const target: ShareTarget = { kind: 'server', serverId };
    const validSnapshot = snapshotFor(target);
    const malformedTargetTicket = shareTicket(env, {
      serverId,
      target: { kind: 'subsession', serverId, sessionName: 'not-a-deck-sub-name' },
      snapshot: validSnapshot,
    });
    const mismatchedSnapshotTicket = shareTicket(env, {
      serverId,
      target,
      snapshot: snapshotFor({ kind: 'main', serverId, sessionName: 'deck_proj_brain' }),
    });
    const serverMismatchedTicket = shareTicket(env, {
      serverId: `${serverId}-other`,
      target: { kind: 'server', serverId: `${serverId}-other` },
      snapshot: snapshotFor({ kind: 'server', serverId: `${serverId}-other` }),
    });
    const expiredTopLevelTicket = shareTicket(env, {
      serverId,
      target,
      snapshot: validSnapshot,
      expiresAt: Date.now() - 1,
    });
    const revokedLiveCoverageTicket = shareTicket(env, {
      serverId,
      sub: 'revoked-share-user',
      target,
      snapshot: validSnapshot,
    });
    const missingTarget: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_missing_brain' };
    const missingTargetTicket = shareTicket(env, {
      serverId,
      target: missingTarget,
      snapshot: snapshotFor(missingTarget),
    });

    for (const [ticket, statusCode] of [
      [malformedTargetTicket, 401],
      [mismatchedSnapshotTicket, 401],
      [serverMismatchedTicket, 401],
      [expiredTopLevelTicket, 401],
      [revokedLiveCoverageTicket, 403],
      [missingTargetTicket, 403],
    ] as const) {
      const result = await connect(wsUrl(port, serverId, ticket));
      expect(result.opened).toBe(false);
      if (!result.opened) expect(result.statusCode).toBe(statusCode);
    }
  });

  it('rejects stale share tickets after the next coverage recheck even when the bearer token has not expired', async () => {
    const target: ShareTarget = { kind: 'server', serverId };
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    env = makeEnv(makeDb(serverId, {
      shares: [
        { id: 'expired-coverage', target, targetUserId: 'share-user', role: 'viewer', createdAt: 1_000, expiresAt: Date.now() - 1 },
      ],
    }));
    httpServer = createServer();
    setupWebSocketUpgrade(httpServer, env);
    await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve()));

    const result = await connect(wsUrl(port, serverId, shareTicket(env, {
      serverId,
      target,
      snapshot: snapshotFor(target, { nextCoverageRecheckAt: Date.now() - 1 }),
      expiresAt: Date.now() + 30_000,
    })));

    expect(result.opened).toBe(false);
    if (!result.opened) expect(result.statusCode).toBe(403);
  });

  it('re-resolves overlapping live coverage when an older grant reached its recheck boundary', async () => {
    const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    env = makeEnv(makeDb(serverId, {
      shares: [
        { id: 'remaining-share', target, targetUserId: 'share-user', role: 'viewer', createdAt: 2_000, expiresAt: Date.now() + 60_000 },
      ],
      existingSessions: ['deck_proj_brain'],
    }));
    httpServer = createServer();
    setupWebSocketUpgrade(httpServer, env);
    await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve()));

    const result = await connect(wsUrl(port, serverId, shareTicket(env, {
      serverId,
      target,
      snapshot: snapshotFor(target, {
        historyCutoffAt: 1_000,
        nextCoverageRecheckAt: Date.now() - 1,
        coveringShareIds: ['expired-share', 'remaining-share'],
        primaryShareId: 'remaining-share',
      }),
      expiresAt: Date.now() + 30_000,
    })));

    expect(result.opened).toBe(true);
    if (result.opened) result.ws.close();
  });

  it('enforces serverId sticky routing invariants before creating a bridge owner', async () => {
    const ticketServerId = serverId;
    const wrongRouteServerId = `${serverId}-wrong-route`;
    const target: ShareTarget = { kind: 'server', serverId: ticketServerId };
    const ticket = shareTicket(env, {
      serverId: ticketServerId,
      target,
      snapshot: snapshotFor(target),
    });

    const wrongRoute = await connect(wsUrl(port, wrongRouteServerId, ticket));
    expect(wrongRoute.opened).toBe(false);
    if (!wrongRoute.opened) expect(wrongRoute.statusCode).toBe(401);
    expect(WsBridge.getAll().has(ticketServerId)).toBe(false);
    expect(WsBridge.getAll().has(wrongRouteServerId)).toBe(false);

    const validRoute = await connect(wsUrl(port, ticketServerId, ticket));
    expect(validRoute.opened).toBe(true);
    expect(WsBridge.getAll().has(ticketServerId)).toBe(true);
    expect(WsBridge.getAll().has(wrongRouteServerId)).toBe(false);
    if (validRoute.opened) validRoute.ws.close();
  });
});
