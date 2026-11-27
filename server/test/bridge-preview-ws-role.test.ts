import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { setupWebSocketUpgrade } from '../src/index.js';
import { LocalWebPreviewRegistry } from '../src/preview/registry.js';
import { WsBridge } from '../src/ws/bridge.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { PREVIEW_ACCESS_TOKEN_QUERY_PARAM } from '../../shared/preview-types.js';

/**
 * V-ws-role (run 8a975732-23a P0.5.3): the preview WS upgrade now runs the SAME
 * pure authorization function as HTTP (resolveServerRole included), so a user
 * whose server role has become `none` (revoked) is rejected with 403 even while
 * holding a still-valid preview access token. Previously WS upgrade skipped the
 * role check — this closes that gap.
 */

type ServerRow = { id: string; user_id: string; team_id: string | null };

function makeMemDb(state: { servers: Map<string, ServerRow> }): Database {
  return {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (s.includes('from servers where id = $1')) {
        const row = state.servers.get(params[0] as string);
        if (!row) return null;
        return { team_id: row.team_id, user_id: row.user_id, token_hash: 'x', owner_status: 'active', actor_status: 'active' } as unknown as T;
      }
      if (s.includes('select role from team_members')) return null;
      if (s.includes('from users where id = $1')) {
        return { status: 'active', sessions_valid_after: 0 } as unknown as T;
      }
      return null;
    },
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;
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
    NODE_ENV: 'development', // origin check disabled → isolates the role check
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
  };
}

