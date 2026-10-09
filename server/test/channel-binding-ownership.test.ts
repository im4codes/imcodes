/**
 * tsk_854675e1e2: POST /api/server/:id/bindings accepted any botId and its upsert re-pointed an existing (platform, channel, bot)
 * binding at the calling daemon's server, so a daemon that learned another user's bot id received that bot's inbound chat messages.
 * The bot must belong to the server owner (the same rule /api/outbound already applied to sends).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';

const TOKEN = 'daemon-token-of-user-a';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

function setup() {
  const bindings: unknown[][] = [];
  const db = {
    queryOne: async (sql: string, params: unknown[] = []) => {
      const s = sql.toLowerCase().replace(/\s+/g, ' ');
      if (s.includes('from servers where id')) {
        return params[1] === TOKEN_HASH ? { id: params[0], user_id: 'user-a', team_id: null, node_role: null, revoked_at: null } : null;
      }
      if (s.includes('from platform_bots')) {
        if (params[0] === 'bot-of-a') return { user_id: 'user-a' };
        if (params[0] === 'bot-of-b') return { user_id: 'user-b' };
        return null;
      }
      return null;
    },
    query: async () => [],
    execute: async (sql: string, params: unknown[] = []) => {
      if (sql.toLowerCase().includes('insert into channel_bindings')) bindings.push(params);
      return { changes: 1 };
    },
    exec: async () => undefined,
    close: async () => undefined,
  } as unknown as Database;
  const env = {
    DB: db, JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!', BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'http://localhost:3000', ALLOWED_ORIGINS: '', TRUSTED_PROXIES: '', BIND_HOST: '127.0.0.1', PORT: '3000',
    NODE_ENV: 'development', GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '',
  } as Env;
  return { app: buildApp(env), bindings };
}

const post = (app: ReturnType<typeof buildApp>, botId: string) => app.request('/api/server/srv-a/bindings', {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ platform: 'telegram', channelId: 'chan-1', botId, bindingType: 'session', target: 'deck_p_brain' }),
});

describe('POST /api/server/:id/bindings', () => {
  it("binds the owner's own bot", async () => {
    const { app, bindings } = setup();
    expect((await post(app, 'bot-of-a')).status).toBe(200);
    expect(bindings).toHaveLength(1);
  });

  it("refuses another user's bot, and an unknown bot, without writing the binding", async () => {
    const { app, bindings } = setup();
    expect((await post(app, 'bot-of-b')).status).toBe(403);
    expect((await post(app, 'no-such-bot')).status).toBe(403);
    expect(bindings).toEqual([]);
  });
});
