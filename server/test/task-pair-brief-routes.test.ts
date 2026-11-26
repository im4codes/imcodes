import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import { WsBridge } from '../src/ws/bridge.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { sha256Hex, signJwt } from '../src/security/crypto.js';
import { activeUserAnswer } from './helpers/user-status.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { TASK_PAIR_BRIEF_ERROR, TASK_PAIR_BRIEF_MSG } from '../../shared/task-pair-brief.js';

const JWT_KEY = 'test-signing-key-task-pair-brief-32ch';

interface ServerRow {
  id: string;
  name: string;
  user_id: string;
  token_hash: string;
  status: string;
  node_role: string | null;
  revoked_at: number | null;
}

function makeMemDb() {
  const servers = new Map<string, ServerRow>();
  const teamMembers = new Set<string>();
  const serverGroups = new Map<string, string>();
  const shareGrants = new Map<string, 'viewer' | 'participant'>();

  const db = {
    query: async <T = unknown>(sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM servers WHERE user_id = $1')) {
        const userId = String(params[0]);
        return [...servers.values()].filter((s) => s.user_id === userId) as T[];
      }
      if (sql.includes('FROM servers s') && sql.includes('JOIN machine_groups mg')) {
        const userId = String(params[0]);
        const ownExclude = String(params[1]);
        const rows: ServerRow[] = [];
        for (const s of servers.values()) {
          if (s.user_id === ownExclude) continue;
          const teamId = serverGroups.get(s.id);
          if (teamId && teamMembers.has(`${teamId}\u0000${userId}`)) {
            rows.push(s);
          }
        }
        return rows as T[];
      }
      return [] as T[];
    },
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
      {
        const active = activeUserAnswer(sql);
        if (active) return active as never;
      }
      if (sql.includes('FROM servers') && sql.includes('owner_status')) {
        const s = servers.get(String(params[0]));
        if (!s || s.revoked_at != null) return null as T | null;
        return {
          id: s.id,
          user_id: s.user_id,
          team_id: null,
          node_role: s.node_role,
          revoked_at: s.revoked_at,
          token_hash: s.token_hash,
          owner_status: 'active',
          actor_status: 'active',
        } as T;
      }
      if (sql.includes('FROM machine_groups mg')) {
        const teamId = serverGroups.get(String(params[0]));
        const userId = String(params[1]);
        if (teamId && teamMembers.has(`${teamId}\u0000${userId}`)) {
          return { role: 'member' } as T;
        }
        return null as T | null;
      }
      if (sql.includes('FROM share_grants')) {
        const role = shareGrants.get(`${String(params[0])}\u0000${String(params[1])}`);
        if (role) return { role } as T;
        return null as T | null;
      }
      if (sql.includes('SELECT role FROM server_members')) {
        return null as T | null;
      }
      if (sql.includes('SELECT node_role FROM servers WHERE id = $1')) {
        const s = servers.get(String(params[0]));
        return (s && s.revoked_at == null ? { node_role: s.node_role } : null) as T | null;
      }
      if (sql.includes('FROM servers WHERE id = $1') && sql.includes('token_hash')) {
        const s = servers.get(String(params[0]));
        return (s ? { ...s, owner_status: 'active' } : null) as T | null;
      }
      if (sql.includes('FROM servers WHERE id = $1')) {
        const s = servers.get(String(params[0]));
        return (s && s.revoked_at == null
          ? { id: s.id, name: s.name, status: s.status, node_role: s.node_role, revoked_at: s.revoked_at, user_id: s.user_id, owner_status: 'active' }
          : null) as T | null;
      }
      return null as T | null;
    },
    execute: async () => ({ changes: 0 }),
  } as unknown as Database;

  return { db, servers, teamMembers, serverGroups, shareGrants };
}

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: JWT_KEY,
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'development',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
  } as Env;
}

class FakeDaemonWs extends EventEmitter {
  readyState = 1;
  received: Array<Record<string, unknown>> = [];
  nextReply: Record<string, unknown> = {
    ok: true,
    brief: '### Goal\nInspect brief.\n\n- [x][ ] 1. Step one',
    briefRevision: '0123456789abcdef',
    checklist: { total: 1, implemented: 1, audited: 0 },
    updatedAt: 1795600000000,
  };