describe('V-ws-role: preview WS upgrade enforces resolveServerRole', () => {
  let httpServer: HttpServer;
  let port: number;
  let serverId: string;
  let state: { servers: Map<string, ServerRow> };

  beforeEach(async () => {
    serverId = `srv-wsrole-${Math.random().toString(36).slice(2)}`;
    state = { servers: new Map() };
    state.servers.set(serverId, { id: serverId, user_id: 'owner-user', team_id: null });
    const env = makeEnv(makeMemDb(state));
    httpServer = createServer();
    setupWebSocketUpgrade(httpServer, env);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    port = (httpServer.address() as { port: number }).port;
  });

  afterEach(async () => {
    WsBridge.getAll().clear();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  function connectStatus(previewId: string, token: string): Promise<{ closed: boolean; statusCode?: number }> {
    return new Promise((resolve) => {
      const url = `ws://127.0.0.1:${port}/api/server/${serverId}/local-web/${previewId}/?${PREVIEW_ACCESS_TOKEN_QUERY_PARAM}=${token}`;
      const ws = new WebSocket(url);
      let settled = false;
      const done = (r: { closed: boolean; statusCode?: number }) => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        resolve(r);
      };
      ws.on('unexpected-response', (_req, res) => done({ closed: true, statusCode: res.statusCode }));
      ws.on('error', () => done({ closed: true }));
      ws.on('open', () => done({ closed: false }));
      setTimeout(() => done({ closed: true }), 2000);
    });
  }

  it('rejects the WS upgrade (403) when the holder is no longer a member (role=none)', async () => {
    const registry = LocalWebPreviewRegistry.get(serverId);
    const { preview, accessToken } = registry.create('owner-user', 3000, '/');

    // Revoke: server is now owned by a different user → resolveServerRole === 'none'.
    state.servers.set(serverId, { id: serverId, user_id: 'a-different-owner', team_id: null });

    const result = await connectStatus(preview.id, accessToken);
    expect(result.closed).toBe(true);
    expect(result.statusCode).toBe(403);
  });

  it('rejects doc_collaborator session cookies on preview WS upgrade while allowing normal account session cookies', async () => {
    const { signJwt } = await import('../src/security/crypto.js');
    const { COOKIE_SESSION } = await import('../../shared/cookie-names.js');
    const { ACCOUNT_SESSION_JWT_TYPE } = await import('../../shared/auth-token-types.js');
    const registry = LocalWebPreviewRegistry.get(serverId);
    const { preview } = registry.create('owner-user', 3000, '/');
    const key = 'test-signing-key-32chars-padding!!';

    const connectWithCookie = (cookieVal: string): Promise<{ closed: boolean; statusCode?: number }> =>
      new Promise((resolve) => {
        const url = `ws://127.0.0.1:${port}/api/server/${serverId}/local-web/${preview.id}/`;
        const ws = new WebSocket(url, { headers: { Cookie: `${COOKIE_SESSION}=${cookieVal}` } });
        let settled = false;
        const done = (r: { closed: boolean; statusCode?: number }) => {
          if (settled) return;
          settled = true;
          try { ws.close(); } catch { /* ignore */ }
          resolve(r);
        };
        ws.on('unexpected-response', (_req, res) => done({ closed: true, statusCode: res.statusCode }));
        ws.on('error', () => done({ closed: true }));
        ws.on('open', () => done({ closed: false }));
        setTimeout(() => done({ closed: true }), 2000);
      });

    const docCollabToken = signJwt({
      sub: 'owner-user',
      type: ACCOUNT_SESSION_JWT_TYPE,
      scope: 'doc_collaborator',
      iat: Math.floor(Date.now() / 1000),
    }, key);
    const rejected = await connectWithCookie(docCollabToken);
    expect(rejected.closed).toBe(true);
    expect(rejected.statusCode).toBe(401);

    const normalToken = signJwt({
      sub: 'owner-user',
      type: ACCOUNT_SESSION_JWT_TYPE,
      iat: Math.floor(Date.now() / 1000),
    }, key);
    const allowed = await connectWithCookie(normalToken);
    expect(allowed.statusCode).not.toBe(401);
    expect(allowed.statusCode).not.toBe(403);
  });

  it('rejects real HTTP WS upgrade with upstream HTTP status (403 / 502) and never sends 101, while delivering first frames on WS_OPENED', async () => {
    const { EventEmitter } = await import('node:events');
    const { PREVIEW_MSG, PREVIEW_BINARY_FRAME, packPreviewWsFrame } = await import('../../shared/preview-types.js');
    const { sha256Hex } = await import('../src/security/crypto.js');
    const { activeUserAnswer } = await import('./helpers/user-status.js');

    // Mock daemon with token_hash matching 'daemon-tok'
    const tokenHash = sha256Hex('daemon-tok');
    const authDb = {
      queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
        const u = activeUserAnswer(sql);
        if (u) return u as T;
        const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
        if (s.includes('from servers where id = $1')) {
          return { token_hash: tokenHash, user_id: 'owner-user', team_id: null, owner_status: 'active', actor_status: 'active' } as unknown as T;
        }
        return null;
      },
      query: async () => [],
      execute: async () => ({ changes: 1 }),
      exec: async () => {},
      close: async () => {},
    } as unknown as Database;

    let daemonMode: 'reject-403' | 'reject-legacy' | 'open-with-greeting' = 'reject-403';
    class MockDaemonWs extends EventEmitter {
      readyState = 1;
      send(data: string | Buffer, optsOrCb?: unknown, cb?: (err?: Error) => void) {
        const callback = typeof optsOrCb === 'function' ? (optsOrCb as (e?: Error) => void) : cb;
        callback?.();
        if (typeof data !== 'string') return;
        const parsed = JSON.parse(data) as { type?: string; wsId?: string };
        if (parsed.type === PREVIEW_MSG.WS_OPEN && parsed.wsId) {
          const wsId = parsed.wsId;
          queueMicrotask(() => {
            if (daemonMode === 'reject-403') {
              this.emit('message', Buffer.from(JSON.stringify({
                type: PREVIEW_MSG.WS_ERROR, wsId, error: 'upstream rejected: 403 Forbidden', status: 403,
              })), false);
            } else if (daemonMode === 'reject-legacy') {
              this.emit('message', Buffer.from(JSON.stringify({
                type: PREVIEW_MSG.WS_ERROR, wsId, error: 'ECONNREFUSED',
              })), false);
            } else {
              this.emit('message', Buffer.from(JSON.stringify({
                type: PREVIEW_MSG.WS_OPENED, wsId, protocol: 'vite-hmr',
              })), false);
              this.emit('message', packPreviewWsFrame(wsId, false, Buffer.from('hello-first-frame')), true);
            }
          });
        }
      }
      close() { this.readyState = 3; this.emit('close', 1000, Buffer.from('')); }
    }

    const bridge = WsBridge.get(serverId);
    const daemon = new MockDaemonWs();
    bridge.handleDaemonConnection(daemon as never, authDb, makeEnv(authDb));
    daemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token: 'daemon-tok' })), false);
    await new Promise((r) => setTimeout(r, 10));

    const registry = LocalWebPreviewRegistry.get(serverId);
    const { preview, accessToken } = registry.create('owner-user', 3000, '/');

    daemonMode = 'reject-403';
    const rej403 = await connectStatus(preview.id, accessToken);
    expect(rej403).toEqual({ closed: true, statusCode: 403 });

    daemonMode = 'reject-legacy';
    const rejLegacy = await connectStatus(preview.id, accessToken);
    expect(rejLegacy).toEqual({ closed: true, statusCode: 502 });

    daemonMode = 'open-with-greeting';
    const opened = await new Promise<{ protocol: string; firstMessage: string }>((resolve, reject) => {
      const url = `ws://127.0.0.1:${port}/api/server/${serverId}/local-web/${preview.id}/?${PREVIEW_ACCESS_TOKEN_QUERY_PARAM}=${accessToken}`;
      const ws = new WebSocket(url, ['vite-hmr']);
      const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('timeout')); }, 3000);
      ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); reject(new Error(`unexpected status ${res.statusCode}`)); });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
      ws.on('message', (data) => {
        clearTimeout(timer);
        const msg = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        const proto = ws.protocol;
        ws.close();
        resolve({ protocol: proto, firstMessage: msg });
      });
    });
    expect(opened.protocol).toBe('vite-hmr');
    expect(opened.firstMessage).toBe('hello-first-frame');

    // Also test real socket closing/aborting handshake after WS_OPENED and abnormal 1006 close:
    // 1) Raw socket missing Sec-WebSocket-Key -> wss.handleUpgrade rejects silently without callback,
    //    completeUpgrade settles cleanly, quota returns to 0, and WS_CLOSE is sent to daemon.
    const { request } = await import('node:http');
    const net = await import('node:net');
    const daemonMsgs: Array<Record<string, unknown>> = [];
    const origDaemonSend = daemon.send.bind(daemon);
    daemon.send = (data: string | Buffer, optsOrCb?: unknown, cb?: (err?: Error) => void) => {
      if (typeof data === 'string') {
        try { daemonMsgs.push(JSON.parse(data)); } catch { /* ignore */ }
      }
      origDaemonSend(data, optsOrCb, cb);
    };

    daemonMode = 'open-with-greeting';
    const rawSock = net.connect(port, '127.0.0.1');
    await new Promise<void>((res) => rawSock.on('connect', res));
    // Send invalid Upgrade (missing Sec-WebSocket-Key) so wss.handleUpgrade aborts internally without callback!
    rawSock.write(
      `GET /api/server/${serverId}/local-web/${preview.id}/?${PREVIEW_ACCESS_TOKEN_QUERY_PARAM}=${accessToken} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await new Promise<void>((res) => {
      rawSock.on('close', () => res());
      setTimeout(res, 1000);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.getServerWsCount()).toBe(0);
    expect(daemonMsgs.some((m) => m.type === PREVIEW_MSG.WS_CLOSE)).toBe(true);
    void request;

    // 2) Abnormal close (1006) on upgraded real WebSocket closes browser connection instead of hanging open.
    const abnormalClosed = await new Promise<{ closed: boolean; code: number }>((resolve, reject) => {
      const url = `ws://127.0.0.1:${port}/api/server/${serverId}/local-web/${preview.id}/?${PREVIEW_ACCESS_TOKEN_QUERY_PARAM}=${accessToken}`;
      const ws = new WebSocket(url, ['vite-hmr']);
      const timer = setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } reject(new Error('hung open')); }, 3000);
      ws.on('open', () => {
        const latestOpen = [...daemonMsgs].reverse().find((m) => m.type === PREVIEW_MSG.WS_OPEN);
        if (latestOpen?.wsId) {
          daemon.emit('message', Buffer.from(JSON.stringify({
            type: PREVIEW_MSG.WS_CLOSE, wsId: latestOpen.wsId, code: 1006, reason: 'upstream crashed',
          })), false);
        }
      });
      ws.on('close', (code) => {
        clearTimeout(timer);
        resolve({ closed: true, code });
      });
    });
    expect(abnormalClosed.closed).toBe(true);
    expect(abnormalClosed.code).toBe(1006);
  });
});
