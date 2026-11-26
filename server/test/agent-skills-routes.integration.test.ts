/**
 * `/api/agent-skills` against real PostgreSQL: only a machine's owner may list
 * or change its `~/.agents/skills`, only on a full daemon, and nothing unsafe
 * reaches the daemon.
 */
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/index.js';
import { hashPassword, randomHex, sha256Hex, signJwt } from '../src/security/crypto.js';
import { WsBridge } from '../src/ws/bridge.js';
import type { Env } from '../src/env.js';
import { COOKIE_CSRF, COOKIE_SESSION, HEADER_CSRF } from '../../shared/cookie-names.js';
import {
  AGENT_SKILLS_DIRECTORY,
  AGENT_SKILLS_DIRECTORY_ERROR,
  AGENT_SKILLS_ERROR,
  AGENT_SKILLS_MESSAGE_PREFIX,
  AGENT_SKILLS_MSG,
} from '../../shared/agent-skills.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { AGENT_MCP_ERROR, AGENT_MCP_MESSAGE_PREFIX, AGENT_MCP_MSG } from '../../shared/agent-mcp.js';

let db: Database;
const JWT_KEY = 'test-jwt-key-for-agent-skills-tests-000000';

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

function env(): Env {
  return {
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    JWT_SIGNING_KEY: JWT_KEY,
    BOT_ENCRYPTION_KEY: randomHex(32),
    DB: db,
    NODE_ENV: 'test',
    ALLOWED_ORIGINS: 'http://localhost',
  } as Env;
}

async function createUser(username: string): Promise<string> {
  const id = randomHex(16);
  await db.execute(
    'INSERT INTO users (id, username, password_hash, display_name, password_must_change, is_admin, status, created_at) VALUES ($1, $2, $3, $4, false, false, $5, $6)',
    [id, username, await hashPassword('testpass'), username, 'active', Date.now()],
  );
  return id;
}

async function createServer(userId: string, token: string, nodeRole: string = NODE_ROLE.FULL): Promise<string> {
  const serverId = randomHex(16);
  // A controlled node carries its 10-digit node id; a full daemon has none.
  const nodeId = nodeRole === NODE_ROLE.CONTROLLED ? String(1_000_000_000 + Math.floor(Math.random() * 8_999_999_999)) : null;
  await db.execute(
    'INSERT INTO servers (id, name, user_id, token_hash, created_at, node_role, node_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [serverId, 'machine', userId, sha256Hex(token), Date.now(), nodeRole, nodeId],
  );
  return serverId;
}

