import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  GLOBAL_TASK_FLEET_SNAPSHOT_MSG,
  GLOBAL_TASK_MODE_MSG,
  GLOBAL_TASK_NOTIFY_CHANNEL,
  GLOBAL_TASK_PG_NOTIFY_MAX_BYTES,
  GLOBAL_TASK_SNAPSHOT_PATH,
  GLOBAL_TASK_TERMINAL_WINDOW_MS,
  GLOBAL_TASK_TICKET_PATH,
  GLOBAL_TASK_WS_PATH,
  type GlobalTaskServerFrame,
} from '../../shared/global-task-mode.js';
import { COOKIE_CSRF, COOKIE_SESSION, HEADER_CSRF } from '../../shared/cookie-names.js';
import { ACCOUNT_SESSION_JWT_TYPE } from '../../shared/auth-token-types.js';
import { TIMELINE_MESSAGES } from '../../shared/timeline-protocol.js';
import type { Database } from '../src/db/client.js';
import {
  getGlobalTaskSummaryForServerTask,
  listGlobalTaskSnapshotForUser,
  upsertGlobalTaskSummariesBatch,
  upsertGlobalTaskSummary,
} from '../src/db/global-task-summaries.js';
import type { Env } from '../src/env.js';
import { buildApp, setupWebSocketUpgrade } from '../src/index.js';
import { signJwt } from '../src/security/crypto.js';
import { globalTaskHub, GlobalTaskHub } from '../src/services/global-task-hub.js';
import { closeConnectionsOfInactiveUsers } from '../src/ws/account-watch.js';
import { WsBridge } from '../src/ws/bridge.js';
import { applyMachineGroupInvalidation } from '../src/ws/machine-group-revalidation.js';

interface MemServerRow {
  id: string;
  user_id: string;
  team_id: string | null;
  name: string;
  token_hash: string;
  last_heartbeat_at: number | null;
  status: string;
  daemon_version: string | null;
  bound_with_key_id: string | null;
  created_at: number;
  node_role?: string | null;
  revoked_at?: number | null;
}

interface MemSessionRow {
  id: string;
  server_id: string;
  name: string;
  project_name: string;
  role: string;
  agent_type: string;
  agent_version: string | null;
  project_dir: string;
  state: string;
  label: string | null;
  runtime_type: string | null;
  provider_id: string | null;
  provider_session_id: string | null;
  description: string | null;
  created_at: number;
}

interface MemSummaryRow {
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
  started_at?: number | null;
  ended_at?: number | null;
  created_at: number;
  updated_at: number;
}

class InMemoryGlobalTaskDb {
  users = new Map<string, { id: string; status: string; sessions_valid_after: number }>([
    ['user-a', { id: 'user-a', status: 'active', sessions_valid_after: 0 }],
    ['user-b', { id: 'user-b', status: 'active', sessions_valid_after: 0 }],
    ['user-c', { id: 'user-c', status: 'active', sessions_valid_after: 0 }],
  ]);
  servers = new Map<string, MemServerRow>();
  machineGroups: Array<{ server_id: string; team_id: string }> = [];
  teamMembers: Array<{ team_id: string; user_id: string; role: string }> = [];
  sessions: MemSessionRow[] = [];
  summaries = new Map<string, MemSummaryRow>();
  pgNotifies: Array<{ channel: string; payload: string }> = [];
  throwOnPgNotify = false;

  private summaryKey(serverId: string, taskId: string): string {
    return `${serverId}\u0000${taskId}`;
  }

  asDatabase(): Database {
    const db: Database = {
      query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
        const norm = sql.toLowerCase().replace(/\s+/g, ' ').trim();

        if (norm.startsWith('select * from servers where user_id = $1')) {
          const userId = String(params[0]);
          return [...this.servers.values()]
            .filter((s) => s.user_id === userId)
            .sort((a, b) => b.created_at - a.created_at) as unknown as T[];
        }

        if (norm.includes('from servers s join machine_groups mg') && norm.includes('join team_members tm')) {
          const userId = String(params[0]);
          const excludeOwner = String(params[1]);
          const teamIds = new Set(this.teamMembers.filter((tm) => tm.user_id === userId).map((tm) => tm.team_id));
          const serverIds = new Set(this.machineGroups.filter((mg) => teamIds.has(mg.team_id)).map((mg) => mg.server_id));
          return [...this.servers.values()]
            .filter((s) => serverIds.has(s.id) && s.user_id !== excludeOwner)
            .sort((a, b) => b.created_at - a.created_at) as unknown as T[];
        }

        if (norm.includes('from sessions where server_id in')) {
          const serverIds = new Set(params.map(String));
          return this.sessions
            .filter((s) => serverIds.has(s.server_id))
            .sort((a, b) => a.created_at - b.created_at) as unknown as T[];
        }

        if (norm.startsWith('select u.id from users u where u.id = any')) {
          const ids = Array.isArray(params[0]) ? params[0].map(String) : [];
          return ids
            .map((id) => this.users.get(id))
            .filter((u): u is NonNullable<typeof u> => Boolean(u && u.status === 'active'))
            .map((u) => ({ id: u.id })) as unknown as T[];
        }

        if (norm.includes('from global_task_pair_summaries') && norm.includes('is_terminal = false')) {
          const serverIds = new Set(params.map(String));
          return [...this.summaries.values()]
            .filter((r) => serverIds.has(r.server_id) && !r.is_terminal)
            .sort((a, b) => b.updated_at - a.updated_at) as unknown as T[];
        }

        if (norm.includes('from global_task_pair_summaries') && norm.includes("status = 'done'")) {
          const cutoff = Number(params.at(-1) ?? 0);
          const serverIds = new Set(params.slice(0, -1).map(String));
          return [...this.summaries.values()]
            .filter((r) => serverIds.has(r.server_id) && r.status === 'done' && r.updated_at >= cutoff) as unknown as T[];
        }

        if (norm.includes('from global_task_pair_summaries') && norm.includes('is_terminal = true')) {
          const limit = Number(params.at(-1) ?? 50);
          const hasCutoff = norm.includes('updated_at >=');
          const cutoff = hasCutoff ? Number(params.at(-2) ?? 0) : 0;
          const serverIds = new Set(params.slice(0, hasCutoff ? -2 : -1).map(String));
          return [...this.summaries.values()]
            .filter((r) => serverIds.has(r.server_id) && r.is_terminal && (!hasCutoff || r.updated_at >= cutoff))
            .sort((a, b) => b.updated_at - a.updated_at)
            .slice(0, limit) as unknown as T[];
        }

        return [] as T[];
      },

      queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
        const norm = sql.toLowerCase().replace(/\s+/g, ' ').trim();

        if (norm.includes('from users where id = $1')) {
          return (this.users.get(String(params[0])) ?? null) as unknown as T | null;
        }

        if (norm.startsWith('select * from global_task_pair_summaries where server_id = $1 and task_id = $2')) {
          return (this.summaries.get(this.summaryKey(String(params[0]), String(params[1]))) ?? null) as unknown as T | null;
        }

        if (norm.startsWith('select id, name, status, node_role, revoked_at from servers where id = $1')) {
          return (this.servers.get(String(params[0])) ?? null) as unknown as T | null;
        }

        if (norm.startsWith('select * from servers where id = $1')) {
          return (this.servers.get(String(params[0])) ?? null) as unknown as T | null;
        }

        if (norm.startsWith('select label, project_name from sessions where server_id = $1 and name = $2')
          || norm.startsWith('select label from sessions where server_id = $1 and name = $2')) {
          const found = this.sessions.find((s) => s.server_id === String(params[0]) && s.name === String(params[1]));
          return (found ? { label: found.label, project_name: found.project_name } : null) as unknown as T | null;
        }

        return null;
      },

