import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { DiscordHandler } from '../src/platform/handlers/discord/index.js';
import { FeishuHandler } from '../src/platform/handlers/feishu/index.js';
import { issueSharedMachineAuthority } from '../src/share/shared-machine-authority.js';
import { SHARED_MACHINE_AUTHORITY_HEADER, SHARED_MACHINE_AUTHORITY_TYPE } from '../../shared/shared-machine-authority.js';
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
          if (s.includes('from servers where id')) {
            return {
              token_hash: DAEMON_TOKEN_HASH,
              owner_status: 'active',
              actor_status: 'active',
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
    });
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
          if (s.includes('from servers where id')) {
            return { user_id: 'owner-1', owner_status: 'active', actor_status: 'active' };
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
          if (s.includes('from servers where id')) {
            return {
              token_hash: DAEMON_TOKEN_HASH,
              owner_status: 'active',
              actor_status: 'active',
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
});
