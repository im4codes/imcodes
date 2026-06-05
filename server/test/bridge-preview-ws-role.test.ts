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
        return { team_id: row.team_id, user_id: row.user_id, token_hash: 'x' } as unknown as T;
      }
      if (s.includes('select role from team_members')) return null;
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
});