      execute: async (sql: string, params: unknown[] = []) => {
        const norm = sql.toLowerCase().replace(/\s+/g, ' ').trim();

        if (norm.startsWith('select pg_notify($1, $2)')) {
          if (this.throwOnPgNotify) throw new Error('pg_notify unavailable in sqlite/mock');
          this.pgNotifies.push({ channel: String(params[0]), payload: String(params[1]) });
          return { changes: 1 };
        }

        if (norm.startsWith('insert into global_task_pair_summaries')) {
          const [
            serverId,
            taskId,
            projectName,
            brainSession,
            brainLabel,
            title,
            status,
            flagsJson,
            round,
            checklistTotal,
            checklistImplemented,
            checklistAudited,
            executorLabel,
            auditorLabel,
            auditor,
            liveSummary,
            isTerminal,
            needsAttention,
            createdAt,
            updatedAt,
            startedAt,
            endedAt,
          ] = params;

          const key = this.summaryKey(String(serverId), String(taskId));
          const existing = this.summaries.get(key);
          const sName = String(projectName ?? '');
          const sBrain = String(brainSession ?? '');
          const sBrainLabel = String(brainLabel ?? '');
          const sTitle = String(title ?? '');
          const sFlags = String(flagsJson ?? '');
          const nRound = Number(round ?? 0);
          const nTotal = Number(checklistTotal ?? 0);
          const nImpl = Number(checklistImplemented ?? 0);
          const nAudit = Number(checklistAudited ?? 0);
          const sExecLabel = String(executorLabel ?? '') || null;
          const sAuditLabel = String(auditorLabel ?? '') || null;
          const sAuditor = String(auditor ?? '') || null;
          const sLive = String(liveSummary ?? '') || null;
          const bTerminal = Boolean(isTerminal);
          const bAttention = Boolean(needsAttention);
          const nCreated = Number(createdAt ?? 0);
          const nUpdated = Number(updatedAt ?? 0);
          const nStarted = typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null;
          const nEnded = typeof endedAt === 'number' && Number.isFinite(endedAt) && endedAt > 0 ? endedAt : null;

          if (!existing) {
            this.summaries.set(key, {
              server_id: String(serverId),
              task_id: String(taskId),
              project_name: sName,
              brain_session: sBrain,
              brain_label: sBrainLabel,
              title: sTitle,
              status: String(status),
              flags_json: sFlags === '' ? '[]' : sFlags,
              round: nRound,
              checklist_total: nTotal,
              checklist_implemented: nImpl,
              checklist_audited: nAudit,
              executor_label: sExecLabel,
              auditor_label: sAuditLabel,
              auditor: sAuditor,
              live_summary: sLive,
              is_terminal: bTerminal,
              needs_attention: bAttention,
              started_at: nStarted,
              ended_at: nEnded,
              created_at: nCreated,
              updated_at: nUpdated,
            });
          } else {
            const isNewerOrEqual = nUpdated >= existing.updated_at;
            this.summaries.set(key, {
              server_id: String(serverId),
              task_id: String(taskId),
              project_name: sName !== '' ? sName : existing.project_name,
              brain_session: sBrain !== '' ? sBrain : existing.brain_session,
              brain_label: sBrainLabel !== '' ? sBrainLabel : existing.brain_label,
              title: sTitle !== '' ? sTitle : existing.title,
              status: isNewerOrEqual ? String(status) : existing.status,
              flags_json: isNewerOrEqual && sFlags !== '' ? sFlags : existing.flags_json,
              round: isNewerOrEqual && (nRound > 0 || existing.round === 0) ? nRound : existing.round,
              checklist_total: isNewerOrEqual && nTotal > 0 ? nTotal : existing.checklist_total,
              checklist_implemented: isNewerOrEqual && nTotal > 0 ? nImpl : existing.checklist_implemented,
              checklist_audited: isNewerOrEqual && nTotal > 0 ? nAudit : existing.checklist_audited,
              executor_label: sExecLabel ?? existing.executor_label,
              auditor_label: sAuditLabel ?? existing.auditor_label,
              auditor: sAuditor ?? existing.auditor,
              live_summary: isNewerOrEqual ? (sLive ?? existing.live_summary) : existing.live_summary,
              is_terminal: isNewerOrEqual ? bTerminal : existing.is_terminal,
              needs_attention: !isNewerOrEqual
                ? existing.needs_attention
                : (sFlags !== ''
                  ? bAttention
                  : (bTerminal ? false : (bAttention ? true : existing.needs_attention))),
              started_at: existing.started_at ?? nStarted,
              ended_at: !isNewerOrEqual
                ? (existing.ended_at ?? null)
                : (bTerminal ? (nEnded ?? existing.ended_at ?? null) : null),
              created_at: existing.created_at > 0 && nCreated > 0
                ? Math.min(existing.created_at, nCreated)
                : (nCreated > 0 ? nCreated : existing.created_at),
              updated_at: Math.max(existing.updated_at, nUpdated),
            });
          }
          return { changes: 1 };
        }

        if (norm.startsWith('update servers set status = $1')) {
          const srv = this.servers.get(String(params[params.length - 1]));
          if (srv) srv.status = String(params[0]);
          return { changes: srv ? 1 : 0 };
        }

        return { changes: 0 };
      },

      exec: async () => {},
      transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db),
      close: async () => {},
    };
    return db;
  }
}

async function nextWsMessage(ws: WebSocket, predicate?: (frame: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('Timed out waiting for WS message'));
    }, 3000);
    const onMsg = (raw: any) => {
      const parsed = JSON.parse(String(raw));
      if (!predicate || predicate(parsed)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(parsed);
      }
    };
    ws.on('message', onMsg);
  });
}

