import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { DiscordHandler } from '../src/platform/handlers/discord/index.js';
import { FeishuHandler } from '../src/platform/handlers/feishu/index.js';
import { issueSharedMachineAuthority } from '../src/share/shared-machine-authority.js';
import {
  OWNER_MACHINE_AUTHORITY_FIELD,
  OWNER_MACHINE_AUTHORITY_TYPE,
  SHARED_MACHINE_AUTHORITY_FIELD,
  SHARED_MACHINE_AUTHORITY_HEADER,
  SHARED_MACHINE_AUTHORITY_TYPE,
} from '../../shared/shared-machine-authority.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { activeUserAnswer } from './helpers/user-status.js';

const JWT_KEY = 'test-signing-key-32chars-padding!!';
const DAEMON_TOKEN = 'daemon-token-hardening';
const DAEMON_TOKEN_HASH = createHash('sha256').update(DAEMON_TOKEN).digest('hex');

describe('cross-share & platform hardening regressions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('DiscordHandler channelId validation', () => {
    it('rejects malformed or path-traversal channelId before calling Discord API', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const handler = new DiscordHandler();
      const config = {
        botId: 'bot-1',
        userId: 'u-1',
        platform: 'discord',
        config: { botToken: 'tok' },
      } as never;

      for (const badChannelId of [
        '123456789012345678/../../pins',
        'guild:123456789012345678:extra',
        'guild:not-digits',
        '12345',
        '',
      ]) {
        await expect(
          handler.sendOutbound({ platform: 'discord', botId: 'bot-1', channelId: badChannelId, content: 'hi' }, config),
        ).rejects.toThrow('Invalid Discord channelId');
      }
      expect(fetchMock).not.toHaveBeenCalled();

      await handler.sendOutbound(
        { platform: 'discord', botId: 'bot-1', channelId: '987654321098765432:123456789012345678', content: 'ok' },
        config,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://discord.com/api/v10/channels/123456789012345678/messages',
        expect.anything(),
      );
    });
  });

  describe('FeishuHandler timingSafeEqual signature check', () => {
    it('accepts valid SHA-256 signature and rejects mismatched or different-length signatures', async () => {
      const handler = new FeishuHandler();
      const encryptKey = 'feishu-secret-key';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = 'nonce-123';
      const body = JSON.stringify({ event: { text: 'hello' } });
      const validSig = createHash('sha256').update(encryptKey + timestamp + nonce + body).digest('hex');

      const makeReq = (sig: string) => new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'X-Lark-Request-Timestamp': timestamp,
          'X-Lark-Request-Nonce': nonce,
          'X-Lark-Signature': sig,
        },
        body,
      });

      const cfg = { botId: 'b1', userId: 'u1', platform: 'feishu', config: { encryptKey } } as never;
      expect(await handler.verifyInbound(makeReq(validSig), cfg)).toBe(true);
      expect(await handler.verifyInbound(makeReq('0'.repeat(validSig.length)), cfg)).toBe(false);
      expect(await handler.verifyInbound(makeReq('short'), cfg)).toBe(false);
    });
  });

  describe('session-mgmt & sub-sessions daemon middleware blocks participant_daemon', () => {
    it('blocks participant_daemon on /api/server/:id/sessions and /sub-sessions while allowing absent authority', async () => {
      const { sessionMgmtRoutes } = await import('../src/routes/session-mgmt.js');
      const { subSessionRoutes } = await import('../src/routes/sub-sessions.js');

      const db = {
        queryOne: vi.fn(async (sql: string) => {
          { const activeUser = activeUserAnswer(sql); if (activeUser) return activeUser as never; }
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.startsWith('select exists (')) return { exists: true };
          if (s.includes('from servers')) {
            return {
              token_hash: DAEMON_TOKEN_HASH,
              owner_status: 'active',
              actor_status: 'active',
              user_status: 'active',
              user_id: 'owner-1',
              node_role: NODE_ROLE.FULL,
              revoked_at: null,
            };
          }
          if (s.includes('from sessions where server_id')) {
            return { project_name: 'proj', role: 'brain' };
          }
          return null;
        }),
        query: vi.fn(async (sql: string) => {
          const s = sql.toLowerCase();
          if (s.includes('from session_shares')) {
            return [{
              id: 'share-main-1',
              server_id: 'srv-1',
              target_kind: 'main',
              session_name: 'deck_proj_brain',
              target_user_id: 'part-1',
              role: 'participant',
              created_by: 'owner-1',
              created_at: 1,
              updated_at: 1,
              expires_at: null,
              revoked_at: null,
            }];
          }
          return [];
        }),
        execute: vi.fn(async () => ({ changes: 1 })),
      } as unknown as Database;

      const app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        c.env = {
          DB: db,
          JWT_SIGNING_KEY: JWT_KEY,
        } as Env;
        await next();
      });
      app.route('/api/server', sessionMgmtRoutes);
      app.route('/api/server', subSessionRoutes);

      const partToken = issueSharedMachineAuthority({
        type: SHARED_MACHINE_AUTHORITY_TYPE,
        sub: 'part-1',
        sourceServerId: 'srv-1',
        sessionName: 'deck_proj_brain',
        projectName: 'proj',
        shareTarget: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
        actionId: 'act-1',
      }, JWT_KEY);

      const partSessRes = await app.request('/api/server/srv-1/sessions', {
        headers: {
          Authorization: `Bearer ${DAEMON_TOKEN}`,
          'X-Server-Id': 'srv-1',
          [SHARED_MACHINE_AUTHORITY_HEADER]: partToken,
        },
      });
      expect(partSessRes.status).toBe(403);
      expect(await partSessRes.json()).toMatchObject({ reason: 'shared_participant_forbidden' });

      const partSubRes = await app.request('/api/server/srv-1/sub-sessions', {
        headers: {
          Authorization: `Bearer ${DAEMON_TOKEN}`,
          'X-Server-Id': 'srv-1',
          [SHARED_MACHINE_AUTHORITY_HEADER]: partToken,
        },
      });
      expect(partSubRes.status).toBe(403);
      expect(await partSubRes.json()).toMatchObject({ reason: 'shared_participant_forbidden' });

      // Background daemon sync (absent turn header) still succeeds
      const bgSessRes = await app.request('/api/server/srv-1/sessions', {
        headers: {
          Authorization: `Bearer ${DAEMON_TOKEN}`,
          'X-Server-Id': 'srv-1',
        },
      });
      expect(bgSessRes.status).toBe(200);
    }, 15_000);
  });

  describe('job-dispatch verifySharedCronCreatorStillAuthorized sub-session isolation', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('pauses a sub-session share cron job that targets bare targetRole or cross-session send, while dispatching own sub-session job', async () => {
      const sendToDaemon = vi.fn();
      vi.doMock('../src/ws/bridge.js', () => ({
        WsBridge: {
          publishResourceChanged: vi.fn(),
          get: () => ({
            isDaemonConnected: () => true,
            sendToDaemon,
          }),
        },
      }));

      const { dispatchJobNow } = await import('../src/cron/job-dispatch.js');
      const now = Date.now();
      const subShare = {
        id: 'share-sub-1',
        server_id: 'srv-1',
        target_kind: 'subsession',
        sub_session_id: 'allowed1',
        target_user_id: 'part-1',
        role: 'participant',
        created_by: 'owner-1',
        created_at: 1,
        updated_at: 1,
        expires_at: null,
        revoked_at: null,
      };
      const db = {
        queryOne: async (sql: string, params: unknown[] = []) => {
          { const activeUser = activeUserAnswer(sql); if (activeUser) return activeUser as never; }
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.startsWith('select exists (')) return { exists: true };
          if (s.includes('from servers')) {
            return {
              token_hash: DAEMON_TOKEN_HASH,
              owner_status: 'active',
              actor_status: 'active',
              user_status: 'active',
              user_id: 'owner-1',
              node_role: NODE_ROLE.FULL,
              revoked_at: null,
            };
          }
          if (s.includes('from cron_jobs')) {
            const jid = params[0] as string;
            if (jid === 'cron-bare') {
              return {
                id: 'cron-bare', server_id: 'srv-1', user_id: 'owner-1', name: 'bare',
                cron_expr: '0 9 * * *', project_name: 'proj', target_role: 'brain', target_session_name: null,
                action: JSON.stringify({ type: 'command', command: '/status' }),
                timezone: null, status: 'active', next_run_at: now, expires_at: null, completion_policy: 'recurring',
              };
            }
            if (jid === 'cron-cross-send') {
              return {
                id: 'cron-cross-send', server_id: 'srv-1', user_id: 'owner-1', name: 'cross',
                cron_expr: '0 9 * * *', project_name: 'proj', target_role: 'brain', target_session_name: 'deck_sub_allowed1',
                action: JSON.stringify({ type: 'send', target: 'w1', text: 'hi' }),
                timezone: null, status: 'active', next_run_at: now, expires_at: null, completion_policy: 'recurring',
              };
            }
            if (jid === 'cron-own-sub') {
              return {
                id: 'cron-own-sub', server_id: 'srv-1', user_id: 'owner-1', name: 'own',
                cron_expr: '0 9 * * *', project_name: 'proj', target_role: 'brain', target_session_name: 'deck_sub_allowed1',
                action: JSON.stringify({ type: 'command', command: '/status' }),
                timezone: null, status: 'active', next_run_at: now, expires_at: null, completion_policy: 'recurring',
              };
            }
          }
          if (s.includes('from cron_job_provenance')) {
            return { creator_user_id: 'part-1', shared: true };
          }
          if (s.includes('from sub_sessions where id')) {
            return { id: params[0], server_id: 'srv-1', closed_at: null, parent_session: 'deck_proj_brain', execution_clone_metadata: null };
          }
          return null;
        },
        query: async (sql: string) => {
          const s = sql.toLowerCase();
          if (s.includes('from sub_session_shares')) return [subShare];
          return [];
        },
        execute: async () => ({ changes: 1 }),
      } as unknown as Database;

      const env = { DB: db, JWT_SIGNING_KEY: JWT_KEY } as Env;

      await expect(dispatchJobNow(env, {
        id: 'cron-bare',
        server_id: 'srv-1',
        user_id: 'owner-1',
        name: 'bare',
        cron_expr: '0 9 * * *',
        project_name: 'proj',
        target_role: 'brain',
        target_session_name: null,
        action: JSON.stringify({ type: 'command', command: '/status' }),
        timezone: null,
        status: 'active',
        next_run_at: now,
        expires_at: null,
        completion_policy: 'recurring',
        created_at: now,
        updated_at: now,
        last_run_at: null,
      })).rejects.toThrow('share_revoked');
      expect(sendToDaemon).not.toHaveBeenCalled();

      await expect(dispatchJobNow(env, {
        id: 'cron-cross-send',
        server_id: 'srv-1',
        user_id: 'owner-1',
        name: 'cross',
        cron_expr: '0 9 * * *',
        project_name: 'proj',
        target_role: 'brain',
        target_session_name: 'deck_sub_allowed1',
        action: JSON.stringify({ type: 'send', target: 'w1', text: 'hi' }),
        timezone: null,
        status: 'active',
        next_run_at: now,
        expires_at: null,
        completion_policy: 'recurring',
        created_at: now,
        updated_at: now,
        last_run_at: null,
      })).rejects.toThrow('share_revoked');
      expect(sendToDaemon).not.toHaveBeenCalled();

      await dispatchJobNow(env, {
        id: 'cron-own-sub',
        server_id: 'srv-1',
        user_id: 'owner-1',
        name: 'own',
        cron_expr: '0 9 * * *',
        project_name: 'proj',
        target_role: 'brain',
        target_session_name: 'deck_sub_allowed1',
        action: JSON.stringify({ type: 'command', command: '/status' }),
        timezone: null,
        status: 'active',
        next_run_at: now,
        expires_at: null,
        completion_policy: 'recurring',
        created_at: now,
        updated_at: now,
        last_run_at: null,
      });
      expect(sendToDaemon).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(String(sendToDaemon.mock.calls[0]?.[0]));
      expect(sent.targetSessionName).toBe('deck_sub_allowed1');
      expect(sent.ownerMachineAuthority).toBeUndefined();
    });
  });

  describe('cron-api pinnedSessionName enforcement for participant_daemon', () => {
    it('enforces pinnedSessionName on POST, PUT, PATCH status, DELETE, and POST trigger', async () => {
      vi.resetModules();
      vi.doUnmock('../src/ws/bridge.js');
      const { cronApiRoutes } = await import('../src/routes/cron-api.js');
      const cronJobs = new Map<string, Record<string, unknown>>();
      const cronProvenance = new Map<string, Record<string, unknown>>();
      const db = {
        queryOne: async (sql: string, params: unknown[] = []) => {
          { const activeUser = activeUserAnswer(sql); if (activeUser) return activeUser as never; }
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.startsWith('select exists (')) return { exists: true };
          if (s.includes('from servers')) {
            return {
              token_hash: DAEMON_TOKEN_HASH,
              owner_status: 'active',
              actor_status: 'active',
              user_status: 'active',
              user_id: 'owner-1',
              node_role: NODE_ROLE.FULL,
              revoked_at: null,
            };
          }
          if (s.includes('from cron_job_provenance where job_id')) {
            return cronProvenance.get(params[0] as string) ?? null;
          }
          if (s.includes('from cron_jobs where id')) {
            return cronJobs.get(params[0] as string) ?? null;
          }
          if (s.includes('from sessions where server_id')) {
            return { project_name: 'proj', role: 'brain' };
          }
          return null;
        },
        query: async (sql: string) => {
          const s = sql.toLowerCase();
          if (s.includes('from session_shares')) {
            return [{
              id: 'share-main-1',
              server_id: 'srv-1',
              target_kind: 'main',
              session_name: 'deck_proj_brain',
              target_user_id: 'part-1',
              role: 'participant',
              created_by: 'owner-1',
              created_at: 1,
              updated_at: 1,
              expires_at: null,
              revoked_at: null,
            }];
          }
          return [];
        },
        execute: async () => ({ changes: 1 }),
      } as unknown as Database;

      const app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        c.env = {
          DB: db,
          JWT_SIGNING_KEY: JWT_KEY,
        } as Env;
        await next();
      });
      app.route('/api/server/:serverId/cron', cronApiRoutes);

      const partToken = issueSharedMachineAuthority({
        type: SHARED_MACHINE_AUTHORITY_TYPE,
        sub: 'part-1',
        sourceServerId: 'srv-1',
        sessionName: 'deck_proj_brain',
        projectName: 'proj',
        shareTarget: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
        actionId: 'act-cron-1',
      }, JWT_KEY);
      const headers = {
        Authorization: `Bearer ${DAEMON_TOKEN}`,
        'X-Server-Id': 'srv-1',
        [SHARED_MACHINE_AUTHORITY_HEADER]: partToken,
        'Content-Type': 'application/json',
      };

      const barePost = await app.request('/api/server/srv-1/cron', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'bare',
          cronExpr: '0 9 * * *',
          projectName: 'proj',
          targetRole: 'w1',
          action: { type: 'command', command: '/status' },
        }),
      });
      expect(barePost.status).toBe(403);

      cronJobs.set('job-unpinned', {
        id: 'job-unpinned',
        server_id: 'srv-1',
        user_id: 'owner-1',
        name: 'unpinned',
        cron_expr: '0 9 * * *',
        project_name: 'proj',
        target_role: 'w1',
        target_session_name: null,
        action: JSON.stringify({ type: 'command', command: '/status' }),
        status: 'active',
        next_run_at: Date.now() + 60_000,
        expires_at: null,
        completion_policy: 'recurring',
        created_at: 1,
        updated_at: 1,
        last_run_at: null,
      });
      cronProvenance.set('job-unpinned', {
        job_id: 'job-unpinned',
        creator_user_id: 'part-1',
        server_id: 'srv-1',
        project_name: 'proj',
        shared: true,
      });

      expect((await app.request('/api/server/srv-1/cron/job-unpinned', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ name: 'hijack' }),
      })).status).toBe(403);
      expect((await app.request('/api/server/srv-1/cron/job-unpinned/status', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status: 'paused' }),
      })).status).toBe(403);
      expect((await app.request('/api/server/srv-1/cron/job-unpinned?force=true', {
        method: 'DELETE',
        headers,
      })).status).toBe(403);
      expect((await app.request('/api/server/srv-1/cron/job-unpinned/trigger', {
        method: 'POST',
        headers,
      })).status).toBe(403);

      const pinnedPost = await app.request('/api/server/srv-1/cron', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'pinned-ok',
          cronExpr: '0 9 * * *',
          projectName: 'proj',
          targetRole: 'brain',
          action: { type: 'command', command: '/status' },
        }),
      });
      expect(pinnedPost.status).toBe(201);

      // Sub-session pinned participant_daemon rejects bare targetRole (no targetSessionName) and accepts matching deck_sub_*
      const subShareDb = {
        ...db,
        queryOne: async (sql: string, params: unknown[] = []) => {
          const s = sql.toLowerCase().replace(/\s+/g, ' ');
          if (s.includes('from sub_sessions ss')) {
            return { project_name: 'proj', parent_session: 'deck_proj_brain' };
          }
          if (s.includes('from sub_sessions where id')) {
            return { id: params[0], server_id: 'srv-1', closed_at: null, parent_session: 'deck_proj_brain', execution_clone_metadata: null };
          }
          return db.queryOne(sql, params);
        },
        query: async (sql: string) => {
          if (sql.toLowerCase().includes('from sub_session_shares')) {
            return [{
              id: 'share-sub-1',
              server_id: 'srv-1',
              target_kind: 'subsession',
              sub_session_id: 'allowed1',
              target_user_id: 'part-1',
              role: 'participant',
              created_by: 'owner-1',
              created_at: 1,
              updated_at: 1,
              expires_at: null,
              revoked_at: null,
            }];
          }
          return [];
        },
      } as unknown as Database;
      const subApp = new Hono<{ Bindings: Env }>();
      subApp.use('*', async (c, next) => {
        c.env = { DB: subShareDb, JWT_SIGNING_KEY: JWT_KEY } as Env;
        await next();
      });
      subApp.route('/api/server/:serverId/cron', cronApiRoutes);
      const subPartToken = issueSharedMachineAuthority({
        type: SHARED_MACHINE_AUTHORITY_TYPE,
        sub: 'part-1',
        sourceServerId: 'srv-1',
        sessionName: 'deck_sub_allowed1',
        projectName: 'proj',
        shareTarget: { kind: 'subsession', serverId: 'srv-1', subSessionId: 'allowed1' },
        actionId: 'act-cron-sub-1',
      }, JWT_KEY);
      const subHeaders = {
        Authorization: `Bearer ${DAEMON_TOKEN}`,
        'X-Server-Id': 'srv-1',
        [SHARED_MACHINE_AUTHORITY_HEADER]: subPartToken,
        'Content-Type': 'application/json',
      };
      expect((await subApp.request('/api/server/srv-1/cron', {
        method: 'POST',
        headers: subHeaders,
        body: JSON.stringify({
          name: 'sub-bare-rejected',
          cronExpr: '0 9 * * *',
          projectName: 'proj',
          targetRole: 'brain',
          action: { type: 'command', command: '/status' },
        }),
      })).status).toBe(403);
      expect((await subApp.request('/api/server/srv-1/cron', {
        method: 'POST',
        headers: subHeaders,
        body: JSON.stringify({
          name: 'sub-pinned-ok',
          cronExpr: '0 9 * * *',
          projectName: 'proj',
          targetRole: 'brain',
          targetSessionName: 'deck_sub_allowed1',
          action: { type: 'command', command: '/status' },
        }),
      })).status).toBe(201);
    });
  });

  describe('cron provenance atomicity, fail-closed reads, and scoped broadcast prevention', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('rolls back cron_jobs insert and update atomically when cron_job_provenance persistence fails', async () => {
      vi.doMock('../src/ws/bridge.js', () => ({
        WsBridge: { publishResourceChanged: vi.fn(), get: () => ({ isDaemonConnected: () => true, sendToDaemon: vi.fn() }) },
      }));
      const { cronApiRoutes } = await import('../src/routes/cron-api.js');

      const storedJobs = new Map<string, Record<string, unknown>>();
      const storedProv = new Map<string, { creator_user_id: string; shared: boolean }>();
      let failProvWrite = false;

      const makeTxClient = (draftJobs: Map<string, Record<string, unknown>>, draftProv: Map<string, { creator_user_id: string; shared: boolean }>) => ({
        queryOne: async (sql: string, params: unknown[] = []) => {
          { const activeUser = activeUserAnswer(sql); if (activeUser) return activeUser as never; }
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.startsWith('select exists (')) return { exists: true };
          if (s.includes('from servers')) {
            return {
              token_hash: DAEMON_TOKEN_HASH,
              owner_status: 'active',
              actor_status: 'active',
              user_status: 'active',
              user_id: 'owner-1',
              node_role: NODE_ROLE.FULL,
              revoked_at: null,
            };
          }
          if (s.includes('from sessions where server_id')) return { project_name: 'proj', role: 'brain' };
          if (s.includes('from cron_jobs where id')) return draftJobs.get(params[0] as string) ?? null;
          if (s.includes('from cron_job_provenance where job_id')) return draftProv.get(params[0] as string) ?? null;
          return null;
        },
        query: async (sql: string) => {
          const s = sql.toLowerCase();
          if (s.includes('from session_shares')) {
            return [{
              id: 'share-main-tx',
              server_id: 'srv-1',
              target_kind: 'main',
              session_name: 'deck_proj_brain',
              target_user_id: 'part-1',
              role: 'participant',
              created_by: 'owner-1',
              created_at: 1,
              updated_at: 1,
              expires_at: null,
              revoked_at: null,
            }];
          }
          return [];
        },
        execute: async (sql: string, params: unknown[] = []) => {
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.startsWith('insert into cron_jobs')) {
            draftJobs.set(params[0] as string, {
              id: params[0],
              server_id: params[1],
              user_id: params[2],
              name: params[3],
              cron_expr: params[4],
              project_name: params[5],
              target_role: params[6],
              target_session_name: params[7],
              action: params[8],
              timezone: params[9],
              status: params[10],
              next_run_at: params[11],
            });
            return { changes: 1 };
          }
          if (s.startsWith('update cron_jobs set')) {
            const jobId = params[params.length - 1] as string;
            const existing = draftJobs.get(jobId);
            if (!existing) return { changes: 0 };
            draftJobs.set(jobId, { ...existing, name: params[1], action: params[2] });
            return { changes: 1 };
          }
          if (s.includes('into cron_job_provenance')) {
            if (failProvWrite) throw new Error('simulated_provenance_write_failure');
            draftProv.set(params[0] as string, {
              creator_user_id: params[1] as string,
              shared: Boolean(params[2]),
            });
            return { changes: 1 };
          }
          return { changes: 1 };
        },
      });

      const txDb = {
        ...makeTxClient(storedJobs, storedProv),
        transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
          const draftJobs = new Map(storedJobs);
          const draftProv = new Map(storedProv);
          const res = await fn(makeTxClient(draftJobs, draftProv) as unknown as Database);
          storedJobs.clear();
          for (const [k, v] of draftJobs) storedJobs.set(k, v);
          storedProv.clear();
          for (const [k, v] of draftProv) storedProv.set(k, v);
          return res;
        },
      } as unknown as Database;

      const app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        c.env = { DB: txDb, JWT_SIGNING_KEY: JWT_KEY } as Env;
        await next();
      });
      app.route('/api/server/:serverId/cron', cronApiRoutes);

      const partToken = issueSharedMachineAuthority({
        type: SHARED_MACHINE_AUTHORITY_TYPE,
        sub: 'part-1',
        sourceServerId: 'srv-1',
        sessionName: 'deck_proj_brain',
        projectName: 'proj',
        shareTarget: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
        actionId: 'act-part-tx',
      }, JWT_KEY);
      const headers = {
        Authorization: `Bearer ${DAEMON_TOKEN}`,
        'X-Server-Id': 'srv-1',
        [SHARED_MACHINE_AUTHORITY_HEADER]: partToken,
        'Content-Type': 'application/json',
      };
      // 1) POST rollback on provenance write error
      failProvWrite = true;
      const postRes = await app.request('/api/server/srv-1/cron', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'should-rollback',
          cronExpr: '0 9 * * *',
          projectName: 'proj',
          targetRole: 'brain',
          action: { type: 'command', command: '/status' },
        }),
      });
      expect(postRes.status).toBe(500);
      expect(storedJobs.size).toBe(0);
      expect(storedProv.size).toBe(0);

      // 2) Seed valid job + provenance, then fail provenance upsert during PUT -> job row must remain untouched
      failProvWrite = false;
      const okPost = await app.request('/api/server/srv-1/cron', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'seed-job',
          cronExpr: '0 9 * * *',
          projectName: 'proj',
          targetRole: 'brain',
          action: { type: 'command', command: '/status' },
        }),
      });
      expect(okPost.status).toBe(201);
      const created = await okPost.json() as { id: string };
      expect(storedJobs.get(created.id)?.name).toBe('seed-job');

      failProvWrite = true;
      const putRes = await app.request(`/api/server/srv-1/cron/${created.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          name: 'mutated-should-rollback',
          action: { type: 'command', command: '/mutated' },
        }),
      });
      expect(putRes.status).toBe(500);
      expect(storedJobs.get(created.id)?.name).toBe('seed-job');
      expect(storedJobs.get(created.id)?.action).toBe(JSON.stringify({ type: 'command', command: '/status', onlyWhenIdle: true }));
    });

    it('fails closed in dispatchJobNow and jobDispatchCron when cron_job_provenance query fails (never minting authority or sending)', async () => {
      const sendToDaemon = vi.fn();
      vi.doMock('../src/ws/bridge.js', () => ({
        WsBridge: {
          publishResourceChanged: vi.fn(),
          get: () => ({ isDaemonConnected: () => true, sendToDaemon }),
        },
      }));
      const { dispatchJobNow, jobDispatchCron } = await import('../src/cron/job-dispatch.js');
      const now = Date.now();
      const executions = new Map<string, string>();
      const baseJob = {
        id: 'cron-prov-err',
        server_id: 'srv-1',
        user_id: 'owner-1',
        name: 'prov-err-job',
        cron_expr: '*/5 * * * *',
        project_name: 'proj',
        target_role: 'brain',
        target_session_name: 'deck_proj_brain',
        action: JSON.stringify({ type: 'command', command: '/status' }),
        timezone: null,
        expires_at: null,
        completion_policy: 'recurring',
        last_run_at: null,
        next_run_at: now - 1000,
        status: 'active',
        execution_id: 'exec-1',
      };
      const db = {
        queryOne: async (sql: string) => {
          { const activeUser = activeUserAnswer(sql); if (activeUser) return activeUser as never; }
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.includes('cron_job_provenance')) throw new Error('db_provenance_read_timeout');
          if (s.includes('from servers where id')) return { user_id: 'owner-1', owner_status: 'active', actor_status: 'active' };
          if (s.includes('from cron_jobs')) return baseJob;
          return null;
        },
        query: async (sql: string) => {
          const s = sql.toLowerCase();
          if (s.includes('from cron_executions e')) return [];
          if (s.includes('from cron_jobs')) return [baseJob];
          return [];
        },
        execute: async (sql: string, params: unknown[] = []) => {
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.startsWith('insert into cron_executions')) {
            executions.set(params[0] as string, params[2] as string);
          } else if (s.startsWith('update cron_executions set status = $1 where id = $2')) {
            executions.set(params[1] as string, params[0] as string);
          }
          return { changes: 1 };
        },
        transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db),
      } as unknown as Database;
      executions.set('exec-1', 'dispatching');

      await expect(dispatchJobNow({ DB: db, JWT_SIGNING_KEY: JWT_KEY } as Env, baseJob as never)).rejects.toThrow('db_provenance_read_timeout');
      expect(sendToDaemon).not.toHaveBeenCalled();

      await jobDispatchCron({ DB: db, JWT_SIGNING_KEY: JWT_KEY } as Env);
      expect(sendToDaemon).not.toHaveBeenCalled();
      // Execution remains retryable (pending_dispatch) rather than marked dispatched or cancelled
      const statuses = [...executions.values()];
      expect(statuses).not.toContain('dispatched');
      expect(statuses).toContain('pending_dispatch');
    });

    it('rejects broadcast send escape for sub-session and main shares across API and dispatch while keeping scoped command and whole-server broadcast working', async () => {
      const sendToDaemon = vi.fn();
      vi.doMock('../src/ws/bridge.js', () => ({
        WsBridge: {
          publishResourceChanged: vi.fn(),
          get: () => ({ isDaemonConnected: () => true, sendToDaemon }),
        },
      }));
      const { cronApiRoutes } = await import('../src/routes/cron-api.js');
      const { dispatchJobNow, jobDispatchCron } = await import('../src/cron/job-dispatch.js');
      const now = Date.now();

      const activeShares = [
        {
          id: 'share-sub-1',
          server_id: 'srv-1',
          target_kind: 'subsession',
          sub_session_id: 'allowed1',
          target_user_id: 'part-sub',
          role: 'participant',
          created_by: 'owner-1',
          created_at: 1,
          updated_at: 1,
          expires_at: null,
          revoked_at: null,
        },
        {
          id: 'share-main-1',
          server_id: 'srv-1',
          target_kind: 'main',
          session_name: 'deck_proj_brain',
          target_user_id: 'part-main',
          role: 'participant',
          created_by: 'owner-1',
          created_at: 1,
          updated_at: 1,
          expires_at: null,
          revoked_at: null,
        },
        {
          id: 'share-srv-1',
          server_id: 'srv-1',
          target_kind: 'server',
          target_user_id: 'part-srv',
          role: 'participant',
          created_by: 'owner-1',
          created_at: 1,
          updated_at: 1,
          expires_at: null,
          revoked_at: null,
        },
      ];

      let existingJobProvenance = { creator_user_id: 'part-sub', shared: true };
      const db = {
        queryOne: async (sql: string, params: unknown[] = []) => {
          { const activeUser = activeUserAnswer(sql); if (activeUser) return activeUser as never; }
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.startsWith('select exists (')) return { exists: true };
          if (s.includes('from servers')) {
            return {
              token_hash: DAEMON_TOKEN_HASH,
              owner_status: 'active',
              actor_status: 'active',
              user_status: 'active',
              user_id: 'owner-1',
              node_role: NODE_ROLE.FULL,
              revoked_at: null,
            };
          }
          if (s.includes('from sessions where server_id')) {
            return { project_name: 'proj' };
          }
          if (s.includes('from sub_sessions where id')) {
            return { id: params[0], server_id: 'srv-1', closed_at: null, parent_session: 'deck_proj_brain', execution_clone_metadata: null };
          }
          if (s.includes('from cron_job_provenance')) {
            return existingJobProvenance;
          }
          if (s.includes('from cron_jobs') && params[0] === 'cron-sub-bcast') {
            return {
              id: 'cron-sub-bcast', server_id: 'srv-1', user_id: 'owner-1', name: 'sub-bcast',
              cron_expr: '0 9 * * *', project_name: 'proj', target_role: 'brain', target_session_name: 'deck_sub_allowed1',
              action: JSON.stringify({ type: 'send', target: 'deck_sub_allowed1', message: 'hi', broadcast: true }),
              timezone: null, expires_at: null, completion_policy: 'recurring', last_run_at: null, next_run_at: now + 60_000, status: 'active',
            };
          }
          if (s.includes('from cron_jobs') && params[0] === 'cron-main-bcast') {
            return {
              id: 'cron-main-bcast', server_id: 'srv-1', user_id: 'owner-1', name: 'main-bcast',
              cron_expr: '0 9 * * *', project_name: 'proj', target_role: 'brain', target_session_name: 'deck_proj_brain',
              action: JSON.stringify({ type: 'send', target: 'deck_proj_brain', message: 'hi', broadcast: true }),
              timezone: null, expires_at: null, completion_policy: 'recurring', last_run_at: null, next_run_at: now + 60_000, status: 'active',
            };
          }
          if (s.includes('from cron_jobs') && params[0] === 'job-sub-1') {
            return {
              id: params[0],
              user_id: 'owner-1',
              server_id: 'srv-1',
              project_name: 'proj',
              target_role: 'brain',
              target_session_name: 'deck_sub_allowed1',
              name: 'existing-sub',
              cron_expr: '0 9 * * *',
              action: JSON.stringify({ type: 'command', command: '/status' }),
              status: 'active',
            };
          }
          return null;
        },
        query: async (sql: string, params: unknown[] = []) => {
          const s = sql.toLowerCase();
          if (s.includes('union all')) {
            return activeShares.filter((r) => params.includes(r.target_user_id));
          }
          if (s.includes('from server_shares')) {
            return activeShares.filter((r) => r.target_kind === 'server' && params.includes(r.target_user_id));
          }
          if (s.includes('from session_shares')) {
            return activeShares.filter((r) => r.target_kind === 'main' && params.includes(r.target_user_id));
          }
          if (s.includes('from sub_session_shares')) {
            return activeShares.filter((r) => r.target_kind === 'subsession' && params.includes(r.target_user_id));
          }
          if (s.includes('from cron_jobs')) return [];
          return [];
        },
        execute: async () => ({ changes: 1 }),
      } as unknown as Database;

      const app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        c.env = { DB: db, JWT_SIGNING_KEY: JWT_KEY } as Env;
        await next();
      });
      app.route('/api/server/:serverId/cron', cronApiRoutes);

      const subHeaders = {
        Authorization: `Bearer ${DAEMON_TOKEN}`,
        'X-Server-Id': 'srv-1',
        [SHARED_MACHINE_AUTHORITY_HEADER]: issueSharedMachineAuthority({
          type: SHARED_MACHINE_AUTHORITY_TYPE,
          sub: 'part-sub',
          sourceServerId: 'srv-1',
          sessionName: 'deck_sub_allowed1',
          projectName: 'proj',
          shareTarget: { kind: 'subsession', serverId: 'srv-1', subSessionId: 'allowed1' },
          actionId: 'act-bcast-sub',
        }, JWT_KEY),
        'Content-Type': 'application/json',
      };
      const mainHeaders = {
        Authorization: `Bearer ${DAEMON_TOKEN}`,
        'X-Server-Id': 'srv-1',
        [SHARED_MACHINE_AUTHORITY_HEADER]: issueSharedMachineAuthority({
          type: SHARED_MACHINE_AUTHORITY_TYPE,
          sub: 'part-main',
          sourceServerId: 'srv-1',
          sessionName: 'deck_proj_brain',
          projectName: 'proj',
          shareTarget: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
          actionId: 'act-bcast-main',
        }, JWT_KEY),
        'Content-Type': 'application/json',
      };
      const { signJwt } = await import('../src/security/crypto.js');
      const srvWebHeaders = {
        Authorization: `Bearer ${signJwt({ sub: 'part-srv', type: 'web' }, JWT_KEY, 3600)}`,
        'Content-Type': 'application/json',
      };

      // API POST & PUT reject broadcast: true for subsession and main shares
      expect((await app.request('/api/server/srv-1/cron', {
        method: 'POST',
        headers: subHeaders,
        body: JSON.stringify({
          name: 'sub-bcast',
          cronExpr: '0 9 * * *',
          projectName: 'proj',
          targetRole: 'brain',
          targetSessionName: 'deck_sub_allowed1',
          action: { type: 'send', target: 'deck_sub_allowed1', message: 'hi', broadcast: true },
        }),
      })).status).toBe(403);

      expect((await app.request('/api/server/srv-1/cron/job-sub-1', {
        method: 'PUT',
        headers: subHeaders,
        body: JSON.stringify({
          action: { type: 'send', target: 'deck_sub_allowed1', message: 'hi', broadcast: true },
        }),
      })).status).toBe(403);

      expect((await app.request('/api/server/srv-1/cron', {
        method: 'POST',
        headers: mainHeaders,
        body: JSON.stringify({
          name: 'main-bcast',
          cronExpr: '0 9 * * *',
          projectName: 'proj',
          targetRole: 'brain',
          action: { type: 'send', target: 'brain', message: 'hi', broadcast: true },
        }),
      })).status).toBe(403);

      // Whole-server share keeps broadcast send working on API (via web user auth, not a session-pinned turn)
      expect((await app.request('/api/server/srv-1/cron', {
        method: 'POST',
        headers: srvWebHeaders,
        body: JSON.stringify({
          name: 'srv-bcast',
          cronExpr: '0 9 * * *',
          projectName: 'proj',
          targetRole: 'brain',
          action: { type: 'send', target: 'brain', message: 'hi', broadcast: true },
        }),
      })).status).toBe(201);

      // Manual dispatchJobNow rejects persisted broadcast: true for subsession & main shares without sending
      existingJobProvenance = { creator_user_id: 'part-sub', shared: true };
      await expect(dispatchJobNow({ DB: db, JWT_SIGNING_KEY: JWT_KEY } as Env, {
        id: 'cron-sub-bcast',
        server_id: 'srv-1',
        user_id: 'owner-1',
        name: 'sub-bcast',
        cron_expr: '0 9 * * *',
        project_name: 'proj',
        target_role: 'brain',
        target_session_name: 'deck_sub_allowed1',
        action: JSON.stringify({ type: 'send', target: 'deck_sub_allowed1', message: 'hi', broadcast: true }),
        timezone: null,
        expires_at: null,
        completion_policy: 'recurring',
        last_run_at: null,
        next_run_at: now + 60_000,
        status: 'active',
      } as never)).rejects.toThrow('share_revoked');
      expect(sendToDaemon).not.toHaveBeenCalled();

      existingJobProvenance = { creator_user_id: 'part-main', shared: true };
      await expect(dispatchJobNow({ DB: db, JWT_SIGNING_KEY: JWT_KEY } as Env, {
        id: 'cron-main-bcast',
        server_id: 'srv-1',
        user_id: 'owner-1',
        name: 'main-bcast',
        cron_expr: '0 9 * * *',
        project_name: 'proj',
        target_role: 'brain',
        target_session_name: 'deck_proj_brain',
        action: JSON.stringify({ type: 'send', target: 'deck_proj_brain', message: 'hi', broadcast: true }),
        timezone: null,
        expires_at: null,
        completion_policy: 'recurring',
        last_run_at: null,
        next_run_at: now + 60_000,
        status: 'active',
      } as never)).rejects.toThrow('share_revoked');
      expect(sendToDaemon).not.toHaveBeenCalled();

      // Scheduled jobDispatchCron rejects broadcast escape without sending, while dispatching whole-server broadcast & scoped command
      const schedDb = {
        ...db,
        queryOne: async (sql: string, params: unknown[] = []) => {
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.includes('from cron_job_provenance')) {
            const jid = params[0] as string;
            if (jid === 'sched-sub-bcast') return { creator_user_id: 'part-sub', shared: true };
            if (jid === 'sched-sub-cmd') return { creator_user_id: 'part-sub', shared: true };
            if (jid === 'sched-srv-bcast') return { creator_user_id: 'part-srv', shared: true };
          }
          return db.queryOne(sql, params);
        },
        query: async (sql: string, params: unknown[] = []) => {
          const s = sql.toLowerCase();
          if (s.includes('from cron_jobs')) {
            return [
              {
                id: 'sched-sub-bcast',
                server_id: 'srv-1',
                user_id: 'owner-1',
                name: 'sub-bcast',
                cron_expr: '0 9 * * *',
                project_name: 'proj',
                target_role: 'brain',
                target_session_name: 'deck_sub_allowed1',
                action: JSON.stringify({ type: 'send', target: 'deck_sub_allowed1', message: 'hi', broadcast: true }),
                timezone: null,
                expires_at: null,
                completion_policy: 'recurring',
                last_run_at: null,
                next_run_at: now - 1000,
                status: 'active',
              },
              {
                id: 'sched-sub-cmd',
                server_id: 'srv-1',
                user_id: 'owner-1',
                name: 'sub-cmd',
                cron_expr: '0 9 * * *',
                project_name: 'proj',
                target_role: 'brain',
                target_session_name: 'deck_sub_allowed1',
                action: JSON.stringify({ type: 'command', command: '/status' }),
                timezone: null,
                expires_at: null,
                completion_policy: 'recurring',
                last_run_at: null,
                next_run_at: now - 1000,
                status: 'active',
              },
              {
                id: 'sched-srv-bcast',
                server_id: 'srv-1',
                user_id: 'owner-1',
                name: 'srv-bcast',
                cron_expr: '0 9 * * *',
                project_name: 'proj',
                target_role: 'brain',
                target_session_name: null,
                action: JSON.stringify({ type: 'send', target: 'brain', message: 'ok', broadcast: true }),
                timezone: null,
                expires_at: null,
                completion_policy: 'recurring',
                last_run_at: null,
                next_run_at: now - 1000,
                status: 'active',
              },
            ];
          }
          return db.query(sql, params);
        },
      } as unknown as Database;

      await jobDispatchCron({ DB: schedDb, JWT_SIGNING_KEY: JWT_KEY } as Env);
      const sentIds = sendToDaemon.mock.calls.map((call) => JSON.parse(call[0] as string).jobId as string);
      expect(sentIds).toEqual(['sched-sub-cmd', 'sched-srv-bcast']);
    });

    it('rejects concurrent PUT scope shifts inside transaction and binds job-dispatch to single-snapshot (job, provenance)', async () => {
      const sendToDaemon = vi.fn();
      vi.doMock('../src/ws/bridge.js', () => ({
        WsBridge: {
          publishResourceChanged: vi.fn(),
          get: () => ({
            isDaemonConnected: () => true,
            supportsExactCronSend: () => true,
            sendToDaemon,
          }),
        },
      }));
      const { cronApiRoutes } = await import('../src/routes/cron-api.js');
      const { jobDispatchCron, dispatchJobNow } = await import('../src/cron/job-dispatch.js');
      const now = Date.now();

      // 1) Concurrent writer retargets a shared job between PUT pre-read and tx lock acquisition
      const liveJob: Record<string, unknown> = {
        id: 'cron-race-1',
        server_id: 'srv-1',
        user_id: 'owner-1',
        name: 'orig-name',
        cron_expr: '0 9 * * *',
        project_name: 'proj',
        target_role: 'brain',
        target_session_name: 'deck_proj_brain',
        action: JSON.stringify({ type: 'command', command: '/status' }),
        timezone: null,
        expires_at: null,
        completion_policy: 'recurring',
        last_run_at: null,
        next_run_at: now + 60_000,
        status: 'active',
        created_at: now,
        updated_at: now,
      };
      const liveProv = { job_id: 'cron-race-1', creator_user_id: 'part-main', server_id: 'srv-1', project_name: 'proj', shared: true };
      let injectedRaceOnTx = false;

      const raceDb = {
        queryOne: async (sql: string, params: unknown[] = []) => {
          { const activeUser = activeUserAnswer(sql); if (activeUser) return activeUser as never; }
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.startsWith('select exists (')) return { exists: true };
          if (s.includes('from servers')) {
            return {
              token_hash: DAEMON_TOKEN_HASH,
              owner_status: 'active',
              actor_status: 'active',
              user_status: 'active',
              user_id: 'owner-1',
              node_role: NODE_ROLE.FULL,
              revoked_at: null,
            };
          }
          if (s.includes('from sessions where server_id')) return { project_name: 'proj', role: 'brain' };
          if (s.includes('from sub_sessions where id')) {
            return { id: params[0], server_id: 'srv-1', closed_at: null, parent_session: 'deck_other_brain', execution_clone_metadata: null };
          }
          if (s.includes('from cron_jobs where id')) return { ...liveJob };
          if (s.includes('from cron_job_provenance where job_id')) return { ...liveProv };
          return null;
        },
        query: async (sql: string) => {
          const s = sql.toLowerCase();
          if (s.includes('from session_shares')) {
            return [{
              id: 'share-main-race',
              server_id: 'srv-1',
              target_kind: 'main',
              session_name: 'deck_proj_brain',
              target_user_id: 'part-main',
              role: 'participant',
              created_by: 'owner-1',
              created_at: 1,
              updated_at: 1,
              expires_at: null,
              revoked_at: null,
            }];
          }
          return [];
        },
        execute: async () => ({ changes: 1 }),
        transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
          // Simulate concurrent owner update moving the job to an out-of-scope project right before tx lock
          if (!injectedRaceOnTx) {
            injectedRaceOnTx = true;
            liveJob.project_name = 'other-proj';
            liveJob.target_session_name = 'deck_sub_other';
            liveJob.updated_at = now + 500;
          }
          return fn(raceDb as unknown as Database);
        },
      } as unknown as Database;

      const app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        c.env = { DB: raceDb, JWT_SIGNING_KEY: JWT_KEY } as Env;
        await next();
      });
      app.route('/api/server/:serverId/cron', cronApiRoutes);

      const partToken = issueSharedMachineAuthority({
        type: SHARED_MACHINE_AUTHORITY_TYPE,
        sub: 'part-main',
        sourceServerId: 'srv-1',
        sessionName: 'deck_proj_brain',
        projectName: 'proj',
        shareTarget: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
        actionId: 'act-race-1',
      }, JWT_KEY);

      const racePut = await app.request('/api/server/srv-1/cron/cron-race-1', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${DAEMON_TOKEN}`,
          'X-Server-Id': 'srv-1',
          [SHARED_MACHINE_AUTHORITY_HEADER]: partToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'hijacked-after-retarget' }),
      });
      expect(racePut.status).toBe(403);
      expect(liveJob.name).toBe('orig-name');

      // 2) Claimed snapshot consistency: claimDueJobs locks job (old action from revoked creator).
      //    After claim commits, provenance creator is swapped to an active participant.
      //    jobDispatchCron MUST evaluate the snapshot provenance captured with the claimed job ('part-revoked'), NOT 'part-active'.
      let claimCommitted = false;
      const snapshotDb = {
        queryOne: async (sql: string, params: unknown[] = []) => {
          { const activeUser = activeUserAnswer(sql); if (activeUser) return activeUser as never; }
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.startsWith('select exists (')) return { exists: true };
          if (s.includes('from servers where id')) {
            return { user_id: 'owner-1', owner_status: 'active', actor_status: 'active' };
          }
          if (s.includes('from sessions where server_id')) return { project_name: 'proj', role: 'brain' };
          if (s.includes('from cron_job_provenance where job_id')) {
            return { creator_user_id: claimCommitted ? 'part-active' : 'part-revoked', shared: true };
          }
          if (s.includes('from cron_jobs')) {
            return {
              id: params[0],
              server_id: 'srv-1',
              user_id: 'owner-1',
              name: 'snap-job',
              cron_expr: '0 9 * * *',
              project_name: 'proj',
              target_role: 'brain',
              target_session_name: null,
              action: JSON.stringify({ type: 'command', command: claimCommitted ? '/new-safe' : '/old-revoked' }),
              timezone: null,
              expires_at: null,
              completion_policy: 'recurring',
              last_run_at: null,
              next_run_at: now - 1000,
              status: 'active',
            };
          }
          return null;
        },
        query: async (sql: string, params: unknown[] = []) => {
          const s = sql.toLowerCase();
          if (s.includes('from cron_executions e')) return [];
          if (s.includes('from cron_jobs')) {
            return [{
              id: 'cron-snap-1',
              server_id: 'srv-1',
              user_id: 'owner-1',
              name: 'snap-job',
              cron_expr: '0 9 * * *',
              project_name: 'proj',
              target_role: 'brain',
              target_session_name: null,
              action: JSON.stringify({ type: 'command', command: '/old-revoked' }),
              timezone: null,
              expires_at: null,
              completion_policy: 'recurring',
              last_run_at: null,
              next_run_at: now - 1000,
              status: 'active',
            }];
          }
          if (s.includes('union all') || s.includes('from session_shares')) {
            if (params.includes('part-active')) {
              return [{
                id: 'share-main-active',
                server_id: 'srv-1',
                target_kind: 'main',
                session_name: 'deck_proj_brain',
                target_user_id: 'part-active',
                role: 'participant',
                created_by: 'owner-1',
                created_at: 1,
                updated_at: 1,
                expires_at: null,
                revoked_at: null,
              }];
            }
          }
          return [];
        },
        execute: async (sql: string) => {
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.startsWith('insert into cron_executions')) {
            // Once claimDueJobs writes the pending_dispatch outbox, swap live provenance to part-active
            claimCommitted = true;
          }
          return { changes: 1 };
        },
        transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => fn(snapshotDb as unknown as Database),
      } as unknown as Database;

      await jobDispatchCron({ DB: snapshotDb, JWT_SIGNING_KEY: JWT_KEY } as Env);
      expect(sendToDaemon).not.toHaveBeenCalled();

      // Same-snapshot read in dispatchJobNow: passing stale object still dispatches paired fresh (action, prov)
      await dispatchJobNow({ DB: snapshotDb, JWT_SIGNING_KEY: JWT_KEY } as Env, {
        id: 'cron-snap-1',
        server_id: 'srv-1',
        user_id: 'owner-1',
        name: 'snap-job',
        cron_expr: '0 9 * * *',
        project_name: 'proj',
        target_role: 'brain',
        target_session_name: null,
        action: JSON.stringify({ type: 'command', command: '/old-revoked' }),
        timezone: null,
        expires_at: null,
        completion_policy: 'recurring',
        last_run_at: null,
        next_run_at: now + 60_000,
        status: 'active',
      } as never);
      expect(sendToDaemon).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sendToDaemon.mock.calls[0]![0] as string).action).toEqual({ type: 'command', command: '/new-safe' });
    });

    it('rejects fuzzy label/agentType send targets on scoped shares and refuses old daemons lacking exact cron send support', async () => {
      let supportsExact = false;
      const sendToDaemon = vi.fn();
      vi.doMock('../src/ws/bridge.js', () => ({
        WsBridge: {
          publishResourceChanged: vi.fn(),
          get: () => ({
            isDaemonConnected: () => true,
            hasDaemonCapability: (cap: string) => supportsExact && cap === 'cron_exact_send_v1',
            sendToDaemon,
          }),
        },
      }));
      const { cronApiRoutes } = await import('../src/routes/cron-api.js');
      const { dispatchJobNow } = await import('../src/cron/job-dispatch.js');
      const now = Date.now();

      const activeShares = [
        {
          id: 'share-sub-exact',
          server_id: 'srv-1',
          target_kind: 'subsession',
          sub_session_id: 'allowed1',
          target_user_id: 'part-sub',
          role: 'participant',
          created_by: 'owner-1',
          created_at: 1,
          updated_at: 1,
          expires_at: null,
          revoked_at: null,
        },
        {
          id: 'share-main-exact',
          server_id: 'srv-1',
          target_kind: 'main',
          session_name: 'deck_proj_brain',
          target_user_id: 'part-main',
          role: 'participant',
          created_by: 'owner-1',
          created_at: 1,
          updated_at: 1,
          expires_at: null,
          revoked_at: null,
        },
      ];
      let provCreator = 'part-sub';
      const subSendJob = {
        id: 'cron-sub-exact-send',
        server_id: 'srv-1',
        user_id: 'owner-1',
        name: 'sub-exact-send',
        cron_expr: '0 9 * * *',
        project_name: 'proj',
        target_role: 'brain',
        target_session_name: 'deck_sub_allowed1',
        action: JSON.stringify({ type: 'send', target: 'deck_sub_allowed1', message: 'ping self' }),
        timezone: null,
        expires_at: null,
        completion_policy: 'recurring',
        last_run_at: null,
        next_run_at: now + 60_000,
        status: 'active',
      };
      const mainRoleSendJob = {
        ...subSendJob,
        id: 'cron-main-role-send',
        target_session_name: null,
        action: JSON.stringify({ type: 'send', target: 'w1', message: 'ping w1' }),
      };
      const db = {
        queryOne: async (sql: string, params: unknown[] = []) => {
          { const activeUser = activeUserAnswer(sql); if (activeUser) return activeUser as never; }
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.startsWith('select exists (')) return { exists: true };
          if (s.includes('from servers')) {
            return {
              token_hash: DAEMON_TOKEN_HASH,
              owner_status: 'active',
              actor_status: 'active',
              user_status: 'active',
              user_id: 'owner-1',
              node_role: NODE_ROLE.FULL,
              revoked_at: null,
            };
          }
          if (s.includes('from cron_jobs') && params[0] === 'cron-sub-exact-send') return subSendJob;
          if (s.includes('from cron_jobs') && params[0] === 'cron-main-role-send') return mainRoleSendJob;
          if (s.includes('from sessions where server_id')) return { project_name: 'proj', role: 'brain' };
          if (s.includes('from sub_sessions where id')) {
            return { id: params[0], server_id: 'srv-1', closed_at: null, parent_session: 'deck_proj_brain', execution_clone_metadata: null };
          }
          if (s.includes('from cron_job_provenance')) return { creator_user_id: provCreator, shared: true };
          return null;
        },
        query: async (sql: string, params: unknown[] = []) => {
          const s = sql.toLowerCase();
          if (s.includes('union all')) return activeShares.filter((r) => params.includes(r.target_user_id));
          if (s.includes('from session_shares')) return activeShares.filter((r) => r.target_kind === 'main' && params.includes(r.target_user_id));
          if (s.includes('from sub_session_shares')) return activeShares.filter((r) => r.target_kind === 'subsession' && params.includes(r.target_user_id));
          return [];
        },
        execute: async () => ({ changes: 1 }),
      } as unknown as Database;

      const app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        c.env = { DB: db, JWT_SIGNING_KEY: JWT_KEY } as Env;
        await next();
      });
      app.route('/api/server/:serverId/cron', cronApiRoutes);

      const { signJwt } = await import('../src/security/crypto.js');
      const mainWebHeaders = {
        Authorization: `Bearer ${signJwt({ sub: 'part-main', type: 'web' }, JWT_KEY, 3600)}`,
        'Content-Type': 'application/json',
      };

      // API rejects label / agentType targets on main-share send
      for (const fuzzyTarget of ['CoderLabel', 'claude-code']) {
        expect((await app.request('/api/server/srv-1/cron', {
          method: 'POST',
          headers: mainWebHeaders,
          body: JSON.stringify({
            name: `fuzzy-${fuzzyTarget}`,
            cronExpr: '0 9 * * *',
            projectName: 'proj',
            targetRole: 'brain',
            action: { type: 'send', target: fuzzyTarget, message: 'hi' },
          }),
        })).status).toBe(403);
      }

      // Old daemon (cron_exact_send_v1 capability absent) rejects fixed-scope shared cron send without sending
      await expect(dispatchJobNow({ DB: db, JWT_SIGNING_KEY: JWT_KEY } as Env, subSendJob as never)).rejects.toThrow('daemon_upgrade_required_exact_cron_send');
      expect(sendToDaemon).not.toHaveBeenCalled();

      // Upgraded daemon (cron_exact_send_v1 capability present) sets exactTargetSessionName & canonicalizes target
      supportsExact = true;
      await dispatchJobNow({ DB: db, JWT_SIGNING_KEY: JWT_KEY } as Env, subSendJob as never);
      expect(sendToDaemon).toHaveBeenCalledTimes(1);
      const subMsg = JSON.parse(sendToDaemon.mock.calls[0]![0] as string);
      expect(subMsg.exactTargetSessionName).toBe('deck_sub_allowed1');
      expect(subMsg.action.target).toBe('deck_sub_allowed1');

      provCreator = 'part-main';
      sendToDaemon.mockClear();
      await dispatchJobNow({ DB: db, JWT_SIGNING_KEY: JWT_KEY } as Env, mainRoleSendJob as never);
      expect(sendToDaemon).toHaveBeenCalledTimes(1);
      const mainMsg = JSON.parse(sendToDaemon.mock.calls[0]![0] as string);
      expect(mainMsg.exactTargetSessionName).toBe('deck_proj_w1');
      expect(mainMsg.action.target).toBe('deck_proj_w1');
    });

    it('binds POST /trigger caller authorization and dispatch to one locked (job, provenance) version and handles deletion, scope shift, and provenance failure cleanly', async () => {
      const sendToDaemon = vi.fn();
      vi.doMock('../src/ws/bridge.js', () => ({
        WsBridge: {
          publishResourceChanged: vi.fn(),
          get: () => ({
            isDaemonConnected: () => true,
            hasDaemonCapability: () => true,
            sendToDaemon,
          }),
        },
      }));
      const { cronApiRoutes } = await import('../src/routes/cron-api.js');
      const { dispatchJobNow } = await import('../src/cron/job-dispatch.js');
      const { signJwt } = await import('../src/security/crypto.js');
      const now = Date.now();

      type StoredTriggerJob = Record<string, unknown> & {
        prov_present?: boolean;
        prov_creator_user_id?: string | null;
        prov_shared?: boolean | null;
      };
      const jobsMap = new Map<string, StoredTriggerJob>();
      let onTxStart: (() => void) | null = null;
      let throwJoinedRead = false;

      const db = {
        queryOne: async (sql: string, params: unknown[] = []) => {
          { const activeUser = activeUserAnswer(sql); if (activeUser) return activeUser as never; }
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.startsWith('select exists (')) return { exists: true };
          if (s.includes('from servers')) {
            return {
              token_hash: DAEMON_TOKEN_HASH,
              owner_status: 'active',
              actor_status: 'active',
              user_status: 'active',
              user_id: 'owner-1',
              node_role: NODE_ROLE.FULL,
              revoked_at: null,
            };
          }
          if (s.includes('from cron_job_provenance where job_id')) {
            if (throwJoinedRead) throw new Error('trigger_provenance_join_failed');
            const job = jobsMap.get(params[0] as string);
            return job?.prov_present
              ? { creator_user_id: job.prov_creator_user_id ?? null, shared: Boolean(job.prov_shared) }
              : null;
          }
          if (s.includes('from cron_jobs') && s.includes('left join cron_job_provenance')) {
            if (throwJoinedRead) throw new Error('trigger_provenance_join_failed');
            return jobsMap.get(params[0] as string) ?? null;
          }
          if (s.includes('from cron_jobs where id')) {
            return jobsMap.get(params[0] as string) ?? null;
          }
          if (s.includes('from sessions where server_id')) return { project_name: 'proj', role: 'brain' };
          if (s.includes('from sub_sessions where id')) {
            return { id: params[0], server_id: 'srv-1', closed_at: null, parent_session: 'deck_other_brain', execution_clone_metadata: null };
          }
          return null;
        },
        query: async (sql: string, params: unknown[] = []) => {
          const s = sql.toLowerCase();
          if ((s.includes('union all') || s.includes('from session_shares')) && params.includes('part-main')) {
            return [{
              id: 'share-main-trig',
              server_id: 'srv-1',
              target_kind: 'main',
              session_name: 'deck_proj_brain',
              target_user_id: 'part-main',
              role: 'participant',
              created_by: 'owner-1',
              created_at: 1,
              updated_at: 1,
              expires_at: null,
              revoked_at: null,
            }];
          }
          return [];
        },
        execute: async () => ({ changes: 1 }),
        transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
          onTxStart?.();
          return fn(db as unknown as Database);
        },
      } as unknown as Database;

      const app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        c.env = { DB: db, JWT_SIGNING_KEY: JWT_KEY } as Env;
        await next();
      });
      app.route('/api/server/:serverId/cron', cronApiRoutes);

      const partHeaders = { Authorization: `Bearer ${signJwt({ sub: 'part-main', type: 'web' }, JWT_KEY, 3600)}` };
      const ownerHeaders = { Authorization: `Bearer ${signJwt({ sub: 'owner-1', type: 'web' }, JWT_KEY, 3600)}` };

      // 1) Scope change between initial SELECT and locked tx -> 403, 0 dispatches
      jobsMap.set('job-trig-race', {
        id: 'job-trig-race',
        server_id: 'srv-1',
        user_id: 'owner-1',
        name: 'trig-race',
        cron_expr: '0 9 * * *',
        project_name: 'proj',
        target_role: 'brain',
        target_session_name: null,
        action: JSON.stringify({ type: 'command', command: '/status' }),
        timezone: null,
        expires_at: null,
        completion_policy: 'recurring',
        last_run_at: null,
        next_run_at: now + 60_000,
        status: 'active',
        prov_present: true,
        prov_creator_user_id: 'part-main',
        prov_shared: true,
      });
      onTxStart = () => {
        const cur = jobsMap.get('job-trig-race')!;
        jobsMap.set('job-trig-race', { ...cur, project_name: 'other-proj', target_session_name: 'deck_sub_other' });
      };
      const shiftedRes = await app.request('/api/server/srv-1/cron/job-trig-race/trigger', { method: 'POST', headers: partHeaders });
      expect(shiftedRes.status).toBe(403);
      expect(sendToDaemon).not.toHaveBeenCalled();

      // 2) Concurrent deletion before locked tx -> 404 (and direct dispatchJobNow throws cron_not_found), 0 dispatches
      onTxStart = () => { jobsMap.delete('job-trig-race'); };
      const deletedRes = await app.request('/api/server/srv-1/cron/job-trig-race/trigger', { method: 'POST', headers: partHeaders });
      expect(deletedRes.status).toBe(404);
      expect(sendToDaemon).not.toHaveBeenCalled();
      await expect(dispatchJobNow({ DB: db, JWT_SIGNING_KEY: JWT_KEY } as Env, { id: 'job-trig-race' } as never)).rejects.toThrow('cron_not_found');

      // 3) Provenance join read failure -> 500 fail-closed, 0 dispatches
      jobsMap.set('job-trig-err', {
        id: 'job-trig-err',
        server_id: 'srv-1',
        user_id: 'owner-1',
        name: 'trig-err',
        cron_expr: '0 9 * * *',
        project_name: 'proj',
        target_role: 'brain',
        target_session_name: null,
        action: JSON.stringify({ type: 'command', command: '/status' }),
        timezone: null,
        expires_at: null,
        completion_policy: 'recurring',
        last_run_at: null,
        next_run_at: now + 60_000,
        status: 'active',
      });
      onTxStart = null;
      throwJoinedRead = true;
      const errRes = await app.request('/api/server/srv-1/cron/job-trig-err/trigger', { method: 'POST', headers: partHeaders });
      expect(errRes.status).toBe(500);
      expect(sendToDaemon).not.toHaveBeenCalled();
      throwJoinedRead = false;

      // 4) Same-version positive controls: shared participant AND legacy owner row (prov_present: false) both dispatch
      jobsMap.set('job-trig-ok', {
        id: 'job-trig-ok',
        server_id: 'srv-1',
        user_id: 'owner-1',
        name: 'trig-ok',
        cron_expr: '0 9 * * *',
        project_name: 'proj',
        target_role: 'brain',
        target_session_name: null,
        action: JSON.stringify({ type: 'command', command: '/ok' }),
        timezone: null,
        expires_at: null,
        completion_policy: 'recurring',
        last_run_at: null,
        next_run_at: now + 60_000,
        status: 'active',
        prov_present: true,
        prov_creator_user_id: 'part-main',
        prov_shared: true,
      });
      const okPart = await app.request('/api/server/srv-1/cron/job-trig-ok/trigger', { method: 'POST', headers: partHeaders });
      expect(okPart.status).toBe(200);
      expect(sendToDaemon).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sendToDaemon.mock.calls[0]![0] as string).action).toEqual({ type: 'command', command: '/ok' });

      sendToDaemon.mockClear();
      jobsMap.set('job-legacy-owner', {
        id: 'job-legacy-owner',
        server_id: 'srv-1',
        user_id: 'owner-1',
        name: 'legacy-owner',
        cron_expr: '0 9 * * *',
        project_name: 'proj',
        target_role: 'brain',
        target_session_name: null,
        action: JSON.stringify({ type: 'command', command: '/legacy' }),
        timezone: null,
        expires_at: null,
        completion_policy: 'recurring',
        last_run_at: null,
        next_run_at: now + 60_000,
        status: 'active',
        prov_present: false,
        prov_creator_user_id: null,
        prov_shared: null,
      });
      const okOwner = await app.request('/api/server/srv-1/cron/job-legacy-owner/trigger', { method: 'POST', headers: ownerHeaders });
      expect(okOwner.status).toBe(200);
      expect(sendToDaemon).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sendToDaemon.mock.calls[0]![0] as string).action).toEqual({ type: 'command', command: '/legacy' });
    });

    it('mints ownerMachineAuthority for owner crons and scoped participant sharedMachineAuthority for shared crons so cron_cancel_self succeeds on shared hosts', async () => {
      const sendToDaemon = vi.fn();
      vi.doMock('../src/ws/bridge.js', () => ({
        WsBridge: {
          publishResourceChanged: vi.fn(),
          get: () => ({
            isDaemonConnected: () => true,
            hasDaemonCapability: () => true,
            sendToDaemon,
          }),
        },
      }));
      const { cronApiRoutes } = await import('../src/routes/cron-api.js');
      const { dispatchJobNow, jobDispatchCron } = await import('../src/cron/job-dispatch.js');
      const { verifyJwt } = await import('../src/security/crypto.js');
      const now = Date.now();

      const mainShare = {
        id: 'share-main-1',
        server_id: 'srv-1',
        session_name: 'deck_proj_brain',
        target_kind: 'main',
        target_user_id: 'part-main',
        role: 'participant',
        created_by: 'owner-1',
        created_at: 1,
        updated_at: 1,
        expires_at: null,
        revoked_at: null,
      };
      const jobsMap = new Map<string, Record<string, unknown>>([
        ['cron-owner-self', {
          id: 'cron-owner-self',
          server_id: 'srv-1',
          user_id: 'owner-1',
          name: 'owner-supervision',
          cron_expr: '*/20 * * * *',
          project_name: 'proj',
          target_role: 'brain',
          target_session_name: null,
          action: JSON.stringify({ type: 'command', command: '/check', selfManaged: true }),
          timezone: null,
          expires_at: null,
          completion_policy: 'until_complete',
          last_run_at: null,
          next_run_at: now - 1000,
          status: 'active',
        }],
        ['cron-part-self', {
          id: 'cron-part-self',
          server_id: 'srv-1',
          user_id: 'owner-1',
          name: 'part-supervision',
          cron_expr: '*/20 * * * *',
          project_name: 'proj',
          target_role: 'brain',
          target_session_name: null,
          action: JSON.stringify({ type: 'command', command: '/check', selfManaged: true }),
          timezone: null,
          expires_at: null,
          completion_policy: 'until_complete',
          last_run_at: null,
          next_run_at: now - 1000,
          status: 'active',
        }],
        ['cron-other-proj', {
          id: 'cron-other-proj',
          server_id: 'srv-1',
          user_id: 'owner-1',
          name: 'other-proj-job',
          cron_expr: '*/20 * * * *',
          project_name: 'other_proj',
          target_role: 'brain',
          target_session_name: null,
          action: JSON.stringify({ type: 'command', command: '/check', selfManaged: true }),
          timezone: null,
          expires_at: null,
          completion_policy: 'until_complete',
          last_run_at: null,
          next_run_at: now + 60_000,
          status: 'active',
        }],
      ]);
      const provMap = new Map<string, Record<string, unknown>>([
        ['cron-part-self', { job_id: 'cron-part-self', creator_user_id: 'part-main', server_id: 'srv-1', project_name: 'proj', shared: true }],
      ]);

      const db = {
        transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db),
        queryOne: async (sql: string, params: unknown[] = []) => {
          { const activeUser = activeUserAnswer(sql); if (activeUser) return activeUser as never; }
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.startsWith('select exists (')) return { exists: true };
          if (s.includes('from servers')) {
            return {
              token_hash: DAEMON_TOKEN_HASH,
              owner_status: 'active',
              actor_status: 'active',
              user_status: 'active',
              user_id: 'owner-1',
              node_role: NODE_ROLE.FULL,
              revoked_at: null,
            };
          }
          if (s.includes('from sessions where server_id')) return { project_name: 'proj', role: 'brain' };
          if (s.includes('from cron_job_provenance where job_id')) return provMap.get(params[0] as string) ?? null;
          if (s.includes('from cron_jobs') && params[0]) {
            const job = jobsMap.get(params[0] as string);
            if (!job) return null;
            if (s.includes('left join cron_job_provenance')) {
              const p = provMap.get(job.id as string);
              return { ...job, prov_present: Boolean(p), prov_creator_user_id: p?.creator_user_id ?? null, prov_shared: p?.shared ?? null };
            }
            return job;
          }
          return null;
        },
        query: async (sql: string, params: unknown[] = []) => {
          const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.includes('from server_shares ss join servers s')) return [{ shared: false }];
          if (s.includes('as shared')) return [{ shared: true }];
          if (s.includes('from session_shares')) return params.includes('part-main') ? [mainShare] : [];
          if (s.includes('from server_shares') || s.includes('from sub_session_shares')) return [];
          if (s.includes('from cron_jobs')) {
            return [...jobsMap.values()].filter((j) => Number(j.next_run_at ?? 0) <= Number(params[0] ?? 0));
          }
          return [];
        },
        execute: async (sql: string, params: unknown[] = []) => {
          const s = sql.toLowerCase();
          if (s.includes('delete from cron_jobs')) {
            jobsMap.delete(params[0] as string);
          }
          return { changes: 1 };
        },
      } as unknown as Database;

      await jobDispatchCron({ DB: db, JWT_SIGNING_KEY: JWT_KEY } as Env);
      expect(sendToDaemon).toHaveBeenCalledTimes(2);
      const dispatches = sendToDaemon.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
      const ownerMsg = dispatches.find((m) => m.jobId === 'cron-owner-self')!;
      const partMsg = dispatches.find((m) => m.jobId === 'cron-part-self')!;

      const ownerToken = String(ownerMsg[OWNER_MACHINE_AUTHORITY_FIELD] ?? '');
      expect(ownerToken.startsWith('trg_')).toBe(true);
      expect(ownerMsg[SHARED_MACHINE_AUTHORITY_FIELD]).toBeUndefined();

      const partToken = String(partMsg[SHARED_MACHINE_AUTHORITY_FIELD] ?? '');
      expect(partToken.startsWith('trg_')).toBe(true);
      expect(partMsg[OWNER_MACHINE_AUTHORITY_FIELD]).toBeUndefined();
      expect(partMsg.sharedActor).toMatchObject({ actorUserId: 'part-main', effectiveActorRole: 'participant' });

      const { signJwt } = await import('../src/security/crypto.js');
      const { resolveSharedMachineAuthority } = await import('../src/share/shared-machine-authority.js');
      // On shared tree deck_proj_brain, dispatching cron-part-self after cron-owner-self immediately replaced ownerToken with partToken.
      await expect(resolveSharedMachineAuthority(db, {
        token: ownerToken,
        authenticatedSourceServerId: 'srv-1',
        sourceOwnerUserId: 'owner-1',
        now: Date.now(),
      })).resolves.toMatchObject({ kind: 'invalid' });
      await expect(resolveSharedMachineAuthority(db, {
        token: partToken,
        authenticatedSourceServerId: 'srv-1',
        sourceOwnerUserId: 'owner-1',
        now: Date.now(),
      })).resolves.toMatchObject({ kind: 'participant', actorUserId: 'part-main', rootSessionName: 'deck_proj_brain' });

      const app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        c.env = { DB: db, JWT_SIGNING_KEY: JWT_KEY } as Env;
        await next();
      });
      app.route('/api/server/:serverId/cron', cronApiRoutes);
      app.route('/api/cron', cronApiRoutes);

      // 1) Absent authority header on shared host still fails with shared_host_daemon_authority_required
      const absentRes = await app.request('/api/server/srv-1/cron/cron-owner-self', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${DAEMON_TOKEN}`, 'X-Server-Id': 'srv-1' },
      });
      expect(absentRes.status).toBe(403);
      await expect(absentRes.json()).resolves.toEqual({ error: 'forbidden', reason: 'shared_host_daemon_authority_required' });

      // 2) Participant triggering owner-created in-scope job never escalates to owner authority
      sendToDaemon.mockClear();
      const partTriggerOwnerRes = await app.request('/api/cron/cron-owner-self/trigger', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${signJwt({ sub: 'part-main', type: 'web' }, JWT_KEY, 3600)}`,
        },
      });
      expect(partTriggerOwnerRes.status).toBe(200);
      const triggeredMsg = JSON.parse(String(sendToDaemon.mock.calls[0]![0])) as Record<string, unknown>;
      const triggeredPartToken = String(triggeredMsg[SHARED_MACHINE_AUTHORITY_FIELD] ?? '');
      expect(triggeredMsg[OWNER_MACHINE_AUTHORITY_FIELD]).toBeUndefined();
      expect(triggeredPartToken.startsWith('trg_')).toBe(true);
      await expect(resolveSharedMachineAuthority(db, {
        token: triggeredPartToken,
        authenticatedSourceServerId: 'srv-1',
        sourceOwnerUserId: 'owner-1',
        now: Date.now(),
      })).resolves.toMatchObject({ kind: 'participant', actorUserId: 'part-main', rootSessionName: 'deck_proj_brain' });
      // Prior partToken from step 1 was immediately replaced by triggeredPartToken.
      await expect(resolveSharedMachineAuthority(db, {
        token: partToken,
        authenticatedSourceServerId: 'srv-1',
        sourceOwnerUserId: 'owner-1',
        now: Date.now(),
      })).resolves.toMatchObject({ kind: 'invalid' });

      // 3) Participant turn cannot cancel out-of-scope job
      const outOfScopeDel = await app.request('/api/server/srv-1/cron/cron-other-proj', {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${DAEMON_TOKEN}`,
          'X-Server-Id': 'srv-1',
          [SHARED_MACHINE_AUTHORITY_HEADER]: triggeredPartToken,
        },
      });
      expect(outOfScopeDel.status).toBe(403);
      await expect(outOfScopeDel.json()).resolves.toEqual({ error: 'forbidden', reason: 'share-direct-surface-denied' });

      // 4) Participant turn CAN cancel both participant-created and in-scope owner-created jobs
      const partDelShared = await app.request('/api/server/srv-1/cron/cron-part-self', {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${DAEMON_TOKEN}`,
          'X-Server-Id': 'srv-1',
          [SHARED_MACHINE_AUTHORITY_HEADER]: triggeredPartToken,
        },
      });
      expect(partDelShared.status).toBe(200);

      const partDelOwnerInScope = await app.request('/api/server/srv-1/cron/cron-owner-self', {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${DAEMON_TOKEN}`,
          'X-Server-Id': 'srv-1',
          [SHARED_MACHINE_AUTHORITY_HEADER]: triggeredPartToken,
        },
      });
      expect(partDelOwnerInScope.status).toBe(200);

      // 5) Re-seed owner job and verify owner turn CAN cancel it with active ownerToken on shared host
      sendToDaemon.mockClear();
      jobsMap.set('cron-owner-self-2', { ...jobsMap.get('cron-other-proj'), id: 'cron-owner-self-2', project_name: 'proj' });
      await dispatchJobNow({ DB: db, JWT_SIGNING_KEY: JWT_KEY } as Env, jobsMap.get('cron-owner-self-2') as never);
      const ownerDispatch2 = JSON.parse(String(sendToDaemon.mock.calls[0]![0])) as Record<string, unknown>;
      const freshOwnerToken = String(ownerDispatch2[OWNER_MACHINE_AUTHORITY_FIELD] ?? '');
      expect(freshOwnerToken.startsWith('trg_')).toBe(true);
      const ownerDelRes = await app.request('/api/server/srv-1/cron/cron-owner-self-2', {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${DAEMON_TOKEN}`,
          'X-Server-Id': 'srv-1',
          [SHARED_MACHINE_AUTHORITY_HEADER]: freshOwnerToken,
        },
      });
      expect(ownerDelRes.status).toBe(200);
    });
  });
});
