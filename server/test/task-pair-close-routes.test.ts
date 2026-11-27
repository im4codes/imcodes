import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import { WsBridge } from '../src/ws/bridge.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { sha256Hex, signJwt } from '../src/security/crypto.js';
import { activeUserAnswer } from './helpers/user-status.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { TASK_PAIR_CLOSE_ERROR, TASK_PAIR_CLOSE_MSG } from '../../shared/task-pair-close.js';

const JWT_KEY = 'test-signing-key-task-pair-close-32ch';

interface ServerRow {
  id: string;
  name: string;
  user_id: string;
  token_hash: string;
  status: string;
  node_role: string | null;
  revoked_at: number | null;
}

interface SummaryRow {
  server_id: string;
  task_id: string;
  project_name: string;
  brain_session: string;
  brain_label: string;
  title: string;
  status: string;
  flags_json: string;
  round: number;
  checklist_total: number;
  checklist_implemented: number;
  checklist_audited: number;
  executor_label: string | null;
  auditor_label: string | null;
  auditor: string | null;
  live_summary: string | null;
  is_terminal: boolean;
  needs_attention: boolean;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
}

function makeMemDb() {
  const servers = new Map<string, ServerRow>();
  const summaries = new Map<string, SummaryRow>();

  const db = {
    query: async <T = unknown>(sql: string) => {
      if (sql.includes('FROM server_shares')) return [] as T[];
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
      if (sql.includes('SELECT role FROM server_members') || sql.includes('FROM machine_groups')) {
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
        return (s && s.revoked_at == null ? { id: s.id, name: s.name, status: s.status, node_role: s.node_role, revoked_at: s.revoked_at, user_id: s.user_id, owner_status: 'active' } : null) as T | null;
      }
      if (sql.includes('FROM global_task_pair_summaries') && sql.includes('WHERE server_id = $1 AND task_id = $2')) {
        const row = summaries.get(`${String(params[0])}\u0000${String(params[1])}`);
        return (row ?? null) as T | null;
      }
      if (sql.includes('FROM sessions WHERE server_id = $1')) {
        return null as T | null;
      }
      return null as T | null;
    },
    execute: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO global_task_pair_summaries')) {
        const [
          serverId, taskId, projectName, brainSession, brainLabel, title,
          status, flagsJson, round, checklistTotal, checklistImplemented, checklistAudited,
          executorLabel, auditorLabel, auditor, liveSummary, isTerminal, needsAttention,
          createdAt, updatedAt, startedAt, endedAt, _executorModel, _auditorModel, lastAuditParam,
        ] = params as [
          string, string, string, string, string, string,
          string, string, number, number, number, number,
          string, string, string, string, boolean, boolean,
          number, number, number | null, number | null, string, string, string,
        ];
        const key = `${serverId}\u0000${taskId}`;
        const prev = summaries.get(key) as (typeof summaries extends Map<string, infer V> ? V & { last_audit_json?: string | null } : never) | undefined;
        summaries.set(key, {
          server_id: serverId,
          task_id: taskId,
          project_name: projectName || prev?.project_name || '',
          brain_session: brainSession || prev?.brain_session || '',
          brain_label: brainLabel || prev?.brain_label || '',
          title: title || prev?.title || '',
          status,
          flags_json: flagsJson || prev?.flags_json || '[]',
          round: round || prev?.round || 0,
          checklist_total: checklistTotal || prev?.checklist_total || 0,
          checklist_implemented: checklistImplemented || prev?.checklist_implemented || 0,
          checklist_audited: checklistAudited || prev?.checklist_audited || 0,
          executor_label: executorLabel || prev?.executor_label || null,
          auditor_label: auditorLabel || prev?.auditor_label || null,
          auditor: auditor || prev?.auditor || null,
          live_summary: liveSummary || prev?.live_summary || null,
          last_audit_json: lastAuditParam === '__NULL__'
            ? null
            : (lastAuditParam || prev?.last_audit_json || null),
          is_terminal: Boolean(isTerminal),
          needs_attention: Boolean(needsAttention),
          created_at: prev?.created_at || createdAt,
          updated_at: updatedAt,
          started_at: prev?.started_at ?? startedAt,
          ended_at: isTerminal ? (endedAt ?? prev?.ended_at ?? updatedAt) : null,
        });
        return { changes: 1 };
      }
      return { changes: 0 };
    },
    exec: async () => undefined,
    transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db),
    close: async () => undefined,
  } as unknown as Database;

  return { db, servers, summaries };
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
    status: 'cancelled',
    effect: 'status',
    projectName: 'proj',
    brainSession: 'deck_proj_brain',
    title: 'Old Task',
  };

  send(data: string | Buffer): void {
    const frame = JSON.parse(typeof data === 'string' ? data : data.toString()) as Record<string, unknown>;
    if (frame.type !== TASK_PAIR_CLOSE_MSG.REQUEST) return;
    this.received.push(frame);
    const now = Date.now();
    const reply = {
      type: TASK_PAIR_CLOSE_MSG.RESPONSE,
      requestId: frame.requestId,
      taskId: frame.taskId,
      updatedAt: now,
      endedAt: now,
      ...this.nextReply,
    };
    setImmediate(() => this.emit('message', Buffer.from(JSON.stringify(reply)), false));
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

describe('POST /api/server/:id/task-pairs/:taskId/close', () => {
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

  it('allows owner to cancel an open task pair and updates global_task_pair_summaries', async () => {
    const daemon = await attachDaemon('srv-1', 'tok-1');
    const res = await app.request('/api/server/srv-1/task-pairs/tsk_123/close', {
      method: 'POST',
      headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, taskId: 'tsk_123', status: 'cancelled' });
    expect(daemon.received).toHaveLength(1);
    expect(daemon.received[0]).toMatchObject({
      type: TASK_PAIR_CLOSE_MSG.REQUEST,
      taskId: 'tsk_123',
      action: 'cancel',
    });
    const saved = mem.summaries.get('srv-1\u0000tsk_123');
    expect(saved?.status).toBe('cancelled');
    expect(saved?.is_terminal).toBe(true);
  });

  it('forbids non-owner users from closing task pairs', async () => {
    await attachDaemon('srv-1', 'tok-1');
    const res = await app.request('/api/server/srv-1/task-pairs/tsk_123/close', {
      method: 'POST',
      headers: { Authorization: bearer('other-user'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: TASK_PAIR_CLOSE_ERROR.FORBIDDEN });
  });

  it('rejects controlled nodes, invalid bodies, and offline daemons explicitly', async () => {
    const ctrlRes = await app.request('/api/server/srv-ctrl/task-pairs/tsk_123/close', {
      method: 'POST',
      headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    });
    expect(ctrlRes.status).toBe(404);

    const invalidRes = await app.request('/api/server/srv-1/task-pairs/tsk_123/close', {
      method: 'POST',
      headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'bogus' }),
    });
    expect(invalidRes.status).toBe(400);

    const offlineRes = await app.request('/api/server/srv-1/task-pairs/tsk_123/close', {
      method: 'POST',
      headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    });
    expect(offlineRes.status).toBe(503);
    expect(await offlineRes.json()).toEqual({ ok: false, error: TASK_PAIR_CLOSE_ERROR.DAEMON_OFFLINE });
  });
});