describe('global-task-mode server engine', () => {
  let memDb: InMemoryGlobalTaskDb;
  let db: Database;

  beforeEach(() => {
    memDb = new InMemoryGlobalTaskDb();
    db = memDb.asDatabase();
    memDb.servers.set('srv-a', {
      id: 'srv-a',
      user_id: 'user-a',
      team_id: null,
      name: 'Alpha Box',
      token_hash: 'hash-a',
      last_heartbeat_at: Date.now(),
      status: 'online',
      daemon_version: '1.0.0',
      bound_with_key_id: null,
      created_at: 200,
      node_role: 'full',
      revoked_at: null,
    });
    memDb.servers.set('srv-b', {
      id: 'srv-b',
      user_id: 'user-b',
      team_id: null,
      name: 'Beta Box',
      token_hash: 'hash-b',
      last_heartbeat_at: Date.now(),
      status: 'online',
      daemon_version: '1.0.0',
      bound_with_key_id: null,
      created_at: 100,
      node_role: 'full',
      revoked_at: null,
    });
    memDb.servers.set('srv-controlled', {
      id: 'srv-controlled',
      user_id: 'user-a',
      team_id: null,
      name: 'Controlled Node',
      token_hash: 'hash-c',
      last_heartbeat_at: Date.now(),
      status: 'online',
      daemon_version: '1.0.0',
      bound_with_key_id: null,
      created_at: 50,
      node_role: 'controlled',
      revoked_at: null,
    });
    memDb.sessions.push(
      {
        id: 's1',
        server_id: 'srv-a',
        name: 'deck_proj_brain',
        project_name: 'imcodes',
        role: 'brain',
        agent_type: 'claude-code',
        agent_version: null,
        project_dir: '/repo',
        state: 'idle',
        label: 'Alpha Brain',
        runtime_type: 'transport',
        provider_id: null,
        provider_session_id: null,
        description: null,
        created_at: 10,
      },
      {
        id: 's2',
        server_id: 'srv-a',
        name: 'deck_sub_worker1',
        project_name: 'imcodes',
        role: 'sub',
        agent_type: 'codex',
        agent_version: null,
        project_dir: '/repo',
        state: 'running',
        label: 'Worker 1',
        runtime_type: 'transport',
        provider_id: null,
        provider_session_id: null,
        description: null,
        created_at: 20,
      },
      {
        id: 's3',
        server_id: 'srv-b',
        name: 'deck_other_brain',
        project_name: 'secret',
        role: 'brain',
        agent_type: 'claude-code',
        agent_version: null,
        project_dir: '/secret',
        state: 'idle',
        label: 'Beta Brain',
        runtime_type: 'transport',
        provider_id: null,
        provider_session_id: null,
        description: null,
        created_at: 30,
      },
    );
  });

  afterEach(async () => {
    await globalTaskHub.stop();
  });

  it('preserves existing title, flags, and checklist counts across partial upserts and isolates same taskId by serverId', async () => {
    const initial = await upsertGlobalTaskSummary(db, {
      serverId: 'srv-a',
      taskId: 'tsk_same',
      projectName: 'imcodes',
      brainSession: 'deck_proj_brain',
      title: 'Keep existing title',
      status: 'working',
      flags: ['blocked'],
      round: 2,
      checklist: { total: 5, implemented: 3, audited: 1 },
      createdAt: 1000,
      updatedAt: 2000,
    });
    expect(initial?.title).toBe('Keep existing title');
    expect(initial?.checklist).toEqual({ total: 5, implemented: 3, audited: 1 });
    expect(initial?.needsAttention).toBe(true);

    // Partial event missing title, flags, and checklist
    const partial = await upsertGlobalTaskSummary(db, {
      serverId: 'srv-a',
      taskId: 'tsk_same',
      status: 'in_audit',
      updatedAt: 3000,
    });
    expect(partial?.title).toBe('Keep existing title');
    expect(partial?.checklist).toEqual({ total: 5, implemented: 3, audited: 1 });
    expect(partial?.flags).toEqual(['blocked']);
    expect(partial?.status).toBe('in_audit');
    expect(partial?.round).toBe(2);

    // Same taskId on srv-b stays completely isolated (recent terminal task within 2d window)
    await upsertGlobalTaskSummary(db, {
      serverId: 'srv-b',
      taskId: 'tsk_same',
      projectName: 'secret',
      brainSession: 'deck_other_brain',
      title: 'Beta task',
      status: 'done',
      flags: [],
      checklist: { total: 2, implemented: 2, audited: 2 },
      updatedAt: Date.now() - 60_000,
    });

    const rowA = await getGlobalTaskSummaryForServerTask(db, 'srv-a', 'tsk_same');
    const rowB = await getGlobalTaskSummaryForServerTask(db, 'srv-b', 'tsk_same');
    expect(rowA?.title).toBe('Keep existing title');
    expect(rowB?.title).toBe('Beta task');
    expect(rowB?.isTerminal).toBe(true);
  });

  it('enforces multi-tenant isolation, excludes controlled nodes & deck_sub_ sessions, and respects mutedServerIds', async () => {
    await upsertGlobalTaskSummariesBatch(db, 'srv-a', [
      { serverId: 'srv-a', taskId: 'tsk_a', projectName: 'imcodes', brainSession: 'deck_proj_brain', title: 'Alpha task', status: 'working', flags: [], updatedAt: 5000 },
    ]);
    await upsertGlobalTaskSummariesBatch(db, 'srv-b', [
      { serverId: 'srv-b', taskId: 'tsk_b', projectName: 'secret', brainSession: 'deck_other_brain', title: 'Beta secret', status: 'working', flags: [], updatedAt: 6000 },
    ]);
    await upsertGlobalTaskSummary(db, {
      serverId: 'srv-controlled',
      taskId: 'tsk_c',
      title: 'Controlled',
      status: 'working',
      updatedAt: 7000,
    });

    const snapA = await listGlobalTaskSnapshotForUser(db, 'user-a');
    expect(snapA.servers.map((s) => s.id)).toEqual(['srv-a']);
    expect(snapA.tasks.map((t) => t.taskId)).toEqual(['tsk_a']);
    expect(snapA.brains.map((b) => b.sessionName)).toEqual(['deck_proj_brain']);

    const snapAMuted = await listGlobalTaskSnapshotForUser(db, 'user-a', ['srv-a']);
    expect(snapAMuted.servers.map((s) => s.id)).toEqual(['srv-a']);
    expect(snapAMuted.tasks).toEqual([]);
    expect(snapAMuted.brains).toEqual([]);
  });

  it('serves HTTP routes, enforces Origin and single-use jti ws-ticket, isolates tenants, filters muted servers, and truncates brain_text <= 4000 bytes', async () => {
    const jwtSecret = 'test-signing-key-that-is-plenty-long-12345';
    const env = {
      DATABASE_URL: undefined,
      JWT_SIGNING_KEY: jwtSecret,
      DB: db,
      BOT_ENCRYPTION_KEY: jwtSecret,
      SERVER_URL: 'http://127.0.0.1',
      ALLOWED_ORIGINS: 'http://127.0.0.1',
      NODE_ENV: 'test',
    } as unknown as Env;

    await upsertGlobalTaskSummary(db, {
      serverId: 'srv-a',
      taskId: 'tsk_live',
      projectName: 'imcodes',
      brainSession: 'deck_proj_brain',
      title: 'Live Task',
      status: 'working',
      checklist: { total: 3, implemented: 1, audited: 0 },
      updatedAt: 10_000,
    });
    await upsertGlobalTaskSummary(db, {
      serverId: 'srv-b',
      taskId: 'tsk_secret_b',
      projectName: 'secret',
      brainSession: 'deck_other_brain',
      title: 'Secret B Task',
      status: 'working',
      updatedAt: 10_000,
    });

    const app = buildApp(env);
    const httpServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) as unknown as import('node:http').Server;
    setupWebSocketUpgrade(httpServer, env);
    if (!httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.once('listening', resolve));
    }

    try {
      const addr = httpServer.address() as { port: number };
      const baseHttp = `http://127.0.0.1:${addr.port}`;
      const baseWs = `ws://127.0.0.1:${addr.port}`;

      const cookieA = signJwt({ sub: 'user-a', type: ACCOUNT_SESSION_JWT_TYPE }, jwtSecret, 3600);
      const cookieB = signJwt({ sub: 'user-b', type: ACCOUNT_SESSION_JWT_TYPE }, jwtSecret, 3600);
      const csrf = 'csrf-token-123';

      // GET /api/global-tasks authorization
      const resSnapA = await fetch(`${baseHttp}${GLOBAL_TASK_SNAPSHOT_PATH}`, {
        headers: { Cookie: `${COOKIE_SESSION}=${cookieA}` },
      });
      expect(resSnapA.status).toBe(200);
      const bodySnapA = await resSnapA.json() as { tasks: Array<{ taskId: string }> };
      expect(bodySnapA.tasks.map((t) => t.taskId)).toEqual(['tsk_live']);

      // Issue ticket for user-a and user-b
      const resTicketA = await fetch(`${baseHttp}${GLOBAL_TASK_TICKET_PATH}`, {
        method: 'POST',
        headers: {
          Origin: 'http://127.0.0.1',
          Cookie: `${COOKIE_SESSION}=${cookieA}; ${COOKIE_CSRF}=${csrf}`,
          [HEADER_CSRF]: csrf,
        },
      });
      expect(resTicketA.status).toBe(200);
      const { ticket: ticketA } = await resTicketA.json() as { ticket: string };

      const resTicketB = await fetch(`${baseHttp}${GLOBAL_TASK_TICKET_PATH}`, {
        method: 'POST',
        headers: {
          Origin: 'http://127.0.0.1',
          Cookie: `${COOKIE_SESSION}=${cookieB}; ${COOKIE_CSRF}=${csrf}`,
          [HEADER_CSRF]: csrf,
        },
      });
      expect(resTicketB.status).toBe(200);
      const { ticket: ticketB } = await resTicketB.json() as { ticket: string };

      // Bad Origin -> 403
      const badOriginCode = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`${baseWs}${GLOBAL_TASK_WS_PATH}?ticket=${encodeURIComponent(ticketA)}`, {
          origin: 'https://evil.example.com',
        });
        ws.on('error', () => {});
        ws.on('unexpected-response', (_req, res) => {
          resolve(res.statusCode ?? 0);
          ws.terminate();
        });
      });
      expect(badOriginCode).toBe(403);

      // Connect user-a WS and expect snapshot
      const wsA = new WebSocket(`${baseWs}${GLOBAL_TASK_WS_PATH}?ticket=${encodeURIComponent(ticketA)}`, {
        origin: 'http://127.0.0.1',
      });
      const snapMsgA = await nextWsMessage(wsA, (m) => m.type === GLOBAL_TASK_MODE_MSG.SNAPSHOT);
      expect(snapMsgA.tasks.map((t: { taskId: string }) => t.taskId)).toEqual(['tsk_live']);

      // Replaying ticketA jti -> 401
      const replayCode = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`${baseWs}${GLOBAL_TASK_WS_PATH}?ticket=${encodeURIComponent(ticketA)}`, {
          origin: 'http://127.0.0.1',
        });
        ws.on('error', () => {});
        ws.on('unexpected-response', (_req, res) => {
          resolve(res.statusCode ?? 0);
          ws.terminate();
        });
      });
      expect(replayCode).toBe(401);

      // Connect user-b WS
      const wsB = new WebSocket(`${baseWs}${GLOBAL_TASK_WS_PATH}?ticket=${encodeURIComponent(ticketB)}`, {
        origin: 'http://127.0.0.1',
      });
      await nextWsMessage(wsB, (m) => m.type === GLOBAL_TASK_MODE_MSG.SNAPSHOT);

      const receivedByB: GlobalTaskServerFrame[] = [];
      wsB.on('message', (raw) => receivedByB.push(JSON.parse(String(raw))));

      // Real-time task upsert & brain_text on srv-a reaches user-a, NEVER user-b
      memDb.throwOnPgNotify = true; // Verify graceful non-PG fallback
      const upsertWait = nextWsMessage(wsA, (m) => m.type === GLOBAL_TASK_MODE_MSG.UPSERT);
      await upsertGlobalTaskSummary(db, {
        serverId: 'srv-a',
        taskId: 'tsk_live',
        status: 'in_audit',
        checklist: { total: 3, implemented: 3, audited: 1 },
        updatedAt: 11_000,
      });
      await globalTaskHub.notifyTaskUpdated(db, 'srv-a', 'tsk_live');
      const upsertFrame = await upsertWait;
      expect(upsertFrame.task.status).toBe('in_audit');
      expect(upsertFrame.task.checklist).toEqual({ total: 3, implemented: 3, audited: 1 });

      // Multibyte long text truncation <= 1200 chars and <= 4000 bytes
      memDb.throwOnPgNotify = false;
      const longChineseEmoji = '你好🚀'.repeat(900); // > 2700 code points, > 7000 bytes
      const brainWait = nextWsMessage(wsA, (m) => m.type === GLOBAL_TASK_MODE_MSG.BRAIN_TEXT);
      await globalTaskHub.notifyBrainText(db, {
        serverId: 'srv-a',
        sessionName: 'deck_proj_brain',
        projectName: 'imcodes',
        eventId: 'evt-long-1',
        text: longChineseEmoji,
        ts: 12_000,
      });
      const brainFrame = await brainWait;
      expect(Array.from(brainFrame.event.text).length).toBeLessThanOrEqual(1200);
      const notifyEntry = memDb.pgNotifies.find((n) => n.channel === GLOBAL_TASK_NOTIFY_CHANNEL && n.payload.includes('evt-long-1'));
      expect(notifyEntry).toBeDefined();
      expect(Buffer.byteLength(notifyEntry!.payload, 'utf8')).toBeLessThanOrEqual(GLOBAL_TASK_PG_NOTIFY_MAX_BYTES);

      expect(receivedByB).toEqual([]);

      // Mute srv-a dynamically via set_filter -> blocks upsert & brain_text until unmuted
      const filteredSnapWait = nextWsMessage(wsA, (m) => m.type === GLOBAL_TASK_MODE_MSG.SNAPSHOT);
      wsA.send(JSON.stringify({ type: GLOBAL_TASK_MODE_MSG.SET_FILTER, mutedServerIds: ['srv-a'] }));
      const filteredSnap = await filteredSnapWait;
      expect(filteredSnap.tasks).toEqual([]);

      const receivedWhileMuted: GlobalTaskServerFrame[] = [];
      const captureMuted = (raw: any) => receivedWhileMuted.push(JSON.parse(String(raw)));
      wsA.on('message', captureMuted);
      await globalTaskHub.notifyTaskUpdated(db, 'srv-a', 'tsk_live');
      await globalTaskHub.notifyBrainText(db, {
        serverId: 'srv-a',
        sessionName: 'deck_proj_brain',
        eventId: 'evt-muted-1',
        text: 'Should not arrive while muted',
        ts: 13_000,
      });
      await new Promise((r) => setTimeout(r, 40));
      wsA.off('message', captureMuted);
      expect(receivedWhileMuted).toEqual([]);

      wsA.close();
      wsB.close();
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('ingests fleet_snapshot, task_pair.event, task_console frames, and filtered assistant.text via WsBridge without leaking fleet_snapshot to terminal browsers', async () => {
    const hub = globalTaskHub;
    const browserReceived: string[] = [];
    const terminalBrowserWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn((data: string) => { browserReceived.push(data); }),
      on: vi.fn(),
      once: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    const globalSubscriberFrames: GlobalTaskServerFrame[] = [];
    const globalSubscriberWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn((data: string) => { globalSubscriberFrames.push(JSON.parse(data)); }),
      on: vi.fn(),
      once: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    await hub.handleConnection(globalSubscriberWs, 'user-a', db);

    const bridge = WsBridge.get('srv-a') as unknown as {
      db: Database | null;
      browserSockets: Set<WebSocket>;
      ingestGlobalTaskFleetSnapshot(db: Database, msg: Record<string, unknown>): Promise<void>;
      ingestGlobalTaskFrame(db: Database, msg: Record<string, unknown>): Promise<void>;
      relayToBrowsers(msg: Record<string, unknown>): void;
    };
    bridge.db = db;
    bridge.browserSockets.add(terminalBrowserWs);

    // fleet_snapshot never broadcasts to regular terminal browsers
    const fleetMsg = {
      type: GLOBAL_TASK_FLEET_SNAPSHOT_MSG,
      pairs: [
        {
          taskId: 'tsk_fleet',
          brain: 'deck_proj_brain',
          projectName: 'imcodes',
          title: 'Fleet Pair',
          status: 'working',
          flags: [],
          round: 1,
          checklist: { total: 4, implemented: 2, audited: 1 },
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
    };
    bridge.relayToBrowsers(fleetMsg);
    expect(browserReceived).toEqual([]);

    await bridge.ingestGlobalTaskFleetSnapshot(db, fleetMsg);
    expect(globalSubscriberFrames.some((f) => f.type === GLOBAL_TASK_MODE_MSG.UPSERT && f.task.taskId === 'tsk_fleet')).toBe(true);

    // Old daemon fallback: task_pair.event
    await bridge.ingestGlobalTaskFrame(db, {
      type: TIMELINE_MESSAGES.EVENT,
      event: {
        type: 'task_pair.event',
        sessionId: 'deck_proj_brain',
        ts: 3000,
        payload: {
          taskId: 'tsk_fleet',
          toStatus: 'in_audit',
          round: 2,
          flags: [],
        },
      },
    });
    const updatedRow = await getGlobalTaskSummaryForServerTask(db, 'srv-a', 'tsk_fleet');
    expect(updatedRow?.status).toBe('in_audit');
    expect(updatedRow?.checklist).toEqual({ total: 4, implemented: 2, audited: 1 });

    // assistant.text filtering: ignore streaming: true, automation: true, deck_sub_*, empty
    globalSubscriberFrames.length = 0;
    await bridge.ingestGlobalTaskFrame(db, {
      type: TIMELINE_MESSAGES.EVENT,
      event: {
        type: 'assistant.text',
        sessionId: 'deck_proj_brain',
        eventId: 'evt-stream',
        ts: 3100,
        payload: { text: 'streaming chunk', streaming: true },
      },
    });
    await bridge.ingestGlobalTaskFrame(db, {
      type: TIMELINE_MESSAGES.EVENT,
      event: {
        type: 'assistant.text',
        sessionId: 'deck_proj_brain',
        eventId: 'evt-auto',
        ts: 3101,
        payload: { text: 'automation', automation: true },
      },
    });
    await bridge.ingestGlobalTaskFrame(db, {
      type: TIMELINE_MESSAGES.EVENT,
      event: {
        type: 'assistant.text',
        sessionId: 'deck_sub_worker1',
        eventId: 'evt-sub',
        ts: 3102,
        payload: { text: 'subsession noise' },
      },
    });
    expect(globalSubscriberFrames).toEqual([]);

    // Stale historical assistant.text backfill (> 5m old) MUST NOT broadcast BRAIN_TEXT
    const staleBrainTs = Date.now() - 10 * 60 * 1000;
    await bridge.ingestGlobalTaskFrame(db, {
      type: TIMELINE_MESSAGES.EVENT,
      event: {
        type: 'assistant.text',
        sessionId: 'deck_proj_brain',
        eventId: 'evt-stale-backfill',
        ts: staleBrainTs,
        payload: { text: 'Old timeline replay.', streaming: false },
      },
    });
    expect(globalSubscriberFrames).toEqual([]);

    // Valid completed live Brain assistant.text pushes global_tasks.brain_text
    const liveBrainTs = Date.now();
    await bridge.ingestGlobalTaskFrame(db, {
      type: TIMELINE_MESSAGES.EVENT,
      event: {
        type: 'assistant.text',
        sessionId: 'deck_proj_brain',
        eventId: 'evt-real-1',
        ts: liveBrainTs,
        payload: { text: 'All tests are passing.', streaming: false },
      },
    });
    expect(globalSubscriberFrames).toContainEqual({
      type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT,
      event: {
        serverId: 'srv-a',
        serverName: 'Alpha Box',
        sessionName: 'deck_proj_brain',
        eventId: 'evt-real-1',
        text: 'All tests are passing.',
        ts: liveBrainTs,
      },
    });

    // Re-syncing identical fleet_snapshot or console SNAPSHOT MUST NOT re-broadcast unchanged rows
    globalSubscriberFrames.length = 0;
    await bridge.ingestGlobalTaskFleetSnapshot(db, {
      type: GLOBAL_TASK_FLEET_SNAPSHOT_MSG,
      pairs: [
        {
          taskId: 'tsk_fleet',
          brain: 'deck_proj_brain',
          projectName: 'imcodes',
          title: 'Fleet Pair',
          status: 'in_audit',
          flags: [],
          round: 2,
          checklist: { total: 4, implemented: 2, audited: 1 },
          createdAt: 1000,
          updatedAt: 3000,
        },
      ],
    });
    await bridge.ingestGlobalTaskFrame(db, {
      type: 'supervision.task_console.snapshot',
      scope: { projectName: 'imcodes', coordinatorSessionName: 'deck_proj_brain' },
      tasks: [
        {
          taskId: 'tsk_fleet',
          title: 'Fleet Pair',
          pair: {
            status: 'in_audit',
            flags: [],
            round: 2,
            checklist: { total: 4, implemented: 2, audited: 1 },
            brain: 'deck_proj_brain',
            createdAt: 1000,
            updatedAt: 3000,
          },
        },
      ],
    });
    // Out-of-order older task_pair.event MUST NOT regress status or broadcast UPSERT
    await bridge.ingestGlobalTaskFrame(db, {
      type: TIMELINE_MESSAGES.EVENT,
      event: {
        type: 'task_pair.event',
        sessionId: 'deck_proj_brain',
        ts: 2500,
        payload: {
          taskId: 'tsk_fleet',
          toStatus: 'working',
          round: 1,
          flags: [],
        },
      },
    });
    expect(globalSubscriberFrames).toEqual([]);
    expect((await getGlobalTaskSummaryForServerTask(db, 'srv-a', 'tsk_fleet'))?.status).toBe('in_audit');

    // Genuine change in console SNAPSHOT DOES broadcast UPSERT
    await bridge.ingestGlobalTaskFrame(db, {
      type: 'supervision.task_console.snapshot',
      scope: { projectName: 'imcodes', coordinatorSessionName: 'deck_proj_brain' },
      tasks: [
        {
          taskId: 'tsk_fleet',
          title: 'Fleet Pair',
          pair: {
            status: 'passed',
            flags: [],
            round: 2,
            checklist: { total: 4, implemented: 4, audited: 4 },
            brain: 'deck_proj_brain',
            createdAt: 1000,
            updatedAt: liveBrainTs,
          },
        },
      ],
    });
    expect(globalSubscriberFrames.some((f) => f.type === GLOBAL_TASK_MODE_MSG.UPSERT && f.task.taskId === 'tsk_fleet' && f.task.status === 'passed')).toBe(true);

    // Ensure separate Hub instance works too
    const standalone = new GlobalTaskHub();
    expect(standalone.isPgListening()).toBe(false);
    await standalone.stop();
  });

  it('enforces 2-day cutoff for terminal tasks while preserving older active tasks and closing active rows', async () => {
    const subscriberFrames: GlobalTaskServerFrame[] = [];
    const subscriberWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn((data: string) => { subscriberFrames.push(JSON.parse(data)); }),
      on: vi.fn(),
      once: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
    const fiveDaysAgo = now - 5 * 24 * 60 * 60 * 1000;

    // Seed an existing stale terminal row directly in DB (simulates pre-existing >2d DB record)
    memDb.summaries.set('srv-a\u0000tsk_db_stale_done', {
      server_id: 'srv-a',
      task_id: 'tsk_db_stale_done',
      project_name: 'imcodes',
      brain_session: 'deck_proj_brain',
      brain_label: 'Alpha Brain',
      title: 'Stale DB Done',
      status: 'done',
      flags_json: '[]',
      round: 1,
      checklist_total: 1,
      checklist_implemented: 1,
      checklist_audited: 1,
      executor_label: null,
      auditor_label: null,
      auditor: null,
      live_summary: null,
      is_terminal: true,
      needs_attention: false,
      created_at: threeDaysAgo - 10_000,
      updated_at: threeDaysAgo,
    });

    // Seed an active task updated 5 days ago
    await upsertGlobalTaskSummary(db, {
      serverId: 'srv-a',
      taskId: 'tsk_active_5d',
      projectName: 'imcodes',
      brainSession: 'deck_proj_brain',
      title: 'Long Active Task',
      status: 'working',
      updatedAt: fiveDaysAgo,
    });

    // Seed another active task that will transition to terminal with a >2d timestamp
    await upsertGlobalTaskSummary(db, {
      serverId: 'srv-a',
      taskId: 'tsk_active_to_old_done',
      projectName: 'imcodes',
      brainSession: 'deck_proj_brain',
      title: 'Closing Active Task',
      status: 'working',
      updatedAt: fiveDaysAgo,
    });

    await globalTaskHub.handleConnection(subscriberWs, 'user-a', db);
    subscriberFrames.length = 0;

    const bridge = WsBridge.get('srv-a') as unknown as {
      db: Database | null;
      ingestGlobalTaskFleetSnapshot(db: Database, msg: Record<string, unknown>): Promise<void>;
      ingestGlobalTaskFrame(db: Database, msg: Record<string, unknown>): Promise<void>;
    };
    bridge.db = db;

    // 1. fleet_snapshot & console SNAPSHOT skip >2d terminal tasks while keeping 1d terminal tasks and closing active rows
    await bridge.ingestGlobalTaskFleetSnapshot(db, {
      type: GLOBAL_TASK_FLEET_SNAPSHOT_MSG,
      pairs: [
        {
          taskId: 'tsk_recent_done_1d',
          brain: 'deck_proj_brain',
          projectName: 'imcodes',
          title: 'Recent Done 1d',
          status: 'done',
          flags: [],
          round: 1,
          checklist: { total: 2, implemented: 2, audited: 2 },
          createdAt: oneDayAgo - 10_000,
          updatedAt: oneDayAgo,
        },
        {
          taskId: 'tsk_stale_fleet_done_3d',
          brain: 'deck_proj_brain',
          projectName: 'imcodes',
          title: 'Stale Fleet Done 3d',
          status: 'done',
          flags: [],
          round: 1,
          checklist: { total: 2, implemented: 2, audited: 2 },
          createdAt: threeDaysAgo - 10_000,
          updatedAt: threeDaysAgo,
        },
      ],
    });

    await bridge.ingestGlobalTaskFrame(db, {
      type: 'supervision.task_console.snapshot',
      scope: { projectName: 'imcodes', coordinatorSessionName: 'deck_proj_brain' },
      tasks: [
        {
          taskId: 'tsk_stale_console_cancel_3d',
          title: 'Stale Console Cancelled 3d',
          pair: {
            status: 'cancelled',
            flags: [],
            round: 1,
            checklist: { total: 1, implemented: 0, audited: 0 },
            brain: 'deck_proj_brain',
            createdAt: threeDaysAgo - 10_000,
            updatedAt: threeDaysAgo,
          },
        },
        {
          taskId: 'tsk_active_to_old_done',
          title: 'Closing Active Task',
          pair: {
            status: 'done',
            flags: [],
            round: 1,
            checklist: { total: 1, implemented: 1, audited: 1 },
            brain: 'deck_proj_brain',
            createdAt: fiveDaysAgo,
            updatedAt: threeDaysAgo,
          },
        },
      ],
    });

    // Stale terminal tasks must NOT be persisted or broadcast
    expect(await getGlobalTaskSummaryForServerTask(db, 'srv-a', 'tsk_stale_fleet_done_3d')).toBeNull();
    expect(await getGlobalTaskSummaryForServerTask(db, 'srv-a', 'tsk_stale_console_cancel_3d')).toBeNull();
    expect(subscriberFrames.some((f) => f.type === GLOBAL_TASK_MODE_MSG.UPSERT && f.task.taskId === 'tsk_stale_fleet_done_3d')).toBe(false);
    expect(subscriberFrames.some((f) => f.type === GLOBAL_TASK_MODE_MSG.UPSERT && f.task.taskId === 'tsk_stale_console_cancel_3d')).toBe(false);

    // Recent terminal task (1d) WAS persisted & broadcast
    expect(subscriberFrames.some((f) => f.type === GLOBAL_TASK_MODE_MSG.UPSERT && f.task.taskId === 'tsk_recent_done_1d')).toBe(true);

    // Existing active task updated to terminal with >2d updatedAt WAS updated to terminal & broadcast so clients drop the active ghost
    const closedRow = await getGlobalTaskSummaryForServerTask(db, 'srv-a', 'tsk_active_to_old_done');
    expect(closedRow?.isTerminal).toBe(true);
    expect(closedRow?.status).toBe('done');
    expect(subscriberFrames.some((f) => f.type === GLOBAL_TASK_MODE_MSG.UPSERT && f.task.taskId === 'tsk_active_to_old_done' && f.task.isTerminal)).toBe(true);

    // Snapshot returns 5d-old active task and 1d-old terminal task, and excludes all >2d terminal tasks
    const snap = await listGlobalTaskSnapshotForUser(db, 'user-a');
    expect(snap.tasks.map((t) => t.taskId).sort()).toEqual(['tsk_active_5d', 'tsk_recent_done_1d']);
    expect(GLOBAL_TASK_TERMINAL_WINDOW_MS).toBe(2 * 24 * 60 * 60 * 1000);
  });

  it('closes real-time permission boundary when team_members or server is revoked mid-connection and via invalidation hooks', async () => {
    memDb.machineGroups.push({ server_id: 'srv-a', team_id: 'team-1' });
    memDb.teamMembers.push({ team_id: 'team-1', user_id: 'user-c', role: 'member' });
    await upsertGlobalTaskSummary(db, {
      serverId: 'srv-a',
      taskId: 'tsk_team',
      projectName: 'imcodes',
      brainSession: 'deck_proj_brain',
      title: 'Team Task',
      status: 'working',
      updatedAt: 1000,
    });

    const ownerFrames: GlobalTaskServerFrame[] = [];
    const ownerWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn((data: string) => { ownerFrames.push(JSON.parse(data)); }),
      on: vi.fn(),
      once: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    const memberFrames: GlobalTaskServerFrame[] = [];
    const memberWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn((data: string) => { memberFrames.push(JSON.parse(data)); }),
      on: vi.fn(),
      once: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    await globalTaskHub.handleConnection(ownerWs, 'user-a', db);
    await globalTaskHub.handleConnection(memberWs, 'user-c', db);
    expect(memberFrames[0]?.type).toBe(GLOBAL_TASK_MODE_MSG.SNAPSHOT);
    expect((memberFrames[0] as Extract<GlobalTaskServerFrame, { type: 'global_tasks.snapshot' }>).tasks).toHaveLength(1);

    // 1. Revoke team_members directly (without calling HTTP route), then emit task upsert & brain_text
    memberFrames.length = 0;
    ownerFrames.length = 0;
    memDb.teamMembers = [];

    await upsertGlobalTaskSummary(db, {
      serverId: 'srv-a',
      taskId: 'tsk_team',
      status: 'in_audit',
      updatedAt: 2000,
    });
    await globalTaskHub.notifyTaskUpdated(db, 'srv-a', 'tsk_team');
    await globalTaskHub.notifyBrainText(db, {
      serverId: 'srv-a',
      sessionName: 'deck_proj_brain',
      eventId: 'evt-after-tm-revoke',
      text: 'Private reply after member removal',
      ts: 3000,
    });
    await globalTaskHub.notifyServerState(db, 'srv-a', false);

    // Revoked member MUST NOT receive upsert, brain_text, or server_state — only cleaned snapshot
    expect(memberFrames.some((f) => f.type === GLOBAL_TASK_MODE_MSG.UPSERT)).toBe(false);
    expect(memberFrames.some((f) => f.type === GLOBAL_TASK_MODE_MSG.BRAIN_TEXT)).toBe(false);
    expect(memberFrames.some((f) => f.type === GLOBAL_TASK_MODE_MSG.SERVER_STATE)).toBe(false);
    expect(memberFrames).toContainEqual(expect.objectContaining({
      type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
      tasks: [],
      brains: [],
      servers: [],
    }));
    // Owner still receives the live pushes
    expect(ownerFrames.some((f) => f.type === GLOBAL_TASK_MODE_MSG.UPSERT && f.task.taskId === 'tsk_team')).toBe(true);
    expect(ownerFrames.some((f) => f.type === GLOBAL_TASK_MODE_MSG.BRAIN_TEXT && f.event.eventId === 'evt-after-tm-revoke')).toBe(true);

    // 2. Unified machine-group invalidation hook proactively purges snapshot even before next event
    memDb.teamMembers.push({ team_id: 'team-1', user_id: 'user-c', role: 'member' });
    await globalTaskHub.refreshUserAuthorization('user-c');
    memberFrames.length = 0;
    memDb.teamMembers = [];
    await applyMachineGroupInvalidation(db, { teamId: 'team-1', actorId: 'user-c', serverId: 'srv-a' });
    expect(memberFrames).toHaveLength(1);
    expect(memberFrames[0]).toMatchObject({
      type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
      tasks: [],
      brains: [],
      servers: [],
    });

    // 3. Server revocation mid-connection blocks owner's future upsert & brain_text and purges snapshot
    ownerFrames.length = 0;
    memDb.servers.get('srv-a')!.revoked_at = Date.now();
    await globalTaskHub.notifyTaskUpdated(db, 'srv-a', 'tsk_team', {
      serverId: 'srv-a',
      serverName: 'Alpha Box',
      serverOnline: true,
      projectName: 'imcodes',
      brainSession: 'deck_proj_brain',
      brainLabel: 'Alpha Brain',
      taskId: 'tsk_team',
      title: 'Team Task',
      status: 'done',
      flags: [],
      round: 1,
      checklist: { total: 0, implemented: 0, audited: 0 },
      createdAt: 1000,
      updatedAt: 4000,
      isTerminal: true,
      needsAttention: false,
    });
    await globalTaskHub.notifyBrainText(db, {
      serverId: 'srv-a',
      serverName: 'Alpha Box',
      sessionName: 'deck_proj_brain',
      eventId: 'evt-after-srv-revoke',
      text: 'Secret after server revoke',
      ts: 4000,
    });
    expect(ownerFrames.some((f) => f.type === GLOBAL_TASK_MODE_MSG.UPSERT)).toBe(false);
    expect(ownerFrames.some((f) => f.type === GLOBAL_TASK_MODE_MSG.BRAIN_TEXT)).toBe(false);
    expect(ownerFrames).toContainEqual(expect.objectContaining({
      type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
      tasks: [],
      servers: [],
    }));

    // 4. Disabled user account closed by account-watch
    memDb.users.get('user-a')!.status = 'disabled';
    const watchRes = await closeConnectionsOfInactiveUsers(db, []);
    expect(watchRes.browserSockets).toBeGreaterThanOrEqual(1);
    expect((ownerWs.close as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('fans out global_tasks.notification across PG NOTIFY / in-process to target user only and drops disabled accounts', async () => {
    const memDb = new InMemoryGlobalTaskDb();
    const db = memDb.asDatabase();
    memDb.servers.set('srv-a', {
      id: 'srv-a',
      user_id: 'user-a',
      team_id: null,
      name: 'Alpha Box',
      token_hash: 'h',
      last_heartbeat_at: Date.now(),
      status: 'online',
      daemon_version: '1.0.0',
      bound_with_key_id: null,
      created_at: 1000,
      node_role: 'full',
      revoked_at: null,
    });

    const userAFrames: GlobalTaskServerFrame[] = [];
    const userAWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn((data: string) => { userAFrames.push(JSON.parse(data)); }),
      on: vi.fn(),
      once: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    const userBFrames: GlobalTaskServerFrame[] = [];
    const userBWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn((data: string) => { userBFrames.push(JSON.parse(data)); }),
      on: vi.fn(),
      once: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    await globalTaskHub.handleConnection(userAWs, 'user-a', db);
    await globalTaskHub.handleConnection(userBWs, 'user-b', db);
    expect(globalTaskHub.hasLiveUserSocket('user-a')).toBe(true);
    expect(globalTaskHub.hasLiveUserSocket('user-c')).toBe(false);

    const framesFor = (frames: GlobalTaskServerFrame[]) => frames.slice(1);

    // 1. In-process dispatch delivers only to user-a, not user-b, and emits PG NOTIFY
    await globalTaskHub.notifyPushNotification(db, {
      userId: 'user-a',
      eventId: 'notif-1',
      title: 'Alpha Box · proj',
      body: 'Ready for review',
      notificationType: 'task_complete',
      serverId: 'srv-a',
      session: 'deck_proj_brain',
      eventType: 'session.idle',
      ts: 12345,
    });

    expect(framesFor(userAFrames)).toEqual([
      {
        type: GLOBAL_TASK_MODE_MSG.NOTIFICATION,
        event: {
          eventId: 'notif-1',
          title: 'Alpha Box · proj',
          body: 'Ready for review',
          notificationType: 'task_complete',
          serverId: 'srv-a',
          session: 'deck_proj_brain',
          eventType: 'session.idle',
          ts: 12345,
        },
      },
    ]);
    expect(framesFor(userBFrames)).toEqual([]);
    expect(memDb.pgNotifies.at(-1)?.channel).toBe(GLOBAL_TASK_NOTIFY_CHANNEL);
    expect(Buffer.byteLength(memDb.pgNotifies.at(-1)!.payload, 'utf8')).toBeLessThanOrEqual(GLOBAL_TASK_PG_NOTIFY_MAX_BYTES);

    // 2. PG NOTIFY replay delivers to user-a across pods
    await globalTaskHub.handleNotifyPayload(memDb.pgNotifies.at(-1)!.payload, db);
    expect(framesFor(userAFrames)).toHaveLength(2);
    expect(framesFor(userBFrames)).toHaveLength(0);

    // 3. Disabled user receives zero notifications and socket closes with 1008
    memDb.users.get('user-a')!.status = 'disabled';
    await globalTaskHub.notifyPushNotification(db, {
      userId: 'user-a',
      eventId: 'notif-blocked',
      title: 'Blocked',
      body: 'Should never reach disabled user',
      notificationType: 'remote_desktop',
      serverId: 'srv-a',
      ts: 12346,
    });
    expect(framesFor(userAFrames)).toHaveLength(2);
    expect((userAWs.close as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(1008, 'account_inactive');
  });

  it('round-trips startedAt and endedAt across fleet_snapshot, DB persistence, and legacy null rows', async () => {
    const now = Date.now();
    memDb.servers.set('srv-time', {
      id: 'srv-time',
      user_id: 'user-a',
      team_id: null,
      name: 'Timer Box',
      token_hash: 'h-time',
      last_heartbeat_at: now,
      status: 'online',
      daemon_version: '1.0.0',
      bound_with_key_id: null,
      created_at: now - 10_000,
    });

    // 1. Legacy row with null started_at and ended_at omits them safely without NaN
    memDb.summaries.set('srv-time\u0000tsk_legacy', {
      server_id: 'srv-time',
      task_id: 'tsk_legacy',
      project_name: 'imcodes',
      brain_session: 'deck_proj_brain',
      brain_label: 'Brain',
      title: 'Legacy row',
      status: 'done',
      flags_json: '[]',
      round: 1,
      checklist_total: 0,
      checklist_implemented: 0,
      checklist_audited: 0,
      executor_label: null,
      auditor_label: null,
      auditor: null,
      live_summary: null,
      is_terminal: true,
      needs_attention: false,
      started_at: null,
      ended_at: null,
      created_at: now - 50_000,
      updated_at: now - 10_000,
    });

    const legacy = await getGlobalTaskSummaryForServerTask(db, 'srv-time', 'tsk_legacy');
    expect(legacy?.startedAt).toBeUndefined();
    expect(legacy?.endedAt).toBeUndefined();
    expect(legacy?.createdAt).toBe(now - 50_000);

    // 2. WsBridge ingests fleet_snapshot with startedAt & endedAt, preserves startedAt on partial update, and clears endedAt on reopen
    const bridge = WsBridge.get('srv-time') as unknown as {
      ingestGlobalTaskFleetSnapshot(db: Database, msg: Record<string, unknown>): Promise<void>;
      ingestGlobalTaskFrame(db: Database, msg: Record<string, unknown>): Promise<void>;
    };
    await bridge.ingestGlobalTaskFleetSnapshot(db, {
      type: GLOBAL_TASK_FLEET_SNAPSHOT_MSG,
      pairs: [
        {
          taskId: 'tsk_timed',
          brain: 'deck_proj_brain',
          projectName: 'imcodes',
          title: 'Timed task',
          status: 'working',
          flags: [],
          round: 1,
          checklist: { total: 2, implemented: 1, audited: 0 },
          startedAt: now - 40_000,
          createdAt: now - 60_000,
          updatedAt: now - 5_000,
        },
        {
          taskId: 'tsk_done_timed',
          brain: 'deck_proj_brain',
          projectName: 'imcodes',
          title: 'Done timed',
          status: 'done',
          flags: [],
          round: 1,
          checklist: { total: 1, implemented: 1, audited: 1 },
          startedAt: now - 90_000,
          endedAt: now - 15_000,
          createdAt: now - 100_000,
          updatedAt: now - 10_000,
        },
      ],
    });

    const activeTimed = await getGlobalTaskSummaryForServerTask(db, 'srv-time', 'tsk_timed');
    expect(activeTimed?.startedAt).toBe(now - 40_000);
    expect(activeTimed?.endedAt).toBeUndefined();

    const doneTimed = await getGlobalTaskSummaryForServerTask(db, 'srv-time', 'tsk_done_timed');
    expect(doneTimed?.startedAt).toBe(now - 90_000);
    expect(doneTimed?.endedAt).toBe(now - 15_000);

    // Partial update omitting startedAt preserves existing startedAt; reopening done clears endedAt
    await upsertGlobalTaskSummary(db, {
      serverId: 'srv-time',
      taskId: 'tsk_timed',
      status: 'in_audit',
      updatedAt: now - 2_000,
    });
    const afterPartial = await getGlobalTaskSummaryForServerTask(db, 'srv-time', 'tsk_timed');
    expect(afterPartial?.startedAt).toBe(now - 40_000);

    await upsertGlobalTaskSummary(db, {
      serverId: 'srv-time',
      taskId: 'tsk_done_timed',
      status: 'working',
      updatedAt: now - 1_000,
    });
    const afterReopen = await getGlobalTaskSummaryForServerTask(db, 'srv-time', 'tsk_done_timed');
    expect(afterReopen?.startedAt).toBe(now - 90_000);
    expect(afterReopen?.endedAt).toBeUndefined();
  });

  it('resolves readable Brain, Executor, and Auditor display labels across snapshots and single-task queries', async () => {
    const now = Date.now();
    memDb.sessions.push(
      {
        id: 'sess-cd-unlabeled',
        server_id: 'srv-a',
        name: 'deck_cd_brain',
        project_name: 'cd',
        role: 'brain',
        agent_type: 'claude-code-sdk',
        agent_version: null,
        project_dir: '/repo/cd',
        state: 'idle',
        label: null,
        runtime_type: 'transport',
        provider_id: null,
        provider_session_id: null,
        description: null,
        created_at: now - 5000,
      },
      {
        id: 'sess-alpha-renamed',
        server_id: 'srv-a',
        name: 'deck_alpha_brain',
        project_name: 'alpha',
        role: 'brain',
        agent_type: 'codex-sdk',
        agent_version: null,
        project_dir: '/repo/alpha',
        state: 'idle',
        label: 'Alpha Renamed',
        runtime_type: 'transport',
        provider_id: null,
        provider_session_id: null,
        description: null,
        created_at: now - 4000,
      },
    );

    await upsertGlobalTaskSummariesBatch(db, 'srv-a', [
      {
        serverId: 'srv-a',
        taskId: 'tsk_cd_1',
        projectName: 'cd',
        brainSession: 'deck_cd_brain',
        brainLabel: 'deck_cd_brain',
        title: 'Task without explicit brain label',
        status: 'working',
        executorLabel: 'deck_sub_exec_1',
        auditorLabel: 'deck_sub_pair_auto_6ac6fe82aa0aecfc',
        auditor: 'deck_sub_pair_auto_6ac6fe82aa0aecfc',
        createdAt: now - 2000,
        updatedAt: now - 1000,
      },
      {
        serverId: 'srv-a',
        taskId: 'tsk_alpha_1',
        projectName: 'alpha',
        brainSession: 'deck_alpha_brain',
        brainLabel: 'Old Stale Name',
        title: 'Task with renamed live brain',
        status: 'working',
        executorLabel: 'Worker W1',
        auditorLabel: 'Reviewer Two',
        auditor: 'deck_sub_aud_2',
        createdAt: now - 2000,
        updatedAt: now - 500,
      },
    ]);

    const snapshot = await listGlobalTaskSnapshotForUser(db, 'user-a');
    expect(snapshot.brains.find((b) => b.sessionName === 'deck_cd_brain')?.label).toBe('cd');
    expect(snapshot.brains.find((b) => b.sessionName === 'deck_alpha_brain')?.label).toBe('Alpha Renamed');

    const cdTask = snapshot.tasks.find((t) => t.taskId === 'tsk_cd_1');
    expect(cdTask?.brainLabel).toBe('cd');
    expect(cdTask?.executorLabel).toBeUndefined();
    expect(cdTask?.auditorLabel).toBeUndefined();
    expect(cdTask?.auditor).toBe('deck_sub_pair_auto_6ac6fe82aa0aecfc');

    const alphaTask = snapshot.tasks.find((t) => t.taskId === 'tsk_alpha_1');
    expect(alphaTask?.brainLabel).toBe('Alpha Renamed');
    expect(alphaTask?.executorLabel).toBe('Worker W1');
    expect(alphaTask?.auditorLabel).toBe('Reviewer Two');

    const singleCd = await getGlobalTaskSummaryForServerTask(db, 'srv-a', 'tsk_cd_1');
    expect(singleCd?.brainLabel).toBe('cd');
    const singleAlpha = await getGlobalTaskSummaryForServerTask(db, 'srv-a', 'tsk_alpha_1');
    expect(singleAlpha?.brainLabel).toBe('Alpha Renamed');

    // Legacy DB rows with no project_name and no matching sessions row:
    // - explicit readable row.brain_label still wins
    // - internal-only row.brain_label/brain_session falls back to generic 'Brain', never raw IDs
    memDb.summaries.set('srv-a\u0000tsk_legacy_readable', {
      server_id: 'srv-a',
      task_id: 'tsk_legacy_readable',
      project_name: '',
      brain_session: 'deck_legacy_brain',
      brain_label: 'Legacy Brain',
      title: 'Legacy readable',
      status: 'done',
      flags_json: '[]',
      round: 1,
      checklist_total: 0,
      checklist_implemented: 0,
      checklist_audited: 0,
      executor_label: null,
      auditor_label: null,
      auditor: null,
      live_summary: null,
      is_terminal: true,
      needs_attention: false,
      created_at: now - 10_000,
      updated_at: now - 100,
    });
    memDb.summaries.set('srv-a\u0000tsk_legacy_internal', {
      server_id: 'srv-a',
      task_id: 'tsk_legacy_internal',
      project_name: '',
      brain_session: 'bootmainxowfy6',
      brain_label: 'bootmainxowfy6',
      title: 'Legacy internal only',
      status: 'working',
      flags_json: '[]',
      round: 1,
      checklist_total: 0,
      checklist_implemented: 0,
      checklist_audited: 0,
      executor_label: null,
      auditor_label: null,
      auditor: null,
      live_summary: null,
      is_terminal: false,
      needs_attention: false,
      created_at: now - 10_000,
      updated_at: now - 50,
    });

    const afterLegacySnapshot = await listGlobalTaskSnapshotForUser(db, 'user-a');
    expect(afterLegacySnapshot.tasks.find((t) => t.taskId === 'tsk_legacy_readable')?.brainLabel).toBe('Legacy Brain');
    const internalLegacy = afterLegacySnapshot.tasks.find((t) => t.taskId === 'tsk_legacy_internal');
    expect(internalLegacy?.brainLabel).toBe('Brain');
    expect(internalLegacy?.brainLabel).not.toContain('bootmain');
    expect(internalLegacy?.brainLabel).not.toContain('deck_');
  });

  it('aggregates 24h / 48h / 1w / 1m completion stats across active servers while keeping the 48h task card window unchanged', async () => {
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;
    const dayMs = 24 * hourMs;
    const makeRow = (
      serverId: string,
      taskId: string,
      status: string,
      opts: { startedAt?: number | null; endedAt?: number | null; createdAt: number; updatedAt: number },
    ) => {
      memDb.summaries.set(`${serverId}\u0000${taskId}`, {
        server_id: serverId,
        task_id: taskId,
        project_name: 'imcodes',
        brain_session: 'deck_cd_brain',
        brain_label: 'cd',
        title: taskId,
        status,
        flags_json: '[]',
        round: 1,
        checklist_total: 1,
        checklist_implemented: status === 'done' ? 1 : 0,
        checklist_audited: status === 'done' ? 1 : 0,
        executor_label: null,
        auditor_label: null,
        auditor: null,
        live_summary: null,
        is_terminal: status === 'done' || status === 'cancelled',
        needs_attention: false,
        created_at: opts.createdAt,
        updated_at: opts.updatedAt,
        started_at: opts.startedAt ?? null,
        ended_at: opts.endedAt ?? null,
      });
    };

    // srv-a: 1 in 24h (60s), 1 in 48h (120s), 1 in 1w (180s), 1 in 1m (240s), 1 >30d (ignored), 1 cancelled (ignored)
    makeRow('srv-a', 't_24h', 'done', { createdAt: now - 2 * hourMs, startedAt: now - hourMs - 60_000, endedAt: now - hourMs, updatedAt: now - hourMs });
    makeRow('srv-a', 't_48h', 'done', { createdAt: now - 30 * hourMs - 120_000, updatedAt: now - 30 * hourMs });
    makeRow('srv-a', 't_1w', 'done', { createdAt: now - 5 * dayMs - 180_000, startedAt: now - 5 * dayMs - 180_000, endedAt: now - 5 * dayMs, updatedAt: now - 5 * dayMs });
    makeRow('srv-a', 't_1m', 'done', { createdAt: now - 20 * dayMs - 240_000, startedAt: now - 20 * dayMs - 240_000, endedAt: now - 20 * dayMs, updatedAt: now - 20 * dayMs });
    makeRow('srv-a', 't_too_old', 'done', { createdAt: now - 35 * dayMs - 300_000, startedAt: now - 35 * dayMs - 300_000, endedAt: now - 35 * dayMs, updatedAt: now - 35 * dayMs });
    makeRow('srv-a', 't_cancelled', 'cancelled', { createdAt: now - hourMs, startedAt: now - hourMs, endedAt: now - 10_000, updatedAt: now - 10_000 });
    // srv-b: 1 in 24h (120s) to verify muted server filtering
    makeRow('srv-b', 't_srv_b_24h', 'done', { createdAt: now - hourMs, startedAt: now - 200_000, endedAt: now - 80_000, updatedAt: now - 80_000 });

    const snapAll = await listGlobalTaskSnapshotForUser(db, 'user-a');
    // Terminal card window stays 48h (excludes t_1w and t_1m cards)
    expect(snapAll.tasks.map((t) => t.taskId)).toContain('t_24h');
    expect(snapAll.tasks.map((t) => t.taskId)).toContain('t_48h');
    expect(snapAll.tasks.map((t) => t.taskId)).not.toContain('t_1w');
    expect(snapAll.tasks.map((t) => t.taskId)).not.toContain('t_1m');
    expect(snapAll.stats).toEqual({
      h24: { completedCount: 1, avgDurationMs: 60_000 },
      h48: { completedCount: 2, avgDurationMs: 90_000 },
      w1: { completedCount: 3, avgDurationMs: 120_000 },
      m1: { completedCount: 4, avgDurationMs: 150_000 },
    });

    // Muting srv-a zeros stats
    const snapMuted = await listGlobalTaskSnapshotForUser(db, 'user-a', ['srv-a']);
    expect(snapMuted.stats).toEqual({
      h24: { completedCount: 0, avgDurationMs: null },
      h48: { completedCount: 0, avgDurationMs: null },
      w1: { completedCount: 0, avgDurationMs: null },
      m1: { completedCount: 0, avgDurationMs: null },
    });
  });
});