  send(data: string | Buffer): void {
    const frame = JSON.parse(typeof data === 'string' ? data : data.toString()) as Record<string, unknown>;
    if (frame.type !== TASK_PAIR_BRIEF_MSG.REQUEST) return;
    this.received.push(frame);
    const reply = {
      type: TASK_PAIR_BRIEF_MSG.RESPONSE,
      requestId: frame.requestId,
      taskId: frame.taskId,
      ...this.nextReply,
    };
    setImmediate(() => this.emit('message', Buffer.from(JSON.stringify(reply)), false));
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

describe('GET /api/server/:id/task-pairs/:taskId/brief', () => {
  const bearer = (userId: string) => `Bearer ${signJwt({ sub: userId, role: 'member' }, JWT_KEY, 3600)}`;
  let mem: ReturnType<typeof makeMemDb>;
  let app: ReturnType<typeof buildApp>;
  let env: Env;

  beforeEach(() => {
    mem = makeMemDb();
    env = makeEnv(mem.db);
    app = buildApp(env);
    mem.servers.set('srv-1', {
      id: 'srv-1',
      name: 'M3',
      user_id: 'owner-1',
      token_hash: sha256Hex('tok-1'),
      status: 'online',
      node_role: NODE_ROLE.FULL,
      revoked_at: null,
    });
    mem.servers.set('srv-ctrl', {
      id: 'srv-ctrl',
      name: 'Node',
      user_id: 'owner-1',
      token_hash: sha256Hex('tok-2'),
      status: 'online',
      node_role: NODE_ROLE.CONTROLLED,
      revoked_at: null,
    });
  });

  afterEach(() => {
    WsBridge.getAll().clear();
  });

  async function attachDaemon(serverId: string, token: string): Promise<FakeDaemonWs> {
    const ws = new FakeDaemonWs();
    WsBridge.get(serverId).handleDaemonConnection(ws as never, mem.db, env);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token })), false);
    for (let i = 0; i < 50 && !WsBridge.get(serverId).isDaemonConnected(); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(WsBridge.get(serverId).isDaemonConnected()).toBe(true);
    return ws;
  }

  it('returns brief and checklist from daemon for server owner and team members', async () => {
    const daemon = await attachDaemon('srv-1', 'tok-1');

    const ownerRes = await app.request('/api/server/srv-1/task-pairs/tsk_abc/brief', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(ownerRes.status).toBe(200);
    expect(await ownerRes.json()).toMatchObject({
      ok: true,
      taskId: 'tsk_abc',
      briefRevision: '0123456789abcdef',
      checklist: { total: 1, implemented: 1, audited: 0 },
    });
    expect(daemon.received[0]).toMatchObject({
      type: TASK_PAIR_BRIEF_MSG.REQUEST,
      taskId: 'tsk_abc',
    });

    mem.serverGroups.set('srv-1', 'team-1');
    mem.teamMembers.add('team-1\u0000member-1');
    const memberRes = await app.request('/api/server/srv-1/task-pairs/tsk_abc/brief', {
      headers: { Authorization: bearer('member-1') },
    });
    expect(memberRes.status).toBe(200);
  });

  it('forbids unrelated users and share-only participants, rejects controlled/revoked nodes, and surfaces not_found / daemon_offline', async () => {
    const daemon = await attachDaemon('srv-1', 'tok-1');

    const forbiddenRes = await app.request('/api/server/srv-1/task-pairs/tsk_abc/brief', {
      headers: { Authorization: bearer('stranger-1') },
    });
    expect(forbiddenRes.status).toBe(403);
    expect(await forbiddenRes.json()).toEqual({ ok: false, error: TASK_PAIR_BRIEF_ERROR.FORBIDDEN });
    expect(daemon.received).toHaveLength(0);

    // Whole-server shared participant (non-owner, non-team-member) is excluded from task-mode snapshot
    // and must also be forbidden here without forwarding any RPC to the daemon.
    mem.shareGrants.set('srv-1\u0000participant-1', 'participant');
    const participantRes = await app.request('/api/server/srv-1/task-pairs/tsk_abc/brief', {
      headers: { Authorization: bearer('participant-1') },
    });
    expect(participantRes.status).toBe(403);
    expect(await participantRes.json()).toEqual({ ok: false, error: TASK_PAIR_BRIEF_ERROR.FORBIDDEN });
    expect(daemon.received).toHaveLength(0);

    daemon.nextReply = { ok: false, error: TASK_PAIR_BRIEF_ERROR.NOT_FOUND };
    const missingRes = await app.request('/api/server/srv-1/task-pairs/tsk_missing/brief', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(missingRes.status).toBe(404);
    expect(await missingRes.json()).toMatchObject({ ok: false, error: TASK_PAIR_BRIEF_ERROR.NOT_FOUND });

    const ctrlRes = await app.request('/api/server/srv-ctrl/task-pairs/tsk_abc/brief', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(ctrlRes.status).toBe(404);

    WsBridge.getAll().clear();
    const offlineRes = await app.request('/api/server/srv-1/task-pairs/tsk_abc/brief', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(offlineRes.status).toBe(503);
    expect(await offlineRes.json()).toEqual({ ok: false, error: TASK_PAIR_BRIEF_ERROR.DAEMON_OFFLINE });
  });
});