function headers(userId: string, json = false): Record<string, string> {
  const csrf = randomHex(16);
  return {
    Cookie: `${COOKIE_SESSION}=${signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600)}; ${COOKIE_CSRF}=${csrf}`,
    [HEADER_CSRF]: csrf,
    Origin: 'http://localhost',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

/** A daemon socket that answers agent-skills requests the way the daemon does. */
class FakeDaemon extends EventEmitter {
  readyState = 1;
  received: Array<Record<string, unknown>> = [];
  send(data: string | Buffer): void {
    const frame = JSON.parse(typeof data === 'string' ? data : data.toString()) as Record<string, unknown>;
    if (typeof frame.type !== 'string'
      || !(frame.type.startsWith(AGENT_SKILLS_MESSAGE_PREFIX) || frame.type.startsWith(AGENT_MCP_MESSAGE_PREFIX))) return;
    this.received.push(frame);
    const replies: Record<string, Record<string, unknown>> = {
      [AGENT_SKILLS_MSG.LIST_REQUEST]: { type: AGENT_SKILLS_MSG.LIST_RESPONSE, skills: [{ name: 'wecomcli-doc', description: 'docs' }] },
      [AGENT_SKILLS_MSG.RUN_REQUEST]: { type: AGENT_SKILLS_MSG.RUN_RESPONSE, ok: true, output: 'done', skills: [] },
      [AGENT_MCP_MSG.LIST_REQUEST]: { type: AGENT_MCP_MSG.LIST_RESPONSE, servers: [{ name: 'github', transport: 'http', envNames: [], headerNames: ['Authorization'], agents: ['codex'] }], agents: [{ agent: 'codex', displayName: 'Codex' }] },
      [AGENT_MCP_MSG.RUN_REQUEST]: { type: AGENT_MCP_MSG.RUN_RESPONSE, ok: true, results: [{ agent: 'codex', ok: true }] },
    };
    const reply = { ...replies[frame.type], requestId: frame.requestId };
    setImmediate(() => this.emit('message', Buffer.from(JSON.stringify(reply)), false));
  }
  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

async function connectDaemon(serverId: string, token: string): Promise<FakeDaemon> {
  const daemon = new FakeDaemon();
  WsBridge.get(serverId).handleDaemonConnection(daemon as never, db, env());
  daemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token })), false);
  for (let i = 0; i < 100 && !WsBridge.get(serverId).isDaemonConnected(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(WsBridge.get(serverId).isDaemonConnected()).toBe(true);
  return daemon;
}

describe('/api/agent-skills', () => {
  let owner: string;
  let stranger: string;
  let machine: string;

  beforeEach(async () => {
    await db.exec('TRUNCATE users CASCADE');
    await db.exec('TRUNCATE servers CASCADE');
    owner = await createUser('owner');
    stranger = await createUser('stranger');
    machine = await createServer(owner, 'daemon-token');
  });

  afterEach(() => {
    WsBridge.getAll().clear();
  });

  it('lists and runs on the owner\'s own daemon', async () => {
    const daemon = await connectDaemon(machine, 'daemon-token');
    const app = buildApp(env());

    const list = await app.request(`/api/agent-skills?serverId=${machine}`, { headers: headers(owner) });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ skills: [{ name: 'wecomcli-doc', description: 'docs' }] });

    const run = await app.request(`/api/agent-skills/run?serverId=${machine}`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ action: 'add', source: 'WeComTeam/wecom-cli' }),
    });
    expect(run.status).toBe(200);
    expect(await run.json()).toEqual({ ok: true, output: 'done', skills: [] });
    expect(daemon.received.at(-1)).toMatchObject({ type: AGENT_SKILLS_MSG.RUN_REQUEST, action: 'add', source: 'WeComTeam/wecom-cli' });
  });

  it('refuses someone else\'s machine without ever asking its daemon', async () => {
    const daemon = await connectDaemon(machine, 'daemon-token');
    const app = buildApp(env());
    const list = await app.request(`/api/agent-skills?serverId=${machine}`, { headers: headers(stranger) });
    const run = await app.request(`/api/agent-skills/run?serverId=${machine}`, {
      method: 'POST',
      headers: headers(stranger, true),
      body: JSON.stringify({ action: 'update' }),
    });
    expect([list.status, run.status]).toEqual([403, 403]);
    expect(daemon.received).toEqual([]);
  });

  it('refuses a controlled node, which runs no agents', async () => {
    const node = await createServer(owner, 'node-token', NODE_ROLE.CONTROLLED);
    const res = await buildApp(env()).request(`/api/agent-skills?serverId=${node}`, { headers: headers(owner) });
    expect(res.status).toBe(404);
  });

  it('never forwards a source that could be an option or a path', async () => {
    const daemon = await connectDaemon(machine, 'daemon-token');
    const res = await buildApp(env()).request(`/api/agent-skills/run?serverId=${machine}`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ action: 'add', source: '--all' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: AGENT_SKILLS_ERROR.INVALID_REQUEST });
    expect(daemon.received).toEqual([]);
  });

  it('says the daemon is offline rather than hanging', async () => {
    const res = await buildApp(env()).request(`/api/agent-skills?serverId=${machine}`, { headers: headers(owner) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: AGENT_SKILLS_ERROR.DAEMON_OFFLINE });
  });

  it('searches and audits the skills.sh directory for a signed-in user only', async () => {
    const app = buildApp(env());
    expect((await app.request('/api/agent-skills/directory/search?q=wecom')).status).toBe(401);
    expect((await app.request('/api/agent-skills/directory/search?q=', { headers: headers(stranger) })).status).toBe(400);
    expect((await app.request('/api/agent-skills/directory/audit?source=--all&skills=x', { headers: headers(stranger) })).status).toBe(400);

    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(AGENT_SKILLS_DIRECTORY.SEARCH_URL)) {
        return new Response(JSON.stringify({ skills: [{ skillId: 'wecomcli-doc', source: 'wecomteam/wecom-cli', installs: 3 }] }));
      }
      if (url.startsWith(AGENT_SKILLS_DIRECTORY.AUDIT_URL)) throw new Error('network down');
      return realFetch(input, init);
    }));
    try {
      const search = await app.request('/api/agent-skills/directory/search?q=wecom-route-test', { headers: headers(stranger) });
      expect(search.status).toBe(200);
      expect(await search.json()).toEqual({ results: [{ name: 'wecomcli-doc', source: 'wecomteam/wecom-cli', installs: 3 }] });

      const audit = await app.request('/api/agent-skills/directory/audit?source=wecomteam/wecom-cli&skills=wecomcli-doc', { headers: headers(stranger) });
      expect(audit.status).toBe(502);
      expect(await audit.json()).toEqual({ error: AGENT_SKILLS_DIRECTORY_ERROR.UNAVAILABLE });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lists and edits MCP servers on the owner\'s own daemon, and passes install values through', async () => {
    const daemon = await connectDaemon(machine, 'daemon-token');
    const app = buildApp(env());
    const list = await app.request(`/api/agent-mcp?serverId=${machine}`, { headers: headers(owner) });
    expect(list.status).toBe(200);
    expect((await list.json() as { servers: unknown[] }).servers).toHaveLength(1);

    const server = { name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ghp_x' } };
    const run = await app.request(`/api/agent-mcp/run?serverId=${machine}`, {
      method: 'POST', headers: headers(owner, true), body: JSON.stringify({ action: 'add', server }),
    });
    expect(run.status).toBe(200);
    expect(await run.json()).toEqual({ ok: true, results: [{ agent: 'codex', ok: true }] });
    expect(daemon.received.at(-1)).toMatchObject({ type: AGENT_MCP_MSG.RUN_REQUEST, action: 'add', server });
  });

  it('keeps MCP edits to the owner and refuses unsafe servers before the daemon sees them', async () => {
    const daemon = await connectDaemon(machine, 'daemon-token');
    const app = buildApp(env());
    const stranger403 = await app.request(`/api/agent-mcp/run?serverId=${machine}`, {
      method: 'POST', headers: headers(stranger, true), body: JSON.stringify({ action: 'remove', name: 'github' }),
    });
    expect(stranger403.status).toBe(403);
    for (const body of [
      { action: 'add', server: { name: 'x', transport: 'stdio', command: 'npx; curl evil' } },
      { action: 'remove', name: 'imcodes-memory' },
    ]) {
      const res = await app.request(`/api/agent-mcp/run?serverId=${machine}`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify(body) });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: AGENT_MCP_ERROR.INVALID_REQUEST });
    }
    expect(daemon.received).toEqual([]);
  });
});

