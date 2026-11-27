import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  REMOTE_VOICE_ENV_ASR_DEVICE_ID,
  REMOTE_VOICE_HTTP_ASR_MAX_AUDIO_BYTES,
  REMOTE_VOICE_MAX_NICKNAME_CHARS,
  REMOTE_VOICE_MAX_PCM_CHUNK_BYTES,
  REMOTE_VOICE_PRIMARY_PROVIDER_PREF_KEY,
  REMOTE_VOICE_PROVIDER_NICKNAMES_PREF_KEY,
  REMOTE_VOICE_SAMPLE_RATE,
  REMOTE_VOICE_SERVER_ASR_SERVICES_SETTING_KEY,
  REMOTE_VOICE_SERVER_SHARED_SETTING_KEY,
  REMOTE_VOICE_WS_PATH,
  formatDefaultRemoteVoiceNickname,
  formatRemoteVoiceModelLabel,
  isValidPcmBase64Chunk,
  isValidRemoteVoiceModel,
  isValidRemoteVoiceModelRegistration,
  parseRemoteVoiceInboundFrame,
  resolveOpenAiTranscriptionEndpoint,
  sanitizeCrossAccountOwnerLabel,
  sanitizeRemoteVoiceNickname,
  sanitizeRemoteVoiceProviderErrorCode,
  validatePrimaryProviderBody,
  validateProviderNicknameBody,
  validateRemoteVoiceAsrBaseUrl,
  validateServerAsrServiceBody,
  validateServerSharedProviderBody,
} from '../../shared/remote-voice.js';
import { ACCOUNT_SESSION_JWT_TYPE } from '../../shared/auth-token-types.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { buildApp, setupWebSocketUpgrade } from '../src/index.js';
import { sha256Hex, signJwt } from '../src/security/crypto.js';
import { encodePcm16MonoToWav, normalizeAsrLanguage } from '../src/services/remote-voice-asr.js';
import {
  RemoteVoiceHub,
  remoteVoiceHub,
  resolveDbMachineNameForProvider,
  type OwnerServerMachineEntry,
} from '../src/services/remote-voice-hub.js';
import { closeConnectionsOfInactiveUsers } from '../src/ws/account-watch.js';

interface MemUser {
  id: string;
  username: string | null;
  display_name: string | null;
  password_hash: string | null;
  role: string;
  is_admin: boolean;
  status: 'active' | 'pending' | 'disabled';
  sessions_valid_after: number;
  created_at: number;
}

class MemoryVoiceTestDb {
  users = new Map<string, MemUser>();
  servers = new Map<string, {
    id: string;
    user_id: string;
    name?: string | null;
    display_name?: string | null;
    ref_name?: string | null;
    host_server_id?: string | null;
    token_hash: string;
    node_role: string;
    os?: string | null;
    revoked_at: number | null;
    created_at?: number;
  }>();
  prefs = new Map<string, string>();
  settings = new Map<string, string>();
  audits: Array<{ userId: string | null; action: string; details: string | null; ip: string | null }> = [];
  queryLog: string[] = [];
  private txChain: Promise<void> = Promise.resolve();

  seedUser(opts: {
    id: string;
    username: string;
    displayName?: string | null;
    isAdmin?: boolean;
    status?: 'active' | 'pending' | 'disabled';
  }): void {
    this.users.set(opts.id, {
      id: opts.id,
      username: opts.username,
      display_name: opts.displayName ?? null,
      password_hash: null,
      role: opts.isAdmin ? 'admin' : 'user',
      is_admin: Boolean(opts.isAdmin),
      status: opts.status ?? 'active',
      sessions_valid_after: 0,
      created_at: Date.now(),
    });
  }

  asDatabase(): Database {
    const dbObj: Database = {
      query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
        const norm = sql.toLowerCase().replace(/\s+/g, ' ').trim();
        if (norm.includes('from users u where u.id = any($1')) {
          const ids = Array.isArray(params[0]) ? params[0].map(String) : [];
          return ids
            .map((id) => this.users.get(id))
            .filter((u): u is MemUser => Boolean(u && u.status === 'active'))
            .map((u) => ({ id: u.id })) as unknown as T[];
        }
        if (norm.startsWith('select key, value from settings')) {
          return [...this.settings.entries()].map(([key, value]) => ({ key, value })) as unknown as T[];
        }
        if (norm.includes('from servers where user_id = $1 and revoked_at is null')) {
          const userId = String(params[0]);
          return [...this.servers.values()]
            .filter((s) => s.user_id === userId && s.revoked_at == null)
            .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
            .map((s) => ({
              id: s.id,
              name: s.name ?? null,
              display_name: s.display_name ?? null,
              ref_name: s.ref_name ?? null,
              host_server_id: s.host_server_id ?? null,
              node_role: s.node_role ?? null,
              os: s.os ?? null,
            })) as unknown as T[];
        }
        return [] as T[];
      },
      queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
        const norm = sql.toLowerCase().replace(/\s+/g, ' ').trim();
        this.queryLog.push(norm);
        if (norm.includes('from users where id = $1')) {
          return (this.users.get(String(params[0])) ?? null) as unknown as T | null;
        }
        if (norm.includes('from servers where id = $1')) {
          const srv = this.servers.get(String(params[0]));
          if (!srv) return null as unknown as T | null;
          const owner = this.users.get(srv.user_id);
          return {
            ...srv,
            owner_status: owner?.status ?? 'disabled',
          } as unknown as T | null;
        }
        if (norm.startsWith('select value from user_preferences where user_id = $1 and key = $2')) {
          const val = this.prefs.get(`${String(params[0])}\0${String(params[1])}`);
          return (val !== undefined ? { value: val } : null) as unknown as T | null;
        }
        if (norm.startsWith('select value from settings where key = $1')) {
          const val = this.settings.get(String(params[0]));
          return (val !== undefined ? { value: val } : null) as unknown as T | null;
        }
        return null;
      },
      execute: async (sql: string, params: unknown[] = []) => {
        const norm = sql.toLowerCase().replace(/\s+/g, ' ').trim();
        if (norm.startsWith('insert into user_preferences')) {
          this.prefs.set(`${String(params[0])}\0${String(params[1])}`, String(params[2]));
          return { changes: 1 };
        }
        if (norm.startsWith('delete from user_preferences')) {
          this.prefs.delete(`${String(params[0])}\0${String(params[1])}`);
          return { changes: 1 };
        }
        if (norm.startsWith('insert into settings')) {
          const key = String(params[0]);
          if (norm.includes('do nothing') && this.settings.has(key)) {
            return { changes: 0 };
          }
          this.settings.set(key, String(params[1]));
          return { changes: 1 };
        }
        if (norm.startsWith('insert into audit_log')) {
          this.audits.push({
            userId: params[1] ? String(params[1]) : null,
            action: String(params[3]),
            details: params[4] ? String(params[4]) : null,
            ip: params[5] ? String(params[5]) : null,
          });
          return { changes: 1 };
        }
        return { changes: 0 };
      },
      transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
        const prev = this.txChain;
        let release!: () => void;
        this.txChain = new Promise<void>((resolve) => { release = resolve; });
        await prev;
        try {
          return await fn(dbObj);
        } finally {
          release();
        }
      },
      close: async () => {},
      healthCheck: async () => true,
    };
    return dbObj;
  }
}

class FrameInbox {
  private readonly queue: Record<string, unknown>[] = [];
  private readonly waiters: Array<(msg: Record<string, unknown>) => void> = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      const nextWaiter = this.waiters.shift();
      if (nextWaiter) {
        nextWaiter(parsed);
      } else {
        this.queue.push(parsed);
      }
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  async next(predicate?: (frame: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
    const start = Date.now();
    while (true) {
      const idx = this.queue.findIndex((item) => (predicate ? predicate(item) : true));
      if (idx >= 0) {
        return this.queue.splice(idx, 1)[0]!;
      }
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for WS frame; queued=${JSON.stringify(this.queue)}`);
      }
      const incoming = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          const waiterIdx = this.waiters.indexOf(onMsg);
          if (waiterIdx >= 0) this.waiters.splice(waiterIdx, 1);
          reject(new Error(`Timed out waiting for WS frame; queued=${JSON.stringify(this.queue)}`));
        }, remaining);
        const onMsg = (msg: Record<string, unknown>) => {
          clearTimeout(timer);
          resolve(msg);
        };
        this.waiters.push(onMsg);
      });
      if (!predicate || predicate(incoming)) {
        return incoming;
      }
      this.queue.push(incoming);
    }
  }
}

const JWT_SECRET = 'remote-voice-test-secret-0123456789abcdef';

function makeAuthHeader(userId: string): string {
  const token = signJwt(
    { sub: userId, type: ACCOUNT_SESSION_JWT_TYPE },
    JWT_SECRET,
    3600,
  );
  return `Bearer ${token}`;
}

async function openVoiceWs(baseUrl: string, origin: string, ticket: string): Promise<{ ws: WebSocket; inbox: FrameInbox }> {
  const wsUrl = baseUrl.replace(/^http/, 'ws') + `${REMOTE_VOICE_WS_PATH}?ticket=${encodeURIComponent(ticket)}`;
  const ws = new WebSocket(wsUrl, { headers: { origin } });
  const inbox = new FrameInbox(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`Unexpected HTTP status ${res.statusCode}`));
    });
  });
  return { ws, inbox };
}

describe('shared/remote-voice validators & formatters', () => {
  it('enforces strict open-source model labels, default nicknames, and error code sanitization', () => {
    expect(isValidRemoteVoiceModel('qwen3-1.7b')).toBe(true);
    expect(isValidRemoteVoiceModel('qwen3-0.6b')).toBe(true);
    expect(isValidRemoteVoiceModel('system')).toBe(false);
    expect(isValidRemoteVoiceModel('whisper-large')).toBe(false);

    expect(formatRemoteVoiceModelLabel('qwen3-1.7b')).toBe('Qwen3-ASR 1.7B');
    expect(formatRemoteVoiceModelLabel('qwen3-0.6b')).toBe('Qwen3-ASR 0.6B');
    expect(formatRemoteVoiceModelLabel('system')).toBeNull();
    expect(formatRemoteVoiceModelLabel('custom-gpu-model')).toBeNull();

    expect(isValidRemoteVoiceModelRegistration('qwen3-1.7b', 'Qwen3-ASR 1.7B')).toBe(true);
    expect(isValidRemoteVoiceModelRegistration('qwen3-0.6b', 'Qwen3-ASR 0.6B')).toBe(true);
    expect(isValidRemoteVoiceModelRegistration('qwen3-1.7b', 'Qwen3-ASR 0.6B')).toBe(false);
    expect(isValidRemoteVoiceModelRegistration('qwen3-1.7b', 'Forged Mac Label')).toBe(false);
    expect(isValidRemoteVoiceModelRegistration('system', 'System')).toBe(false);

    expect(sanitizeRemoteVoiceProviderErrorCode('provider_busy')).toBe('provider_busy');
    expect(sanitizeRemoteVoiceProviderErrorCode('mlx_crash_on_k_macbook')).toBe('helper_error');
    expect(sanitizeRemoteVoiceProviderErrorCode('')).toBe('helper_error');

    expect(formatDefaultRemoteVoiceNickname('K', 'Qwen3-ASR 1.7B')).toBe('K · Qwen3-ASR 1.7B');
    expect(formatDefaultRemoteVoiceNickname('', 'Qwen3-ASR 0.6B')).toBe('Qwen3-ASR 0.6B');
    expect(sanitizeRemoteVoiceNickname('  My \x00 Mac \n ')).toBe('My  Mac');
    expect(sanitizeRemoteVoiceNickname('   ')).toBeNull();
    expect(sanitizeRemoteVoiceNickname(null)).toBeNull();

    expect(sanitizeCrossAccountOwnerLabel('K', 'k_admin')).toBe('K');
    expect(sanitizeCrossAccountOwnerLabel('alice@example.com', 'alice')).toBe('Desktop');
    expect(sanitizeCrossAccountOwnerLabel('MacBook-Pro.local', 'k_admin')).toBe('Desktop');
    expect(sanitizeCrossAccountOwnerLabel('k_admin', 'k_admin')).toBe('Desktop');
    expect(sanitizeCrossAccountOwnerLabel('RTX 4090 Rig', 'k_admin')).toBe('Desktop');
    expect(sanitizeCrossAccountOwnerLabel('192.168.1.42', 'k_admin')).toBe('Desktop');
  });

  it('rejects forged/system/unknown models on registration and strips provider error messages', () => {
    expect(parseRemoteVoiceInboundFrame({
      type: 'voice.provider.register',
      deviceId: 'dev-1',
      model: 'system',
      modelLabel: 'System',
      ready: true,
    }).ok).toBe(false);
    expect(parseRemoteVoiceInboundFrame({
      type: 'voice.provider.register',
      deviceId: 'dev-1',
      model: 'whisper-large',
      modelLabel: 'Whisper Large',
      ready: true,
    }).ok).toBe(false);
    expect(parseRemoteVoiceInboundFrame({
      type: 'voice.provider.register',
      deviceId: 'dev-1',
      model: 'qwen3-1.7b',
      modelLabel: 'Fake Qwen RTX4090',
      ready: true,
    }).ok).toBe(false);
    expect(parseRemoteVoiceInboundFrame({
      type: 'voice.provider.register',
      deviceId: 'dev-1',
      model: 'qwen3-1.7b',
      modelLabel: 'Qwen3-ASR 0.6B',
      ready: true,
    }).ok).toBe(false);
    expect(parseRemoteVoiceInboundFrame({
      type: 'voice.provider.register',
      deviceId: 'dev-1',
      model: 'qwen3-1.7b',
      modelLabel: 'Qwen3-ASR 1.7B',
      ready: true,
    })).toEqual({
      ok: true,
      frame: {
        type: 'voice.provider.register',
        deviceId: 'dev-1',
        model: 'qwen3-1.7b',
        modelLabel: 'Qwen3-ASR 1.7B',
        ready: true,
      },
    });

    expect(parseRemoteVoiceInboundFrame({
      type: 'voice.session.error',
      sessionId: 'sess-1',
      code: 'cuda_oom_k_host',
      message: '/Users/k/models/1.7b on MacBook-Pro RTX4090 crashed',
    })).toEqual({
      ok: true,
      frame: {
        type: 'voice.session.error',
        sessionId: 'sess-1',
        code: 'helper_error',
      },
    });
  });

  it('validates primary provider, nickname, server-shared, and PCM frames safely', () => {
    expect(validatePrimaryProviderBody({ primaryDeviceId: 'dev-1' })).toEqual({ ok: true, primaryDeviceId: 'dev-1' });
    expect(validatePrimaryProviderBody({ primaryDeviceId: null })).toEqual({ ok: true, primaryDeviceId: null });
    expect(validatePrimaryProviderBody({ primaryDeviceId: '../bad' }).ok).toBe(false);

    expect(validateProviderNicknameBody({ deviceId: 'dev-1', nickname: ' Studio Mac ' })).toEqual({
      ok: true,
      deviceId: 'dev-1',
      nickname: 'Studio Mac',
    });
    expect(validateProviderNicknameBody({ deviceId: 'dev-1', nickname: 'x'.repeat(REMOTE_VOICE_MAX_NICKNAME_CHARS + 1) })).toEqual({
      ok: false,
      error: 'nickname_too_long',
    });

    expect(validateServerSharedProviderBody({ deviceId: 'dev-1', shared: true, nickname: 'Lab' })).toEqual({
      ok: true,
      deviceId: 'dev-1',
      shared: true,
      nickname: 'Lab',
    });

    const validPcm = Buffer.alloc(320).toString('base64');
    const oversizedPcm = Buffer.alloc(REMOTE_VOICE_MAX_PCM_CHUNK_BYTES + 2).toString('base64');
    const oddBytePcm = Buffer.alloc(3).toString('base64');
    expect(isValidPcmBase64Chunk(validPcm)).toBe(true);
    expect(isValidPcmBase64Chunk(oversizedPcm)).toBe(false);
    expect(isValidPcmBase64Chunk(oddBytePcm)).toBe(false);

    expect(parseRemoteVoiceInboundFrame('not-json').ok).toBe(false);
    expect(parseRemoteVoiceInboundFrame({
      type: 'voice.session.audio',
      sessionId: 'sess-1',
      pcmBase64: oversizedPcm,
    })).toEqual({
      ok: false,
      sessionId: 'sess-1',
      code: 'chunk_too_large',
      message: 'PCM chunk exceeds max size',
    });
  });
});

describe('RemoteVoiceHub + /api/voice routes + /api/ws/voice-relay', () => {
  let memDb: MemoryVoiceTestDb;
  let db: Database;
  let server: ReturnType<typeof serve> | null = null;
  let baseUrl = '';
  const openSockets: WebSocket[] = [];

  beforeEach(async () => {
    remoteVoiceHub.stop();
    memDb = new MemoryVoiceTestDb();
    memDb.seedUser({ id: 'admin-a', username: 'k_admin', displayName: 'K', isAdmin: true });
    memDb.seedUser({ id: 'user-b', username: 'bob', displayName: 'Bob', isAdmin: false });
    db = memDb.asDatabase();

    const env: Env = {
      DB: db,
      JWT_SIGNING_KEY: JWT_SECRET,
      BOT_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
      SERVER_URL: 'http://127.0.0.1',
      NODE_ENV: 'development',
      PORT: 0,
    };
    const app = buildApp(env);
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    env.ALLOWED_ORIGINS = baseUrl;
    setupWebSocketUpgrade(server as unknown as import('node:http').Server, env);
  });

  afterEach(async () => {
    for (const ws of openSockets.splice(0, openSockets.length)) {
      try { ws.close(); } catch { /* ignore */ }
    }
    remoteVoiceHub.stop();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  async function issueWsTicket(userId: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/voice/ws-ticket`, {
      method: 'POST',
      headers: { Authorization: makeAuthHeader(userId) },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ticket: string };
    return body.ticket;
  }

  it('enforces single-use JTI tickets & origin checks on WS upgrade, routes same-account audio, and keeps accounts isolated by default', async () => {
    const ticketA = await issueWsTicket('admin-a');
    // Wrong origin rejected (403)
    await expect(openVoiceWs(baseUrl, 'https://evil.example', ticketA)).rejects.toThrow(/403/);

    // Provider A connects with valid origin & ticket
    const providerA = await openVoiceWs(baseUrl, baseUrl, ticketA);
    openSockets.push(providerA.ws);
    // Replay of same single-use JTI ticket rejected (401)
    await expect(openVoiceWs(baseUrl, baseUrl, ticketA)).rejects.toThrow(/401/);

    providerA.ws.send(JSON.stringify({
      type: 'voice.provider.register',
      deviceId: 'mac-studio',
      model: 'qwen3-1.7b',
      modelLabel: 'Qwen3-ASR 1.7B',
      ready: true,
    }));
    await providerA.inbox.next((f) => f.type === 'voice.providers.updated');

    // Daemon credentials are refused on /api/voice/* (refuseDaemonCredential: true)
    memDb.servers.set('srv-daemon-1', {
      id: 'srv-daemon-1',
      user_id: 'admin-a',
      token_hash: sha256Hex('daemon-secret-token'),
      node_role: 'full',
      revoked_at: null,
    });
    const daemonRes = await fetch(`${baseUrl}/api/voice/providers`, {
      headers: {
        Authorization: 'Bearer daemon-secret-token',
        'X-Server-Id': 'srv-daemon-1',
      },
    });
    expect(daemonRes.status).toBe(403);
    const daemonTicketRes = await fetch(`${baseUrl}/api/voice/ws-ticket`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer daemon-secret-token',
        'X-Server-Id': 'srv-daemon-1',
      },
    });
    expect(daemonTicketRes.status).toBe(403);

    // User A sees own provider with default nickname "K · Qwen3-ASR 1.7B", account scope, and zero sensitive leak
    const listARes = await fetch(`${baseUrl}/api/voice/providers`, {
      headers: { Authorization: makeAuthHeader('admin-a') },
    });
    expect(listARes.status).toBe(200);
    const listA = await listARes.json() as {
      primaryDeviceId: string | null;
      canManageServerSharing: boolean;
      canShareOwnProviderToServer: boolean;
      providers: Array<Record<string, unknown>>;
    };
    expect(listA.canManageServerSharing).toBe(true);
    expect(listA.canShareOwnProviderToServer).toBe(true);
    expect(listA.providers).toHaveLength(1);
    expect(listA.providers[0]).toEqual({
      deviceId: 'mac-studio',
      displayName: 'K · Qwen3-ASR 1.7B',
      customNickname: null,
      model: 'qwen3-1.7b',
      modelLabel: 'Qwen3-ASR 1.7B',
      shareScope: 'account',
      isOwnDevice: true,
      ready: true,
      busy: false,
    });

    // User B does NOT see User A's account-private provider and gets identical provider_offline for both unauthorized & unknown IDs (no oracle)
    const listBRes = await fetch(`${baseUrl}/api/voice/providers`, {
      headers: { Authorization: makeAuthHeader('user-b') },
    });
    const listB = await listBRes.json() as {
      canManageServerSharing: boolean;
      canShareOwnProviderToServer: boolean;
      providers: unknown[];
    };
    expect(listB.canManageServerSharing).toBe(false);
    expect(listB.canShareOwnProviderToServer).toBe(true);
    expect(listB.providers).toEqual([]);

    const clientB = await openVoiceWs(baseUrl, baseUrl, await issueWsTicket('user-b'));
    openSockets.push(clientB.ws);
    clientB.ws.send(JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'cross-guess',
      targetDeviceId: 'mac-studio',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
    }));
    const denied = await clientB.inbox.next((f) => f.type === 'voice.session.error');
    clientB.ws.send(JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'nonexistent-guess',
      targetDeviceId: 'does-not-exist-device',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
    }));
    const nonexistent = await clientB.inbox.next((f) => f.type === 'voice.session.error' && f.sessionId === 'nonexistent-guess');
    expect(denied).toEqual({ type: 'voice.session.error', sessionId: 'cross-guess', code: 'provider_offline' });
    expect(nonexistent).toEqual({ type: 'voice.session.error', sessionId: 'nonexistent-guess', code: 'provider_offline' });

    // Primary provider preference persists cleanly
    const putPrimary = await fetch(`${baseUrl}/api/voice/primary-provider`, {
      method: 'PUT',
      headers: {
        Authorization: makeAuthHeader('admin-a'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ primaryDeviceId: 'mac-studio' }),
    });
    expect(putPrimary.status).toBe(200);
    expect(JSON.parse(memDb.prefs.get(`admin-a\0${REMOTE_VOICE_PRIMARY_PROVIDER_PREF_KEY}`)!)).toBe('mac-studio');

    // Same-account Client A streams audio cleanly through Provider A with zero caller identity forwarded
    const clientA = await openVoiceWs(baseUrl, baseUrl, await issueWsTicket('admin-a'));
    openSockets.push(clientA.ws);
    clientA.ws.send(JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'sess-own-1',
      targetDeviceId: 'mac-studio',
      locale: 'zh-Hans',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
    }));
    const startToProvider = await providerA.inbox.next((f) => f.type === 'voice.session.start');
    expect(startToProvider).toEqual({
      type: 'voice.session.start',
      sessionId: 'sess-own-1',
      locale: 'zh-Hans',
      sampleRate: 16000,
    });

    providerA.ws.send(JSON.stringify({ type: 'voice.session.ready', sessionId: 'sess-own-1' }));
    expect(await clientA.inbox.next((f) => f.type === 'voice.session.ready')).toMatchObject({ sessionId: 'sess-own-1' });

    const pcmChunk = Buffer.alloc(640, 1).toString('base64');
    clientA.ws.send(JSON.stringify({ type: 'voice.session.audio', sessionId: 'sess-own-1', pcmBase64: pcmChunk }));
    expect(await providerA.inbox.next((f) => f.type === 'voice.session.audio')).toMatchObject({
      sessionId: 'sess-own-1',
      pcmBase64: pcmChunk,
    });

    providerA.ws.send(JSON.stringify({ type: 'voice.session.result', sessionId: 'sess-own-1', text: '你好', isFinal: false }));
    expect(await clientA.inbox.next((f) => f.type === 'voice.session.result')).toMatchObject({
      sessionId: 'sess-own-1',
      text: '你好',
      isFinal: false,
    });

    clientA.ws.send(JSON.stringify({ type: 'voice.session.stop', sessionId: 'sess-own-1' }));
    expect(await providerA.inbox.next((f) => f.type === 'voice.session.stop')).toMatchObject({ sessionId: 'sess-own-1' });
    providerA.ws.send(JSON.stringify({ type: 'voice.session.result', sessionId: 'sess-own-1', text: '你好世界', isFinal: true }));
    providerA.ws.send(JSON.stringify({ type: 'voice.session.end', sessionId: 'sess-own-1' }));

    expect(await clientA.inbox.next((f) => f.type === 'voice.session.result')).toMatchObject({
      sessionId: 'sess-own-1',
      text: '你好世界',
      isFinal: true,
    });
    expect(await clientA.inbox.next((f) => f.type === 'voice.session.end')).toMatchObject({ sessionId: 'sess-own-1' });
  });

  it('supports custom nicknames while preserving modelLabel, admin-only server sharing, immediate revocation, zero cross-account leaks, and account-watch cleanup', async () => {
    const providerA = await openVoiceWs(baseUrl, baseUrl, await issueWsTicket('admin-a'));
    openSockets.push(providerA.ws);
    providerA.ws.send(JSON.stringify({
      type: 'voice.provider.register',
      deviceId: 'win-gpu',
      model: 'qwen3-0.6b',
      modelLabel: 'Qwen3-ASR 0.6B',
      ready: true,
    }));
    await providerA.inbox.next((f) => f.type === 'voice.providers.updated');

    // Non-admin still cannot enable server-wide sharing for another user's online device (403)
    const nonAdminOtherDevicePut = await fetch(`${baseUrl}/api/voice/server-shared-providers`, {
      method: 'PUT',
      headers: { Authorization: makeAuthHeader('user-b'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'win-gpu', shared: true }),
    });
    expect(nonAdminOtherDevicePut.status).toBe(403);

    // Owner customizes nickname; modelLabel remains explicit
    const nickRes = await fetch(`${baseUrl}/api/voice/provider-nickname`, {
      method: 'PUT',
      headers: { Authorization: makeAuthHeader('admin-a'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'win-gpu', nickname: '客厅主力机' }),
    });
    expect(nickRes.status).toBe(200);
    expect(JSON.parse(memDb.prefs.get(`admin-a\0${REMOTE_VOICE_PROVIDER_NICKNAMES_PREF_KEY}`)!)).toEqual({
      'win-gpu': '客厅主力机',
    });

    // Admin manually enables relay-server sharing for own device
    const shareOn = await fetch(`${baseUrl}/api/voice/server-shared-providers`, {
      method: 'PUT',
      headers: { Authorization: makeAuthHeader('admin-a'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'win-gpu', shared: true }),
    });
    expect(shareOn.status).toBe(200);
    expect(JSON.parse(memDb.settings.get(REMOTE_VOICE_SERVER_SHARED_SETTING_KEY)!)).toEqual([
      { ownerUserId: 'admin-a', deviceId: 'win-gpu', nickname: '客厅主力机' },
    ]);
    expect(memDb.audits.some((a) => a.action === 'remote_voice.enable_server_sharing' && a.userId === 'admin-a')).toBe(true);

    // User B sees ONLY minimal zero-leak shared provider fields (no ownerUserId, username, hostname, platform, ip, connectedAt, or customNickname)
    const listB = await (await fetch(`${baseUrl}/api/voice/providers`, {
      headers: { Authorization: makeAuthHeader('user-b') },
    })).json() as { providers: Array<Record<string, unknown>> };
    expect(listB.providers).toHaveLength(1);
    expect(listB.providers[0]).toEqual({
      deviceId: 'win-gpu',
      displayName: '客厅主力机',
      model: 'qwen3-0.6b',
      modelLabel: 'Qwen3-ASR 0.6B',
      ready: true,
      busy: false,
      shareScope: 'server',
      isOwnDevice: false,
    });
    expect(Object.keys(listB.providers[0]!).sort()).toEqual([
      'busy',
      'deviceId',
      'displayName',
      'isOwnDevice',
      'model',
      'modelLabel',
      'ready',
      'shareScope',
    ]);

    // Clearing custom nickname when owner has no display_name never leaks owner's login username cross-account
    memDb.users.get('admin-a')!.display_name = null;
    await fetch(`${baseUrl}/api/voice/provider-nickname`, {
      method: 'PUT',
      headers: { Authorization: makeAuthHeader('admin-a'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'win-gpu', nickname: null }),
    });
    const listBAfterClear = await (await fetch(`${baseUrl}/api/voice/providers`, {
      headers: { Authorization: makeAuthHeader('user-b') },
    })).json() as { providers: Array<Record<string, unknown>> };
    expect(listBAfterClear.providers[0]!.displayName).toBe('Desktop · Qwen3-ASR 0.6B');
    expect(String(listBAfterClear.providers[0]!.displayName)).not.toContain('k_admin');

    // Cross-account displayName NEVER leaks email, hostname, username, or GPU strings from DB display_name
    for (const unsafeDisplay of ['alice@example.com', 'MacBook-Pro.local', 'k_admin', 'RTX 4090 Node']) {
      memDb.users.get('admin-a')!.display_name = unsafeDisplay;
      const crossRes = await (await fetch(`${baseUrl}/api/voice/providers`, {
        headers: { Authorization: makeAuthHeader('user-b') },
      })).json() as { providers: Array<Record<string, unknown>> };
      expect(crossRes.providers[0]).toEqual({
        deviceId: 'win-gpu',
        displayName: 'Desktop · Qwen3-ASR 0.6B',
        model: 'qwen3-0.6b',
        modelLabel: 'Qwen3-ASR 0.6B',
        ready: true,
        busy: false,
        shareScope: 'server',
        isOwnDevice: false,
      });
      expect(JSON.stringify(crossRes)).not.toContain(unsafeDisplay);

      // Owner themselves still sees their own full display_name
      const ownRes = await (await fetch(`${baseUrl}/api/voice/providers`, {
        headers: { Authorization: makeAuthHeader('admin-a') },
      })).json() as { providers: Array<Record<string, unknown>> };
      expect(ownRes.providers[0]!.displayName).toBe(`${unsafeDisplay} · Qwen3-ASR 0.6B`);
    }
    memDb.users.get('admin-a')!.display_name = 'K';

    // User B starts a live cross-account session -> forwarded frame omits all caller identity
    const clientB = await openVoiceWs(baseUrl, baseUrl, await issueWsTicket('user-b'));
    openSockets.push(clientB.ws);
    clientB.ws.send(JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'shared-sess-1',
      targetDeviceId: 'win-gpu',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
    }));
    const sharedStartToProvider = await providerA.inbox.next((f) => f.type === 'voice.session.start');
    expect(sharedStartToProvider).toEqual({
      type: 'voice.session.start',
      sessionId: 'shared-sess-1',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
    });
    expect(sharedStartToProvider).not.toHaveProperty('userId');
    expect(sharedStartToProvider).not.toHaveProperty('username');
    providerA.ws.send(JSON.stringify({ type: 'voice.session.ready', sessionId: 'shared-sess-1' }));
    await clientB.inbox.next((f) => f.type === 'voice.session.ready');

    // Admin toggles shared=false -> active cross-account session terminates immediately
    const shareOff = await fetch(`${baseUrl}/api/voice/server-shared-providers`, {
      method: 'PUT',
      headers: { Authorization: makeAuthHeader('admin-a'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'win-gpu', shared: false }),
    });
    expect(shareOff.status).toBe(200);
    expect(memDb.audits.some((a) => a.action === 'remote_voice.disable_server_sharing')).toBe(true);

    const providerAbort = await providerA.inbox.next((f) => f.type === 'voice.session.abort');
    expect(providerAbort).toMatchObject({ sessionId: 'shared-sess-1' });
    const clientRevoked = await clientB.inbox.next((f) => f.type === 'voice.session.error');
    expect(clientRevoked).toMatchObject({ sessionId: 'shared-sess-1', code: 'provider_offline' });

    // Disabled account closes active relay sockets via account-watch
    memDb.users.get('user-b')!.status = 'disabled';
    const watchRes = await closeConnectionsOfInactiveUsers(db, []);
    expect(watchRes.inactiveUsers).toBe(1);
    expect(watchRes.browserSockets).toBeGreaterThanOrEqual(1);
    const closedB = await clientB.inbox.closed;
    expect(closedB.code).toBe(1008);
  });

  it('strips provider error messages and maps unknown codes to helper_error across WS relay, and rejects invalid/system provider registrations', async () => {
    const providerA = await openVoiceWs(baseUrl, baseUrl, await issueWsTicket('admin-a'));
    openSockets.push(providerA.ws);

    // System, unknown model, and forged modelLabel registrations are ignored/rejected by hub
    for (const invalidReg of [
      { type: 'voice.provider.register', deviceId: 'dev-sys', model: 'system', modelLabel: 'System', ready: true },
      { type: 'voice.provider.register', deviceId: 'dev-unk', model: 'whisper-v3', modelLabel: 'Whisper', ready: true },
      { type: 'voice.provider.register', deviceId: 'dev-forge', model: 'qwen3-1.7b', modelLabel: 'MacBook M4 Max 1.7B', ready: true },
      { type: 'voice.provider.register', deviceId: 'dev-mismatch', model: 'qwen3-0.6b', modelLabel: 'Qwen3-ASR 1.7B', ready: true },
    ]) {
      providerA.ws.send(JSON.stringify(invalidReg));
    }
    // Register valid 0.6B provider -> only dev-valid appears with canonical Qwen3-ASR 0.6B label
    providerA.ws.send(JSON.stringify({
      type: 'voice.provider.register',
      deviceId: 'dev-valid',
      model: 'qwen3-0.6b',
      modelLabel: 'Qwen3-ASR 0.6B',
      ready: true,
    }));
    const updated = await providerA.inbox.next(
      (f) => f.type === 'voice.providers.updated' && Array.isArray(f.providers) && f.providers.length > 0,
    );
    expect(updated.providers).toHaveLength(1);
    expect((updated.providers as Array<Record<string, unknown>>)[0]).toMatchObject({
      deviceId: 'dev-valid',
      model: 'qwen3-0.6b',
      modelLabel: 'Qwen3-ASR 0.6B',
    });
    const listCheck = await (await fetch(`${baseUrl}/api/voice/providers`, {
      headers: { Authorization: makeAuthHeader('admin-a') },
    })).json() as { providers: Array<Record<string, unknown>> };
    expect(listCheck.providers.map((p) => p.deviceId)).toEqual(['dev-valid']);

    // Provider sends voice.session.error with sensitive path/hostname/GPU message -> client sees sanitized code only, no message
    const clientA = await openVoiceWs(baseUrl, baseUrl, await issueWsTicket('admin-a'));
    openSockets.push(clientA.ws);
    clientA.ws.send(JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'leak-err-1',
      targetDeviceId: 'dev-valid',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
    }));
    await providerA.inbox.next((f) => f.type === 'voice.session.start');
    providerA.ws.send(JSON.stringify({
      type: 'voice.session.error',
      sessionId: 'leak-err-1',
      code: 'mlx_metal_fail_host',
      message: '/Users/k/Library/Application Support/imcodes/speech-models on k-studio.local RTX4090 failed',
    }));
    const clientErr1 = await clientA.inbox.next((f) => f.type === 'voice.session.error' && f.sessionId === 'leak-err-1');
    expect(clientErr1).toEqual({
      type: 'voice.session.error',
      sessionId: 'leak-err-1',
      code: 'helper_error',
    });
    expect(JSON.stringify(clientErr1)).not.toContain('/Users/k');
    expect(JSON.stringify(clientErr1)).not.toContain('k-studio.local');
    expect(JSON.stringify(clientErr1)).not.toContain('RTX4090');

    // Allowlisted error code is preserved, while sensitive message is still stripped
    clientA.ws.send(JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'leak-err-2',
      targetDeviceId: 'dev-valid',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
    }));
    await providerA.inbox.next((f) => f.type === 'voice.session.start' && f.sessionId === 'leak-err-2');
    providerA.ws.send(JSON.stringify({
      type: 'voice.session.error',
      sessionId: 'leak-err-2',
      code: 'provider_busy',
      message: 'busy on secret-host /Users/k/path',
    }));
    const clientErr2 = await clientA.inbox.next((f) => f.type === 'voice.session.error' && f.sessionId === 'leak-err-2');
    expect(clientErr2).toEqual({
      type: 'voice.session.error',
      sessionId: 'leak-err-2',
      code: 'provider_busy',
    });
  });

  it('handles provider not-ready, busy, and ready timeout cleanly on isolated RemoteVoiceHub', async () => {
    const hub = new RemoteVoiceHub({ readyTimeoutMs: 40, idleTimeoutMs: 80 });
    const sentToClient: string[] = [];
    const sentToProvider: string[] = [];
    const fakeProvider = {
      readyState: WebSocket.OPEN,
      send: (d: string) => sentToProvider.push(d),
      on: () => {},
      close: () => {},
    } as unknown as WebSocket;
    const fakeClient = {
      readyState: WebSocket.OPEN,
      send: (d: string) => sentToClient.push(d),
      on: () => {},
      close: () => {},
    } as unknown as WebSocket;

    hub.handleConnection(fakeProvider, 'u1');
    hub.handleConnection(fakeClient, 'u1');

    // Register not-ready provider -> fast provider_not_ready
    const proto = hub as unknown as {
      handleRawMessage: (ws: WebSocket, u: string, raw: string) => Promise<void>;
    };
    await proto.handleRawMessage(fakeProvider, 'u1', JSON.stringify({
      type: 'voice.provider.register',
      deviceId: 'dev-1',
      model: 'qwen3-0.6b',
      modelLabel: 'Qwen3-ASR 0.6B',
      ready: false,
    }));
    await proto.handleRawMessage(fakeClient, 'u1', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 's-not-ready',
      targetDeviceId: 'dev-1',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
    }));
    expect(JSON.parse(sentToClient.at(-1)!)).toMatchObject({ sessionId: 's-not-ready', code: 'provider_not_ready' });

    // Register ready provider, start session without sending ready -> ready timeout fires
    await proto.handleRawMessage(fakeProvider, 'u1', JSON.stringify({
      type: 'voice.provider.register',
      deviceId: 'dev-1',
      model: 'qwen3-1.7b',
      modelLabel: 'Qwen3-ASR 1.7B',
      ready: true,
    }));
    await proto.handleRawMessage(fakeClient, 'u1', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 's-timeout',
      targetDeviceId: 'dev-1',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
    }));
    // Concurrent start while s-timeout pending -> provider_busy
    await proto.handleRawMessage(fakeClient, 'u1', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 's-busy',
      targetDeviceId: 'dev-1',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
    }));
    expect(JSON.parse(sentToClient.at(-1)!)).toMatchObject({ sessionId: 's-busy', code: 'provider_busy' });

    await new Promise((r) => setTimeout(r, 90));
    expect(sentToClient.some((raw) => {
      const m = JSON.parse(raw) as Record<string, unknown>;
      return m.sessionId === 's-timeout' && m.code === 'session_timeout';
    })).toBe(true);
    expect(hub.getActiveSessionCount()).toBe(0);
    hub.stop();
  });

  it('validates SSRF URLs, normalizes OpenAI transcription endpoints, and encodes 44-byte RIFF/WAVE WAV headers', () => {
    expect(resolveOpenAiTranscriptionEndpoint('https://api.openai.com')).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(resolveOpenAiTranscriptionEndpoint('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(resolveOpenAiTranscriptionEndpoint('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(resolveOpenAiTranscriptionEndpoint('https://api.openai.com/v1/audio/transcriptions')).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(resolveOpenAiTranscriptionEndpoint('https://my-host/custom/v1')).toBe('https://my-host/custom/v1/audio/transcriptions');
    expect(resolveOpenAiTranscriptionEndpoint('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000/v1/audio/transcriptions');

    // SSRF & invalid protocol checks
    expect(validateRemoteVoiceAsrBaseUrl('file:///etc/passwd')).toEqual({ ok: false, error: 'unsupported_protocol' });
    expect(validateRemoteVoiceAsrBaseUrl('ftp://example.com')).toEqual({ ok: false, error: 'unsupported_protocol' });
    expect(validateRemoteVoiceAsrBaseUrl('https://user:pass@api.openai.com')).toEqual({ ok: false, error: 'embedded_credentials' });
    expect(validateRemoteVoiceAsrBaseUrl('http://169.254.169.254/latest/meta-data')).toEqual({ ok: false, error: 'forbidden_host' });
    expect(validateRemoteVoiceAsrBaseUrl('http://100.100.100.200/latest/meta-data')).toEqual({ ok: false, error: 'forbidden_host' });
    expect(validateRemoteVoiceAsrBaseUrl('http://metadata.google.internal')).toEqual({ ok: false, error: 'forbidden_host' });
    expect(validateRemoteVoiceAsrBaseUrl('http://[fd00:ec2::254]')).toEqual({ ok: false, error: 'forbidden_host' });

    expect(validateServerAsrServiceBody({ name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' })).toEqual({
      ok: true,
      data: {
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        model: 'whisper-large-v3',
        enabled: true,
      },
    });
    expect(validateServerAsrServiceBody({ name: '', baseUrl: 'https://api.openai.com', model: 'whisper-1' })).toEqual({
      ok: false,
      error: 'invalid_name',
    });

    const pcm = Buffer.from([1, 2, 3, 4]);
    const wav = encodePcm16MonoToWav(pcm, 16_000);
    expect(wav.length).toBe(48);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(40);
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16); // bitsPerSample
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(4);
    expect(wav.subarray(44).equals(pcm)).toBe(true);

    expect(normalizeAsrLanguage('zh-CN')).toBe('zh');
    expect(normalizeAsrLanguage('en-US')).toBe('en');
    expect(normalizeAsrLanguage('auto')).toBeUndefined();
    expect(normalizeAsrLanguage(undefined)).toBeUndefined();
  });

  it('enforces admin CRUD auth, BOT_ENCRYPTION_KEY requirement, key preservation/clear, env default, and zero-leak on /api/voice/server-asr-services', async () => {
    // Non-admin receives 403 on all endpoints
    for (const [method, path] of [
      ['GET', '/api/voice/server-asr-services'],
      ['POST', '/api/voice/server-asr-services'],
      ['PUT', '/api/voice/server-asr-services/asr_1'],
      ['DELETE', '/api/voice/server-asr-services/asr_1'],
    ] as const) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: makeAuthHeader('user-b'),
          'Content-Type': 'application/json',
        },
        body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({ name: 'X', baseUrl: 'https://api.openai.com', model: 'whisper-1' }),
      });
      expect(res.status, `${method} ${path} for non-admin`).toBe(403);
    }

    // SSRF rejection
    const ssrfRes = await fetch(`${baseUrl}/api/voice/server-asr-services`, {
      method: 'POST',
      headers: { Authorization: makeAuthHeader('admin-a'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', baseUrl: 'http://169.254.169.254/latest', model: 'whisper-1' }),
    });
    expect(ssrfRes.status).toBe(400);

    // Create valid service with secret key -> stored encrypted in DB, masked in admin response, never leaked to /providers
    const secretKey = 'sk-super-secret-asr-987654321';
    const createRes = await fetch(`${baseUrl}/api/voice/server-asr-services`, {
      method: 'POST',
      headers: { Authorization: makeAuthHeader('admin-a'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'SiliconFlow SenseVoice',
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiKey: secretKey,
        model: 'FunAudioLLM/SenseVoiceSmall',
        enabled: true,
      }),
    });
    expect(createRes.status).toBe(201);
    const createdJson = await createRes.json() as {
      service: { id: string; name: string; baseUrl: string; hasApiKey: boolean; apiKeyMasked: string; model: string; enabled: boolean };
    };
    expect(createdJson.service.hasApiKey).toBe(true);
    expect(createdJson.service.apiKeyMasked).toBe('sk-s...4321');
    expect(JSON.stringify(createdJson)).not.toContain(secretKey);

    const rawSetting = memDb.settings.get(REMOTE_VOICE_SERVER_ASR_SERVICES_SETTING_KEY)!;
    expect(rawSetting).toBeTruthy();
    expect(rawSetting).not.toContain(secretKey);
    expect(memDb.audits.some((a) => a.action === 'remote_voice.create_server_asr_service')).toBe(true);

    // Non-admin /api/voice/providers exposes enabled http_asr provider with zero leaks
    const nonAdminProvidersRes = await fetch(`${baseUrl}/api/voice/providers`, {
      headers: { Authorization: makeAuthHeader('user-b') },
    });
    expect(nonAdminProvidersRes.status).toBe(200);
    const nonAdminProvidersJson = await nonAdminProvidersRes.json() as {
      canManageServerSharing: boolean;
      canShareOwnProviderToServer: boolean;
      providers: Array<Record<string, unknown>>;
    };
    expect(nonAdminProvidersJson.canManageServerSharing).toBe(false);
    expect(nonAdminProvidersJson.canShareOwnProviderToServer).toBe(true);
    expect(nonAdminProvidersJson.providers).toEqual([
      {
        deviceId: createdJson.service.id,
        displayName: 'SiliconFlow SenseVoice',
        model: 'FunAudioLLM/SenseVoiceSmall',
        modelLabel: 'FunAudioLLM/SenseVoiceSmall',
        ready: true,
        busy: false,
        shareScope: 'server',
        providerKind: 'http_asr',
        isOwnDevice: false,
      },
    ]);
    const serializedProviders = JSON.stringify(nonAdminProvidersJson);
    expect(serializedProviders).not.toContain('siliconflow.cn');
    expect(serializedProviders).not.toContain(secretKey);
    expect(serializedProviders).not.toContain('sk-s...4321');

    // Update omitting apiKey preserves encrypted key; empty string clears it
    const keepKeyRes = await fetch(`${baseUrl}/api/voice/server-asr-services/${createdJson.service.id}`, {
      method: 'PUT',
      headers: { Authorization: makeAuthHeader('admin-a'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'SenseVoice Renamed' }),
    });
    expect(keepKeyRes.status).toBe(200);
    const keepKeyJson = await keepKeyRes.json() as { service: { hasApiKey: boolean; apiKeyMasked: string | null; name: string } };
    expect(keepKeyJson.service.name).toBe('SenseVoice Renamed');
    expect(keepKeyJson.service.hasApiKey).toBe(true);
    expect(keepKeyJson.service.apiKeyMasked).toBe('sk-s...4321');

    const clearKeyRes = await fetch(`${baseUrl}/api/voice/server-asr-services/${createdJson.service.id}`, {
      method: 'PUT',
      headers: { Authorization: makeAuthHeader('admin-a'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: '' }),
    });
    expect(clearKeyRes.status).toBe(200);
    const clearKeyJson = await clearKeyRes.json() as { service: { hasApiKey: boolean; apiKeyMasked: string | null } };
    expect(clearKeyJson.service.hasApiKey).toBe(false);
    expect(clearKeyJson.service.apiKeyMasked).toBeNull();

    // Disable hides it from /api/voice/providers
    const disableRes = await fetch(`${baseUrl}/api/voice/server-asr-services/${createdJson.service.id}`, {
      method: 'PUT',
      headers: { Authorization: makeAuthHeader('admin-a'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disableRes.status).toBe(200);
    const afterDisable = await (await fetch(`${baseUrl}/api/voice/providers`, {
      headers: { Authorization: makeAuthHeader('user-b') },
    })).json() as { providers: unknown[] };
    expect(afterDisable.providers).toEqual([]);

    // env-default cannot be edited/deleted via API
    const envPut = await fetch(`${baseUrl}/api/voice/server-asr-services/${REMOTE_VOICE_ENV_ASR_DEVICE_ID}`, {
      method: 'PUT',
      headers: { Authorization: makeAuthHeader('admin-a'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hacked' }),
    });
    expect(envPut.status).toBe(400);

    // Delete removes service
    const delRes = await fetch(`${baseUrl}/api/voice/server-asr-services/${createdJson.service.id}`, {
      method: 'DELETE',
      headers: { Authorization: makeAuthHeader('admin-a') },
    });
    expect(delRes.status).toBe(200);
    expect(memDb.audits.some((a) => a.action === 'remote_voice.delete_server_asr_service')).toBe(true);

    // Missing BOT_ENCRYPTION_KEY returns 503 when saving a service with API key
    const noEncApp = buildApp({
      DB: db,
      JWT_SIGNING_KEY: JWT_SECRET,
      BOT_ENCRYPTION_KEY: '',
      SERVER_URL: 'http://127.0.0.1',
      NODE_ENV: 'development',
      PORT: 0,
      ASR_BASE_URL: 'https://asr-env.example/v1',
      ASR_API_KEY: 'env-secret-key-1234',
      ASR_MODEL: 'whisper-1',
      ASR_NAME: 'Env Whisper',
    });
    const noEncServer = serve({ fetch: noEncApp.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => noEncServer.once('listening', () => resolve()));
    try {
      const noEncAddr = noEncServer.address() as { port: number };
      const noEncUrl = `http://127.0.0.1:${noEncAddr.port}`;
      const res503 = await fetch(`${noEncUrl}/api/voice/server-asr-services`, {
        method: 'POST',
        headers: { Authorization: makeAuthHeader('admin-a'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'K', baseUrl: 'https://api.openai.com', apiKey: 'sk-abc', model: 'whisper-1' }),
      });
      expect(res503.status).toBe(503);
      expect(await res503.json()).toEqual({ error: 'encryption_not_configured' });

      // Env-configured service appears on /api/voice/providers and /server-asr-services
      const providersWithEnv = await (await fetch(`${noEncUrl}/api/voice/providers`, {
        headers: { Authorization: makeAuthHeader('user-b') },
      })).json() as { providers: Array<Record<string, unknown>> };
      expect(providersWithEnv.providers).toContainEqual({
        deviceId: REMOTE_VOICE_ENV_ASR_DEVICE_ID,
        displayName: 'Env Whisper',
        model: 'whisper-1',
        modelLabel: 'whisper-1',
        ready: true,
        busy: false,
        shareScope: 'server',
        providerKind: 'http_asr',
        isOwnDevice: false,
      });
      expect(JSON.stringify(providersWithEnv)).not.toContain('env-secret-key-1234');
      expect(JSON.stringify(providersWithEnv)).not.toContain('asr-env.example');
    } finally {
      await new Promise<void>((resolve) => noEncServer.close(() => resolve()));
    }
  });

  it('proxies HTTP ASR WS sessions concurrently with WAV upload, clears idle timer during upstream call, aborts cleanly, and sanitizes upstream errors', async () => {
    const fetchCalls: Array<{
      url: string;
      headers: Record<string, string>;
      redirect?: RequestRedirect;
      model: string | null;
      language: string | null;
      prompt: string | null;
      wavMagic: string;
      wavDataBytes: number;
      signal: AbortSignal;
    }> = [];

    let mode: 'slow-ok' | 'upstream-500' | 'hang-abort' = 'slow-ok';
    let abortObserved = false;

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const form = init?.body as FormData;
      const file = form.get('file') as File;
      const wavBuf = Buffer.from(await file.arrayBuffer());
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const signal = init!.signal!;
      fetchCalls.push({
        url: String(input),
        headers,
        redirect: init?.redirect,
        model: form.get('model') as string | null,
        language: form.get('language') as string | null,
        prompt: form.get('prompt') as string | null,
        wavMagic: wavBuf.subarray(0, 4).toString('ascii'),
        wavDataBytes: wavBuf.readUInt32LE(40),
        signal,
      });

      if (mode === 'upstream-500') {
        return new Response('SECRET_UPSTREAM_BODY https://secret-asr.internal sk-leaked', {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        });
      }
      if (mode === 'hang-abort') {
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            abortObserved = true;
            reject(new Error('aborted'));
          }, { once: true });
        });
      }
      // Deliberately slower than idleTimeoutMs (50ms) to prove idleTimer is cleared during transcription!
      await new Promise((r) => setTimeout(r, 90));
      return new Response(JSON.stringify({ text: 'Concurrent ASR OK' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const hub = new RemoteVoiceHub({
      readyTimeoutMs: 50,
      idleTimeoutMs: 50,
      httpAsrTimeoutMs: 500,
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    hub.setServerAsrServices([
      {
        id: 'asr_test1',
        name: 'Fast Whisper',
        baseUrl: 'https://secret-asr.internal/v1/',
        apiKey: 'sk-asr-secret-token',
        model: 'whisper-1',
        enabled: true,
        source: 'admin',
      },
    ], false);

    const sentA: Array<Record<string, unknown>> = [];
    const sentB: Array<Record<string, unknown>> = [];
    const wsA = { readyState: WebSocket.OPEN, send: (d: string) => sentA.push(JSON.parse(d)), on: () => {}, close: () => {} } as unknown as WebSocket;
    const wsB = { readyState: WebSocket.OPEN, send: (d: string) => sentB.push(JSON.parse(d)), on: () => {}, close: () => {} } as unknown as WebSocket;

    hub.handleConnection(wsA, 'u1');
    hub.handleConnection(wsB, 'u2');

    const proto = hub as unknown as {
      handleRawMessage: (ws: WebSocket, u: string, raw: string) => Promise<void>;
    };

    // Start two concurrent sessions for different users against same HTTP ASR provider
    await proto.handleRawMessage(wsA, 'u1', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'http-a',
      targetDeviceId: 'asr_test1',
      locale: 'zh-CN',
      sampleRate: 16_000,
    }));
    await proto.handleRawMessage(wsB, 'u2', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'http-b',
      targetDeviceId: 'asr_test1',
      locale: 'en-US',
      sampleRate: 16_000,
    }));
    expect(sentA[0]).toEqual({ type: 'voice.session.ready', sessionId: 'http-a' });
    expect(sentB[0]).toEqual({ type: 'voice.session.ready', sessionId: 'http-b' });

    const pcm = Buffer.alloc(640, 1).toString('base64');
    await proto.handleRawMessage(wsA, 'u1', JSON.stringify({ type: 'voice.session.audio', sessionId: 'http-a', pcmBase64: pcm }));
    await proto.handleRawMessage(wsB, 'u2', JSON.stringify({ type: 'voice.session.audio', sessionId: 'http-b', pcmBase64: pcm }));

    await Promise.all([
      proto.handleRawMessage(wsA, 'u1', JSON.stringify({ type: 'voice.session.stop', sessionId: 'http-a' })),
      proto.handleRawMessage(wsB, 'u2', JSON.stringify({ type: 'voice.session.stop', sessionId: 'http-b' })),
    ]);

    await new Promise((r) => setTimeout(r, 150));
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]!.url).toBe('https://secret-asr.internal/v1/audio/transcriptions');
    expect(fetchCalls[0]!.headers.Authorization).toBe('Bearer sk-asr-secret-token');
    expect(fetchCalls[0]!.redirect).toBe('error');
    expect(fetchCalls[0]!.wavMagic).toBe('RIFF');
    expect(fetchCalls[0]!.wavDataBytes).toBe(640);
    expect(fetchCalls[0]!.language).toBe('zh');
    expect(fetchCalls[1]!.language).toBe('en');
    expect(sentA).toContainEqual({ type: 'voice.session.result', sessionId: 'http-a', text: 'Concurrent ASR OK', isFinal: true });
    expect(sentA).toContainEqual({ type: 'voice.session.end', sessionId: 'http-a' });
    expect(sentB).toContainEqual({ type: 'voice.session.result', sessionId: 'http-b', text: 'Concurrent ASR OK', isFinal: true });
    expect(sentB).toContainEqual({ type: 'voice.session.end', sessionId: 'http-b' });
    expect(hub.getActiveSessionCount()).toBe(0);

    // Empty PCM buffer immediately emits voice.session.end without calling fetch
    const sentEmpty: Array<Record<string, unknown>> = [];
    const wsEmpty = { readyState: WebSocket.OPEN, send: (d: string) => sentEmpty.push(JSON.parse(d)), on: () => {}, close: () => {} } as unknown as WebSocket;
    hub.handleConnection(wsEmpty, 'u3');
    await proto.handleRawMessage(wsEmpty, 'u3', JSON.stringify({ type: 'voice.session.start', sessionId: 'http-empty', targetDeviceId: 'asr_test1', sampleRate: 16_000 }));
    await proto.handleRawMessage(wsEmpty, 'u3', JSON.stringify({ type: 'voice.session.stop', sessionId: 'http-empty' }));
    expect(sentEmpty).toContainEqual({ type: 'voice.session.end', sessionId: 'http-empty' });
    expect(fetchCalls).toHaveLength(2);

    // Upstream 500 error returns sanitized upstream_error with zero leaked body/URL/key
    mode = 'upstream-500';
    const sentErr: Array<Record<string, unknown>> = [];
    const wsErr = { readyState: WebSocket.OPEN, send: (d: string) => sentErr.push(JSON.parse(d)), on: () => {}, close: () => {} } as unknown as WebSocket;
    hub.handleConnection(wsErr, 'u4');
    await proto.handleRawMessage(wsErr, 'u4', JSON.stringify({ type: 'voice.session.start', sessionId: 'http-err', targetDeviceId: 'asr_test1', sampleRate: 16_000 }));
    await proto.handleRawMessage(wsErr, 'u4', JSON.stringify({ type: 'voice.session.audio', sessionId: 'http-err', pcmBase64: pcm }));
    await proto.handleRawMessage(wsErr, 'u4', JSON.stringify({ type: 'voice.session.stop', sessionId: 'http-err' }));
    await new Promise((r) => setTimeout(r, 30));
    const errFrame = sentErr.find((m) => m.type === 'voice.session.error')!;
    expect(errFrame?.code).toBe('upstream_error');
    const serializedErr = JSON.stringify(errFrame);
    expect(serializedErr).not.toContain('SECRET_UPSTREAM_BODY');
    expect(serializedErr).not.toContain('secret-asr.internal');
    expect(serializedErr).not.toContain('sk-asr-secret-token');

    // Aborting in-flight session or disabling service aborts AbortController cleanly
    mode = 'hang-abort';
    abortObserved = false;
    await proto.handleRawMessage(wsErr, 'u4', JSON.stringify({ type: 'voice.session.start', sessionId: 'http-abort', targetDeviceId: 'asr_test1', sampleRate: 16_000 }));
    await proto.handleRawMessage(wsErr, 'u4', JSON.stringify({ type: 'voice.session.audio', sessionId: 'http-abort', pcmBase64: pcm }));
    await proto.handleRawMessage(wsErr, 'u4', JSON.stringify({ type: 'voice.session.stop', sessionId: 'http-abort' }));
    await new Promise((r) => setTimeout(r, 15));
    await proto.handleRawMessage(wsErr, 'u4', JSON.stringify({ type: 'voice.session.abort', sessionId: 'http-abort' }));
    expect(abortObserved).toBe(true);
    expect(hub.getActiveSessionCount()).toBe(0);

    // Oversized PCM buffer (> 20 MiB) rejects cleanly
    await proto.handleRawMessage(wsErr, 'u4', JSON.stringify({ type: 'voice.session.start', sessionId: 'http-big', targetDeviceId: 'asr_test1', sampleRate: 16_000 }));
    const maxChunk = Buffer.alloc(REMOTE_VOICE_MAX_PCM_CHUNK_BYTES, 1).toString('base64');
    const chunksNeeded = Math.floor(REMOTE_VOICE_HTTP_ASR_MAX_AUDIO_BYTES / REMOTE_VOICE_MAX_PCM_CHUNK_BYTES) + 1;
    for (let i = 0; i < chunksNeeded; i++) {
      await proto.handleRawMessage(wsErr, 'u4', JSON.stringify({ type: 'voice.session.audio', sessionId: 'http-big', pcmBase64: maxChunk }));
    }
    expect(sentErr.some((m) => m.sessionId === 'http-big' && m.code === 'chunk_too_large')).toBe(true);
    expect(hub.getActiveSessionCount()).toBe(0);

    hub.stop();
  });

  it('sanitizes ASR repetition loops across pc_app and http_asr sessions and suppresses empty pure-hallucination partials', async () => {
    let upstreamText = '明天开会，' + '想，他'.repeat(6);
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ text: upstreamText }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const hub = new RemoteVoiceHub({
      readyTimeoutMs: 200,
      idleTimeoutMs: 500,
      httpAsrTimeoutMs: 500,
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    hub.setServerAsrServices([
      {
        id: 'asr_loop',
        name: 'Loop Whisper',
        baseUrl: 'https://asr.internal/v1/',
        model: 'whisper-1',
        enabled: true,
        source: 'admin',
      },
    ], false);

    const proto = hub as unknown as {
      handleRawMessage: (ws: WebSocket, u: string, raw: string) => Promise<void>;
    };

    // 1. pc_app provider partial/final sanitization + pure-hallucination partial suppression
    const providerSent: Array<Record<string, unknown>> = [];
    const clientSent: Array<Record<string, unknown>> = [];
    const providerWs = { readyState: WebSocket.OPEN, send: (d: string) => providerSent.push(JSON.parse(d)), on: () => {}, close: () => {} } as unknown as WebSocket;
    const clientWs = { readyState: WebSocket.OPEN, send: (d: string) => clientSent.push(JSON.parse(d)), on: () => {}, close: () => {} } as unknown as WebSocket;
    hub.handleConnection(providerWs, 'u-loop');
    hub.handleConnection(clientWs, 'u-loop');
    await proto.handleRawMessage(providerWs, 'u-loop', JSON.stringify({
      type: 'voice.provider.register',
      deviceId: 'mac-loop',
      model: 'qwen3-0.6b',
      modelLabel: 'Qwen3-ASR 0.6B',
      ready: true,
    }));
    await proto.handleRawMessage(clientWs, 'u-loop', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'pc-loop-1',
      targetDeviceId: 'mac-loop',
      sampleRate: 16_000,
    }));
    await proto.handleRawMessage(providerWs, 'u-loop', JSON.stringify({
      type: 'voice.session.ready',
      sessionId: 'pc-loop-1',
    }));

    // Pure hallucination and empty control-tag partials MUST NOT be forwarded to client
    await proto.handleRawMessage(providerWs, 'u-loop', JSON.stringify({
      type: 'voice.session.result',
      sessionId: 'pc-loop-1',
      text: '想，他'.repeat(60),
      isFinal: false,
    }));
    await proto.handleRawMessage(providerWs, 'u-loop', JSON.stringify({
      type: 'voice.session.result',
      sessionId: 'pc-loop-1',
      text: 'language None<asr_text>',
      isFinal: false,
    }));
    expect(clientSent.filter((f) => f.type === 'voice.session.result')).toHaveLength(0);

    // Normal text stays intact; control tag prefix is stripped; mixed trailing loop is truncated cleanly
    await proto.handleRawMessage(providerWs, 'u-loop', JSON.stringify({
      type: 'voice.session.result',
      sessionId: 'pc-loop-1',
      text: 'language Chinese<asr_text>哈哈哈哈',
      isFinal: false,
    }));
    await proto.handleRawMessage(providerWs, 'u-loop', JSON.stringify({
      type: 'voice.session.result',
      sessionId: 'pc-loop-1',
      text: '明天开会讨论方案，' + '想，他'.repeat(6),
      isFinal: true,
    }));
    await proto.handleRawMessage(providerWs, 'u-loop', JSON.stringify({
      type: 'voice.session.end',
      sessionId: 'pc-loop-1',
    }));

    const pcResults = clientSent.filter((f) => f.type === 'voice.session.result');
    expect(pcResults).toEqual([
      { type: 'voice.session.result', sessionId: 'pc-loop-1', text: '哈哈哈哈', isFinal: false },
      { type: 'voice.session.result', sessionId: 'pc-loop-1', text: '明天开会讨论方案，', isFinal: true },
    ]);

    // 2. http_asr transcript sanitization (mixed loop -> trimmed; pure hallucination -> omitted)
    const pcm = Buffer.alloc(320, 1).toString('base64');
    const httpSentA: Array<Record<string, unknown>> = [];
    const httpWsA = { readyState: WebSocket.OPEN, send: (d: string) => httpSentA.push(JSON.parse(d)), on: () => {}, close: () => {} } as unknown as WebSocket;
    hub.handleConnection(httpWsA, 'u-http-1');
    await proto.handleRawMessage(httpWsA, 'u-http-1', JSON.stringify({ type: 'voice.session.start', sessionId: 'http-loop-1', targetDeviceId: 'asr_loop', sampleRate: 16_000 }));
    await proto.handleRawMessage(httpWsA, 'u-http-1', JSON.stringify({ type: 'voice.session.audio', sessionId: 'http-loop-1', pcmBase64: pcm }));
    await proto.handleRawMessage(httpWsA, 'u-http-1', JSON.stringify({ type: 'voice.session.stop', sessionId: 'http-loop-1' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(httpSentA).toContainEqual({ type: 'voice.session.result', sessionId: 'http-loop-1', text: '明天开会，', isFinal: true });

    upstreamText = '想，他'.repeat(60);
    const httpSentB: Array<Record<string, unknown>> = [];
    const httpWsB = { readyState: WebSocket.OPEN, send: (d: string) => httpSentB.push(JSON.parse(d)), on: () => {}, close: () => {} } as unknown as WebSocket;
    hub.handleConnection(httpWsB, 'u-http-2');
    await proto.handleRawMessage(httpWsB, 'u-http-2', JSON.stringify({ type: 'voice.session.start', sessionId: 'http-loop-2', targetDeviceId: 'asr_loop', sampleRate: 16_000 }));
    await proto.handleRawMessage(httpWsB, 'u-http-2', JSON.stringify({ type: 'voice.session.audio', sessionId: 'http-loop-2', pcmBase64: pcm }));
    await proto.handleRawMessage(httpWsB, 'u-http-2', JSON.stringify({ type: 'voice.session.stop', sessionId: 'http-loop-2' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(httpSentB.some((f) => f.type === 'voice.session.result')).toBe(false);

    // 3. Legacy helper tag-only final preserves prior non-empty partial and new sessions start clean
    const tagSent: Array<Record<string, unknown>> = [];
    const tagClientWs = { readyState: WebSocket.OPEN, send: (d: string) => tagSent.push(JSON.parse(d)), on: () => {}, close: () => {} } as unknown as WebSocket;
    hub.handleConnection(tagClientWs, 'u-loop');
    await proto.handleRawMessage(tagClientWs, 'u-loop', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'pc-tag-final-1',
      targetDeviceId: 'mac-loop',
      sampleRate: 16_000,
    }));
    await proto.handleRawMessage(providerWs, 'u-loop', JSON.stringify({
      type: 'voice.session.ready',
      sessionId: 'pc-tag-final-1',
    }));
    await proto.handleRawMessage(providerWs, 'u-loop', JSON.stringify({
      type: 'voice.session.result',
      sessionId: 'pc-tag-final-1',
      text: '第一段',
      isFinal: false,
    }));
    await proto.handleRawMessage(providerWs, 'u-loop', JSON.stringify({
      type: 'voice.session.result',
      sessionId: 'pc-tag-final-1',
      text: 'language None<asr_text>',
      isFinal: true,
    }));
    await proto.handleRawMessage(providerWs, 'u-loop', JSON.stringify({
      type: 'voice.session.end',
      sessionId: 'pc-tag-final-1',
    }));
    const tagFinals = tagSent.filter((f) => f.type === 'voice.session.result' && f.isFinal === true);
    expect(tagFinals).toEqual([
      { type: 'voice.session.result', sessionId: 'pc-tag-final-1', text: '第一段', isFinal: true },
    ]);

    // Subsequent new session with only a tag-only final does NOT borrow prior session text
    const freshSent: Array<Record<string, unknown>> = [];
    const freshClientWs = { readyState: WebSocket.OPEN, send: (d: string) => freshSent.push(JSON.parse(d)), on: () => {}, close: () => {} } as unknown as WebSocket;
    hub.handleConnection(freshClientWs, 'u-loop');
    await proto.handleRawMessage(freshClientWs, 'u-loop', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'pc-tag-final-2',
      targetDeviceId: 'mac-loop',
      sampleRate: 16_000,
    }));
    await proto.handleRawMessage(providerWs, 'u-loop', JSON.stringify({
      type: 'voice.session.ready',
      sessionId: 'pc-tag-final-2',
    }));
    await proto.handleRawMessage(providerWs, 'u-loop', JSON.stringify({
      type: 'voice.session.result',
      sessionId: 'pc-tag-final-2',
      text: 'language\nNone<asr_text>',
      isFinal: true,
    }));
    await proto.handleRawMessage(providerWs, 'u-loop', JSON.stringify({
      type: 'voice.session.end',
      sessionId: 'pc-tag-final-2',
    }));
    expect(freshSent.filter((f) => f.type === 'voice.session.result')).toEqual([
      { type: 'voice.session.result', sessionId: 'pc-tag-final-2', text: '', isFinal: true },
    ]);
    expect(httpSentB).toContainEqual({ type: 'voice.session.end', sessionId: 'http-loop-2' });

    hub.stop();
  });

  it('allows active non-admin users to share own PC device server-wide with atomic FOR UPDATE writes, immediate revocation, and status/admin-ASR isolation', async () => {
    memDb.seedUser({ id: 'user-c', username: 'charlie', displayName: 'Charlie', isAdmin: false, status: 'active' });
    memDb.seedUser({ id: 'user-pending', username: 'pend', displayName: 'Pending', isAdmin: false, status: 'pending' });
    memDb.seedUser({ id: 'user-disabled', username: 'dis', displayName: 'Disabled', isAdmin: false, status: 'disabled' });

    const providerA = await openVoiceWs(baseUrl, baseUrl, await issueWsTicket('admin-a'));
    const providerB = await openVoiceWs(baseUrl, baseUrl, await issueWsTicket('user-b'));
    const providerC = await openVoiceWs(baseUrl, baseUrl, await issueWsTicket('user-c'));
    openSockets.push(providerA.ws, providerB.ws, providerC.ws);

    providerA.ws.send(JSON.stringify({
      type: 'voice.provider.register',
      deviceId: 'admin-pc',
      model: 'qwen3-1.7b',
      modelLabel: 'Qwen3-ASR 1.7B',
      ready: true,
    }));
    providerB.ws.send(JSON.stringify({
      type: 'voice.provider.register',
      deviceId: 'userb-pc',
      model: 'qwen3-0.6b',
      modelLabel: 'Qwen3-ASR 0.6B',
      ready: true,
    }));
    providerC.ws.send(JSON.stringify({
      type: 'voice.provider.register',
      deviceId: 'userc-pc',
      model: 'qwen3-0.6b',
      modelLabel: 'Qwen3-ASR 0.6B',
      ready: true,
    }));
    await Promise.all([
      providerA.inbox.next((f) => f.type === 'voice.providers.updated' && (f.providers as unknown[]).length > 0),
      providerB.inbox.next((f) => f.type === 'voice.providers.updated' && (f.providers as unknown[]).length > 0),
      providerC.inbox.next((f) => f.type === 'voice.providers.updated' && (f.providers as unknown[]).length > 0),
    ]);

    // Pending & disabled accounts are rejected with specific denial codes
    for (const [uid, expectedCode] of [['user-pending', 'account_pending'], ['user-disabled', 'account_disabled']] as const) {
      const deniedToggle = await fetch(`${baseUrl}/api/voice/server-shared-providers`, {
        method: 'PUT',
        headers: { Authorization: makeAuthHeader(uid), 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'any-pc', shared: true }),
      });
      expect(deniedToggle.status).toBe(403);
      expect(await deniedToggle.json()).toEqual({ error: expectedCode });

      const deniedSnapRes = await fetch(`${baseUrl}/api/voice/providers`, {
        headers: { Authorization: makeAuthHeader(uid) },
      });
      expect(deniedSnapRes.status).toBe(403);
      expect(await deniedSnapRes.json()).toEqual({ error: expectedCode });
    }

    // Concurrent server-shared-providers toggles from two non-admins (starting from empty settings row) preserve BOTH entries
    memDb.queryLog.length = 0;
    const [resB, resC] = await Promise.all([
      fetch(`${baseUrl}/api/voice/server-shared-providers`, {
        method: 'PUT',
        headers: { Authorization: makeAuthHeader('user-b'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'userb-pc', shared: true, nickname: 'Bob Mac' }),
      }),
      fetch(`${baseUrl}/api/voice/server-shared-providers`, {
        method: 'PUT',
        headers: { Authorization: makeAuthHeader('user-c'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'userc-pc', shared: true, nickname: 'Charlie Mac' }),
      }),
    ]);
    expect(resB.status).toBe(200);
    expect(resC.status).toBe(200);
    expect(memDb.queryLog.some((q) => q.includes('for update'))).toBe(true);
    const storedAfterConcurrent = JSON.parse(memDb.settings.get(REMOTE_VOICE_SERVER_SHARED_SETTING_KEY)!) as Array<{
      ownerUserId: string; deviceId: string; nickname?: string;
    }>;
    expect(storedAfterConcurrent).toEqual(expect.arrayContaining([
      { ownerUserId: 'user-b', deviceId: 'userb-pc', nickname: 'Bob Mac' },
      { ownerUserId: 'user-c', deviceId: 'userc-pc', nickname: 'Charlie Mac' },
    ]));
    expect(storedAfterConcurrent).toHaveLength(2);

    // Non-admin user-b cannot touch user-c's online device or open admin ASR routes
    const stealAttempt = await fetch(`${baseUrl}/api/voice/server-shared-providers`, {
      method: 'PUT',
      headers: { Authorization: makeAuthHeader('user-b'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'userc-pc', shared: true }),
    });
    expect(stealAttempt.status).toBe(403);
    const nonAdminAsrList = await fetch(`${baseUrl}/api/voice/server-asr-services`, {
      headers: { Authorization: makeAuthHeader('user-b') },
    });
    expect(nonAdminAsrList.status).toBe(403);

    // Admin A sees non-admin shared providers with zero sensitive leaks and can run a live session against userb-pc
    const adminProvidersRes = await (await fetch(`${baseUrl}/api/voice/providers`, {
      headers: { Authorization: makeAuthHeader('admin-a') },
    })).json() as {
      canManageServerSharing: boolean;
      canShareOwnProviderToServer: boolean;
      providers: Array<Record<string, unknown>>;
    };
    expect(adminProvidersRes.canManageServerSharing).toBe(true);
    expect(adminProvidersRes.canShareOwnProviderToServer).toBe(true);
    const sharedBForAdmin = adminProvidersRes.providers.find((p) => p.deviceId === 'userb-pc');
    expect(sharedBForAdmin).toEqual({
      deviceId: 'userb-pc',
      displayName: 'Bob Mac',
      model: 'qwen3-0.6b',
      modelLabel: 'Qwen3-ASR 0.6B',
      ready: true,
      busy: false,
      shareScope: 'server',
      isOwnDevice: false,
    });
    expect(JSON.stringify(sharedBForAdmin)).not.toContain('user-b');
    expect(JSON.stringify(sharedBForAdmin)).not.toContain('bob');

    // Nickname update on userb-pc syncs server-shared entry without dropping user-c's entry
    const nickSyncRes = await fetch(`${baseUrl}/api/voice/provider-nickname`, {
      method: 'PUT',
      headers: { Authorization: makeAuthHeader('user-b'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'userb-pc', nickname: 'Bob Studio' }),
    });
    expect(nickSyncRes.status).toBe(200);
    expect(JSON.parse(memDb.settings.get(REMOTE_VOICE_SERVER_SHARED_SETTING_KEY)!)).toEqual(expect.arrayContaining([
      { ownerUserId: 'user-c', deviceId: 'userc-pc', nickname: 'Charlie Mac' },
      { ownerUserId: 'user-b', deviceId: 'userb-pc', nickname: 'Bob Studio' },
    ]));

    // Start live session from admin-a -> userb-pc, then user-b turns sharing off -> immediate abort + revocation
    const clientA = await openVoiceWs(baseUrl, baseUrl, await issueWsTicket('admin-a'));
    openSockets.push(clientA.ws);
    clientA.ws.send(JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'nonadmin-shared-1',
      targetDeviceId: 'userb-pc',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
    }));
    await providerB.inbox.next((f) => f.type === 'voice.session.start' && f.sessionId === 'nonadmin-shared-1');
    providerB.ws.send(JSON.stringify({ type: 'voice.session.ready', sessionId: 'nonadmin-shared-1' }));
    await clientA.inbox.next((f) => f.type === 'voice.session.ready' && f.sessionId === 'nonadmin-shared-1');

    const disableB = await fetch(`${baseUrl}/api/voice/server-shared-providers`, {
      method: 'PUT',
      headers: { Authorization: makeAuthHeader('user-b'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'userb-pc', shared: false }),
    });
    expect(disableB.status).toBe(200);
    await providerB.inbox.next((f) => f.type === 'voice.session.abort' && f.sessionId === 'nonadmin-shared-1');
    const revokedA = await clientA.inbox.next((f) => f.type === 'voice.session.error' && f.sessionId === 'nonadmin-shared-1');
    expect(revokedA).toMatchObject({ sessionId: 'nonadmin-shared-1', code: 'provider_offline' });
    expect(JSON.parse(memDb.settings.get(REMOTE_VOICE_SERVER_SHARED_SETTING_KEY)!)).toEqual([
      { ownerUserId: 'user-c', deviceId: 'userc-pc', nickname: 'Charlie Mac' },
    ]);
  });

  it('evicts stale/half-open providers including frozen-JS transport-pong sockets while keeping active legacy 0.1.9 providers online', async () => {
    vi.useFakeTimers();
    const hub = new RemoteVoiceHub({
      providerLivenessIntervalMs: 25,
      providerStaleTimeoutMs: 70,
    });
    try {
      const sentToClient: string[] = [];
      const clientWs = {
        readyState: WebSocket.OPEN,
        send: (d: string) => sentToClient.push(d),
        on: () => {},
        close: () => {},
      } as unknown as WebSocket;
      hub.handleConnection(clientWs, 'u-live');

      const proto = hub as unknown as {
        handleRawMessage: (ws: WebSocket, u: string, raw: string) => Promise<void>;
      };

      // A) Mock socket omitting .ping/.terminate/.on('pong') goes silent past providerStaleTimeoutMs -> evicted + closed
      let legacyClosed = false;
      const bareProviderWs = {
        readyState: WebSocket.OPEN,
        send: () => {},
        on: () => {},
        close: () => { legacyClosed = true; },
      } as unknown as WebSocket;
      hub.handleConnection(bareProviderWs, 'u-live');
      await proto.handleRawMessage(bareProviderWs, 'u-live', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: 'dev-bare-stale',
        model: 'qwen3-1.7b',
        modelLabel: 'Qwen3-ASR 1.7B',
        ready: true,
      }));
      expect(hub.listProviders('u-live').map((p) => p.deviceId)).toEqual(['dev-bare-stale']);

      await vi.advanceTimersByTimeAsync(90);
      expect(legacyClosed).toBe(true);
      expect(hub.listProviders('u-live')).toEqual([]);
      expect(sentToClient.some((raw) => {
        const f = JSON.parse(raw) as { type?: string; providers?: unknown[] };
        return f.type === 'voice.providers.updated' && Array.isArray(f.providers) && f.providers.length === 0;
      })).toBe(true);

      // B) Frozen Electron renderer: transport control-frame 'pong' still arrives, ZERO app JSON frames -> evicted after providerStaleTimeoutMs
      const pongListeners: Array<() => void> = [];
      let terminated = false;
      const frozenProviderWs = {
        readyState: WebSocket.OPEN,
        send: () => {},
        ping: () => {
          for (const cb of pongListeners) cb();
        },
        terminate: () => { terminated = true; },
        close: () => {},
        on: (ev: string, cb: () => void) => {
          if (ev === 'pong') pongListeners.push(cb);
        },
      } as unknown as WebSocket;
      hub.handleConnection(frozenProviderWs, 'u-live');
      await proto.handleRawMessage(frozenProviderWs, 'u-live', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: 'dev-frozen-js',
        model: 'qwen3-1.7b',
        modelLabel: 'Qwen3-ASR 1.7B',
        ready: true,
      }));
      expect(hub.listProviders('u-live').map((p) => p.deviceId)).toEqual(['dev-frozen-js']);

      await vi.advanceTimersByTimeAsync(90);
      expect(terminated).toBe(true);
      expect(hub.listProviders('u-live')).toEqual([]);

      // C) Healthy legacy 0.1.9 client sending JSON { type: 'ping' } every 30ms stays online past 120ms without voice.provider.pong
      const sentToHealthy: string[] = [];
      const healthyLegacyWs = {
        readyState: WebSocket.OPEN,
        send: (d: string) => sentToHealthy.push(d),
        on: () => {},
        close: () => { throw new Error('must not close active legacy provider'); },
      } as unknown as WebSocket;
      hub.handleConnection(healthyLegacyWs, 'u-live');
      await proto.handleRawMessage(healthyLegacyWs, 'u-live', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: 'dev-legacy-019',
        model: 'qwen3-1.7b',
        modelLabel: 'Qwen3-ASR 1.7B',
        ready: true,
      }));
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(30);
        await proto.handleRawMessage(healthyLegacyWs, 'u-live', JSON.stringify({ type: 'ping' }));
      }
      expect(hub.listProviders('u-live').map((p) => p.deviceId)).toEqual(['dev-legacy-019']);
      expect(sentToHealthy.some((raw) => JSON.parse(raw).type === 'pong')).toBe(true);

      // D) Same WebSocket re-registering a new deviceId when it was the account's sole provider keeps the new entry live & swept
      proto.teardownSocket(healthyLegacyWs, 'u-live', 'provider_offline');
      expect(hub.listProviders('u-live')).toEqual([]);
      let rekeyClosed = false;
      const rekeyWs = {
        readyState: WebSocket.OPEN,
        send: () => {},
        on: () => {},
        terminate: () => { rekeyClosed = true; },
        close: () => { rekeyClosed = true; },
      } as unknown as WebSocket;
      hub.handleConnection(rekeyWs, 'u-live');
      await proto.handleRawMessage(rekeyWs, 'u-live', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: 'desktop-a',
        model: 'qwen3-1.7b',
        modelLabel: 'Qwen3-ASR 1.7B',
        ready: true,
      }));
      expect(hub.listProviders('u-live').map((p) => p.deviceId)).toEqual(['desktop-a']);

      await proto.handleRawMessage(rekeyWs, 'u-live', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: 'desktop-b',
        model: 'qwen3-1.7b',
        modelLabel: 'Qwen3-ASR 1.7B',
        ready: true,
      }));
      expect(hub.listProviders('u-live').map((p) => p.deviceId)).toEqual(['desktop-b']);

      // Subsequent activity keeps desktop-b online past 75ms stale window
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(30);
        await proto.handleRawMessage(rekeyWs, 'u-live', JSON.stringify({ type: 'ping' }));
      }
      expect(rekeyClosed).toBe(false);
      expect(hub.listProviders('u-live').map((p) => p.deviceId)).toEqual(['desktop-b']);

      // Stopping activity evicts desktop-b on sweep and stops the idle liveness timer cleanly
      await vi.advanceTimersByTimeAsync(90);
      expect(rekeyClosed).toBe(true);
      expect(hub.listProviders('u-live')).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      hub.stop();
      vi.useRealTimers();
    }
  });

  it('probes and evicts zombie providers on readyTimer timeout AND on early client abort/close before ready, without harming replaced sockets', async () => {
    vi.useFakeTimers();
    const hub = new RemoteVoiceHub({
      readyTimeoutMs: 200,
      readyProbeGraceMs: 40,
      providerLivenessIntervalMs: 5_000,
      providerStaleTimeoutMs: 10_000,
      idleTimeoutMs: 5_000,
    });
    try {
      const proto = hub as unknown as {
        handleRawMessage: (ws: WebSocket, u: string, raw: string) => Promise<void>;
        teardownSocket: (ws: WebSocket, u: string, code: string) => void;
      };

      const makeFakeProvider = (autoAppPong: boolean) => {
        const sent: string[] = [];
        const pongListeners: Array<() => void> = [];
        let terminated = false;
        let closed = false;
        const ws = {
          readyState: WebSocket.OPEN,
          send: (d: string) => {
            sent.push(d);
            if (autoAppPong && JSON.parse(d).type === 'voice.provider.ping') {
              void proto.handleRawMessage(ws, 'u-probe', JSON.stringify({ type: 'voice.provider.pong' }));
            }
          },
          ping: () => {
            for (const cb of pongListeners) cb();
          },
          terminate: () => { terminated = true; },
          close: () => { closed = true; },
          on: (ev: string, cb: () => void) => {
            if (ev === 'pong') pongListeners.push(cb);
          },
        } as unknown as WebSocket;
        return { ws, sent, isGone: () => terminated || closed };
      };

      const clientWs1 = { readyState: WebSocket.OPEN, send: () => {}, on: () => {}, close: () => {} } as unknown as WebSocket;
      hub.handleConnection(clientWs1, 'u-probe');

      // 1) New provider freezes after registering (supportsAppProbe=true, still replies transport pong, stops replying voice.provider.pong).
      // Client aborts at 15ms (BEFORE hub's 200ms readyTimeoutMs!) -> hub arms 40ms probe and evicts zombie in ~40ms!
      const pZombie = makeFakeProvider(false);
      hub.handleConnection(pZombie.ws, 'u-probe');
      await proto.handleRawMessage(pZombie.ws, 'u-probe', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: 'dev-zombie',
        model: 'qwen3-1.7b',
        modelLabel: 'Qwen3-ASR 1.7B',
        ready: true,
      }));
      await proto.handleRawMessage(pZombie.ws, 'u-probe', JSON.stringify({ type: 'voice.provider.pong' }));

      await proto.handleRawMessage(clientWs1, 'u-probe', JSON.stringify({
        type: 'voice.session.start',
        sessionId: 's-early-abort',
        targetDeviceId: 'dev-zombie',
        sampleRate: REMOTE_VOICE_SAMPLE_RATE,
      }));
      await vi.advanceTimersByTimeAsync(15);
      await proto.handleRawMessage(clientWs1, 'u-probe', JSON.stringify({
        type: 'voice.session.abort',
        sessionId: 's-early-abort',
      }));
      expect(pZombie.sent.some((d) => JSON.parse(d).type === 'voice.provider.ping')).toBe(true);
      await vi.advanceTimersByTimeAsync(50);
      expect(pZombie.isGone()).toBe(true);
      expect(hub.listProviders('u-probe')).toEqual([]);

      // 2) Responsive provider suffers client disconnect before ready (teardownSocket) -> responds to probe -> stays online!
      const clientWs2 = { readyState: WebSocket.OPEN, send: () => {}, on: () => {}, close: () => {} } as unknown as WebSocket;
      hub.handleConnection(clientWs2, 'u-probe');
      const pHealthy = makeFakeProvider(true);
      hub.handleConnection(pHealthy.ws, 'u-probe');
      await proto.handleRawMessage(pHealthy.ws, 'u-probe', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: 'dev-healthy',
        model: 'qwen3-1.7b',
        modelLabel: 'Qwen3-ASR 1.7B',
        ready: true,
      }));
      await proto.handleRawMessage(clientWs2, 'u-probe', JSON.stringify({
        type: 'voice.session.start',
        sessionId: 's-client-drop',
        targetDeviceId: 'dev-healthy',
        sampleRate: REMOTE_VOICE_SAMPLE_RATE,
      }));
      proto.teardownSocket(clientWs2, 'u-probe', 'provider_offline');
      await vi.advanceTimersByTimeAsync(60);
      expect(pHealthy.isGone()).toBe(false);
      expect(hub.listProviders('u-probe').map((p) => p.deviceId)).toEqual(['dev-healthy']);

      // 3) Replaced socket protection: old ws1 gets probe armed, then ws2 replaces dev-replace -> old probe must NOT evict ws2
      const pOld = makeFakeProvider(false);
      hub.handleConnection(pOld.ws, 'u-probe');
      await proto.handleRawMessage(pOld.ws, 'u-probe', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: 'dev-replace',
        model: 'qwen3-1.7b',
        modelLabel: 'Qwen3-ASR 1.7B',
        ready: true,
      }));
      await proto.handleRawMessage(clientWs1, 'u-probe', JSON.stringify({
        type: 'voice.session.start',
        sessionId: 's-replace',
        targetDeviceId: 'dev-replace',
        sampleRate: REMOTE_VOICE_SAMPLE_RATE,
      }));
      await vi.advanceTimersByTimeAsync(210); // readyTimer fires and arms 40ms probe on pOld.ws
      const pNew = makeFakeProvider(true);
      hub.handleConnection(pNew.ws, 'u-probe');
      await proto.handleRawMessage(pNew.ws, 'u-probe', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: 'dev-replace',
        model: 'qwen3-1.7b',
        modelLabel: 'Qwen3-ASR 1.7B',
        ready: true,
      }));
      await vi.advanceTimersByTimeAsync(60);
      expect(pNew.isGone()).toBe(false);
      expect(hub.listProviders('u-probe').map((p) => p.deviceId)).toContain('dev-replace');
    } finally {
      hub.stop();
      vi.useRealTimers();
    }
  });

  it('includes sanitized machine deviceName in own-device defaults, disambiguates colliding own devices without leaking cross-account, and stays backward-compatible', async () => {
    // 1. formatDefaultRemoteVoiceNickname and parseRemoteVoiceInboundFrame deviceName sanitization
    expect(formatDefaultRemoteVoiceNickname('K', 'Qwen3-ASR 1.7B', 'KOCA’s MacBook Pro (1118)')).toBe(
      'KOCA’s MacBook Pro (1118) · Qwen3-ASR 1.7B',
    );
    expect(formatDefaultRemoteVoiceNickname('K', 'Qwen3-ASR 1.7B', 'localhost.local')).toBe('K · Qwen3-ASR 1.7B');
    expect(formatDefaultRemoteVoiceNickname('K', 'Qwen3-ASR 1.7B')).toBe('K · Qwen3-ASR 1.7B');

    const parsedValid = parseRemoteVoiceInboundFrame(JSON.stringify({
      type: 'voice.provider.register',
      deviceId: 'dev-1',
      deviceName: '  DESKTOP-TVO1KU1.local\n',
      hostname: 'DESKTOP-TVO1KU1.lan',
      localServerId: 'srv-m3-daemon',
      model: 'qwen3-1.7b',
      modelLabel: 'Qwen3-ASR 1.7B',
      ready: true,
    }));
    expect(parsedValid).toEqual({
      ok: true,
      frame: {
        type: 'voice.provider.register',
        deviceId: 'dev-1',
        deviceName: 'DESKTOP-TVO1KU1',
        hostname: 'DESKTOP-TVO1KU1',
        localServerId: 'srv-m3-daemon',
        model: 'qwen3-1.7b',
        modelLabel: 'Qwen3-ASR 1.7B',
        ready: true,
      },
    });

    const parsedIgnored = parseRemoteVoiceInboundFrame(JSON.stringify({
      type: 'voice.provider.register',
      deviceId: 'dev-2',
      deviceName: 12345,
      hostname: 'localhost.localdomain',
      localServerId: 'bad server id with spaces',
      model: 'qwen3-0.6b',
      modelLabel: 'Qwen3-ASR 0.6B',
      ready: true,
    }));
    expect(parsedIgnored).toEqual({
      ok: true,
      frame: {
        type: 'voice.provider.register',
        deviceId: 'dev-2',
        model: 'qwen3-0.6b',
        modelLabel: 'Qwen3-ASR 0.6B',
        ready: true,
      },
    });

    // 2. RemoteVoiceHub DB machine-name linkage via servers table, privacy isolation, customNickname override, and collision disambiguation
    const db = new MemoryVoiceTestDb();
    db.seedUser({ id: 'owner-db', username: 'k_owner', displayName: 'K' });
    db.seedUser({ id: 'other-db', username: 'other_u', displayName: 'Other' });
    // Host daemon + linked controlled node m3 (mac)
    db.servers.set('srv-m3-host', {
      id: 'srv-m3-host',
      user_id: 'owner-db',
      name: 'm3',
      display_name: null,
      ref_name: null,
      host_server_id: null,
      token_hash: 'h1',
      node_role: 'daemon',
      revoked_at: null,
      created_at: 100,
    });
    db.servers.set('srv-m3-ctrl', {
      id: 'srv-m3-ctrl',
      user_id: 'owner-db',
      name: 'm3 (mac)',
      display_name: 'm3 (mac)',
      ref_name: 'KOCAs-MacBook-Pro',
      host_server_id: 'srv-m3-host',
      token_hash: 'h2',
      node_role: 'controlled',
      revoked_at: null,
      created_at: 101,
    });
    // Controlled-node-only Windows machine matching production enroll.ts shape: ref_name=NULL, name=deriveDisplayName(hostname, os), display_name=renamed
    db.servers.set('srv-win-ctrl', {
      id: 'srv-win-ctrl',
      user_id: 'owner-db',
      name: 'DESKTOP-TVO1KU1 (windows)',
      display_name: '(win) 楼下',
      ref_name: null,
      host_server_id: null,
      token_hash: 'h3',
      node_role: 'controlled',
      os: 'windows',
      revoked_at: null,
      created_at: 102,
    });
    // Ambiguous enroll.ts rows (2 active controlled rows matching deriveDisplayName('DUP-WIN', 'windows')) -> must fall back to OS deviceName
    db.servers.set('srv-dup-win-1', {
      id: 'srv-dup-win-1',
      user_id: 'owner-db',
      name: 'DUP-WIN (windows)',
      display_name: '(win) 客厅',
      ref_name: null,
      host_server_id: null,
      token_hash: 'h3b',
      node_role: 'controlled',
      os: 'windows',
      revoked_at: null,
      created_at: 102,
    });
    db.servers.set('srv-dup-win-2', {
      id: 'srv-dup-win-2',
      user_id: 'owner-db',
      name: 'DUP-WIN (windows)',
      display_name: '(win) 书房',
      ref_name: null,
      host_server_id: null,
      token_hash: 'h3c',
      node_role: 'controlled',
      os: 'windows',
      revoked_at: null,
      created_at: 102,
    });
    // Revoked row must NEVER be matched
    db.servers.set('srv-revoked', {
      id: 'srv-revoked',
      user_id: 'owner-db',
      name: 'Should Never Match',
      display_name: 'Revoked Machine',
      ref_name: 'UNBOUND-PC',
      host_server_id: null,
      token_hash: 'h4',
      node_role: 'controlled',
      revoked_at: 999999,
      created_at: 103,
    });
    // Ambiguous hostname rows (2 distinct machines with same ref_name prefix) -> falls back cleanly to OS deviceName
    db.servers.set('srv-ambig-1', {
      id: 'srv-ambig-1',
      user_id: 'owner-db',
      name: 'Lab 1',
      display_name: 'Lab A',
      ref_name: 'SHARED-HOST',
      host_server_id: null,
      token_hash: 'h5',
      node_role: 'controlled',
      revoked_at: null,
      created_at: 104,
    });
    db.servers.set('srv-ambig-2', {
      id: 'srv-ambig-2',
      user_id: 'owner-db',
      name: 'Lab 2',
      display_name: 'Lab B',
      ref_name: 'SHARED-HOST-deadbeef',
      host_server_id: null,
      token_hash: 'h6',
      node_role: 'controlled',
      revoked_at: null,
      created_at: 105,
    });

    const hub = new RemoteVoiceHub();
    try {
      const proto = hub as unknown as {
        handleRawMessage: (ws: WebSocket, u: string, raw: string) => Promise<void>;
        setOwnerMeta?: (u: string, d: string | null, n: Record<string, string>, un?: string | null) => void;
      };
      const makeWs = () => ({
        readyState: WebSocket.OPEN,
        send: () => {},
        on: () => {},
        close: () => {},
      } as unknown as WebSocket);

      const macWs = makeWs();
      const winWs = makeWs();
      const dupWinWs = makeWs();
      const unboundWs = makeWs();
      const ambigWs = makeWs();
      hub.handleConnection(macWs, 'owner-db');
      hub.handleConnection(winWs, 'owner-db');
      hub.handleConnection(dupWinWs, 'owner-db');
      hub.handleConnection(unboundWs, 'owner-db');
      hub.handleConnection(ambigWs, 'owner-db');

      await proto.handleRawMessage(macWs, 'owner-db', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: '550e8400-e29b-41d4-a716-446655440001',
        deviceName: 'KOCA’s MacBook Pro (1118)',
        localServerId: 'srv-m3-host',
        model: 'qwen3-1.7b',
        modelLabel: 'Qwen3-ASR 1.7B',
        ready: true,
      }));
      await proto.handleRawMessage(winWs, 'owner-db', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: '660e8400-e29b-41d4-a716-446655440002',
        deviceName: 'DESKTOP-TVO1KU1',
        hostname: 'DESKTOP-TVO1KU1',
        model: 'qwen3-0.6b',
        modelLabel: 'Qwen3-ASR 0.6B',
        ready: true,
      }));
      await proto.handleRawMessage(dupWinWs, 'owner-db', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: '660e8400-e29b-41d4-a716-446655440099',
        deviceName: 'DUP-WIN-OS',
        hostname: 'DUP-WIN',
        model: 'qwen3-0.6b',
        modelLabel: 'Qwen3-ASR 0.6B',
        ready: true,
      }));
      await proto.handleRawMessage(unboundWs, 'owner-db', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: '770e8400-e29b-41d4-a716-446655440003',
        deviceName: 'Unbound Studio PC',
        hostname: 'UNBOUND-PC',
        model: 'qwen3-0.6b',
        modelLabel: 'Qwen3-ASR 0.6B',
        ready: true,
      }));
      await proto.handleRawMessage(ambigWs, 'owner-db', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: '880e8400-e29b-41d4-a716-446655440004',
        deviceName: 'Shared Fallback OS',
        hostname: 'SHARED-HOST',
        model: 'qwen3-0.6b',
        modelLabel: 'Qwen3-ASR 0.6B',
        ready: true,
      }));

      db.settings.set(
        REMOTE_VOICE_SERVER_SHARED_SETTING_KEY,
        JSON.stringify([{ ownerUserId: 'owner-db', deviceId: '550e8400-e29b-41d4-a716-446655440001' }]),
      );

      const ownerList = await hub.listProvidersHydrated(db.asDatabase(), 'owner-db');
      expect(ownerList.map((p) => p.displayName)).toEqual([
        'm3 (mac) · Qwen3-ASR 1.7B',
        '(win) 楼下 · Qwen3-ASR 0.6B',
        'DUP-WIN-OS · Qwen3-ASR 0.6B',
        'Unbound Studio PC · Qwen3-ASR 0.6B',
        'Shared Fallback OS · Qwen3-ASR 0.6B',
      ]);
      expect(ownerList[0]!.deviceName).toBe('m3 (mac)');
      expect(ownerList[1]!.deviceName).toBe('(win) 楼下');
      expect(ownerList[2]!.deviceName).toBe('DUP-WIN-OS');
      expect(ownerList[3]!.deviceName).toBe('Unbound Studio PC');
      expect(ownerList[4]!.deviceName).toBe('Shared Fallback OS');

      // Renaming in servers table immediately propagates on next listProvidersHydrated (even with ref_name=NULL)
      db.servers.get('srv-m3-ctrl')!.display_name = 'M3 Studio Renamed';
      db.servers.get('srv-win-ctrl')!.display_name = '(win) 工作室';
      const renamedList = await hub.listProvidersHydrated(db.asDatabase(), 'owner-db');
      expect(renamedList[0]!.displayName).toBe('M3 Studio Renamed · Qwen3-ASR 1.7B');
      expect(renamedList[1]!.displayName).toBe('(win) 工作室 · Qwen3-ASR 0.6B');

      // 4-arg setOwnerMeta MUST preserve already-loaded machines cache (regression guard for PUT nickname/sharing broadcasts)
      proto.setOwnerMeta?.('owner-db', 'K', {}, 'k_owner');
      expect(hub.listProviders('owner-db').slice(0, 2).map((p) => p.displayName)).toEqual([
        'M3 Studio Renamed · Qwen3-ASR 1.7B',
        '(win) 工作室 · Qwen3-ASR 0.6B',
      ]);

      // Cross-account viewer MUST NEVER see DB machine names, deviceName, hostname, or localServerId
      const crossList = await hub.listProvidersHydrated(db.asDatabase(), 'other-db');
      expect(crossList).toEqual([
        {
          deviceId: '550e8400-e29b-41d4-a716-446655440001',
          displayName: 'K · Qwen3-ASR 1.7B',
          model: 'qwen3-1.7b',
          modelLabel: 'Qwen3-ASR 1.7B',
          ready: true,
          busy: false,
          shareScope: 'server',
          isOwnDevice: false,
        },
      ]);
      const crossJson = JSON.stringify(crossList);
      expect(crossJson).not.toContain('M3 Studio Renamed');
      expect(crossJson).not.toContain('KOCA');
      expect(crossJson).not.toContain('srv-m3-host');

      // Custom nickname overrides DB machine name while retaining resolved deviceName metadata
      db.prefs.set(
        `owner-db\0${REMOTE_VOICE_PROVIDER_NICKNAMES_PREF_KEY}`,
        JSON.stringify({ '550e8400-e29b-41d4-a716-446655440001': 'Voice Override' }),
      );
      const nickList = await hub.listProvidersHydrated(db.asDatabase(), 'owner-db');
      expect(nickList[0]).toMatchObject({
        displayName: 'Voice Override',
        customNickname: 'Voice Override',
        deviceName: 'M3 Studio Renamed',
      });

      // Minimal mock DB without servers table degrades gracefully without crashing
      const minimalDb = {
        query: async () => {
          throw new Error('no such table: servers');
        },
        queryOne: async () => null,
        execute: async () => ({ changes: 0 }),
      } as unknown as Database;
      const minimalList = await hub.listProvidersHydrated(minimalDb, 'owner-db');
      expect(minimalList[0]!.displayName).toBe('KOCA’s MacBook Pro (1118) · Qwen3-ASR 1.7B');

      // Two legacy own providers WITHOUT deviceName/hostname/localServerId (same prefix dev-legacy-...) are disambiguated
      db.settings.set(REMOTE_VOICE_SERVER_SHARED_SETTING_KEY, '[]');
      await hub.refreshServerSharedProviders(db.asDatabase());
      proto.setOwnerMeta?.('legacy-u', 'K', {}, 'k_legacy');
      const legacyWs1 = makeWs();
      const legacyWs2 = makeWs();
      hub.handleConnection(legacyWs1, 'legacy-u');
      hub.handleConnection(legacyWs2, 'legacy-u');
      await proto.handleRawMessage(legacyWs1, 'legacy-u', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: 'dev-legacy-alpha1',
        model: 'qwen3-1.7b',
        modelLabel: 'Qwen3-ASR 1.7B',
        ready: true,
      }));
      expect(hub.listProviders('legacy-u').map((p) => p.displayName)).toEqual(['K · Qwen3-ASR 1.7B']);

      await proto.handleRawMessage(legacyWs2, 'legacy-u', JSON.stringify({
        type: 'voice.provider.register',
        deviceId: 'dev-legacy-bravo2',
        model: 'qwen3-1.7b',
        modelLabel: 'Qwen3-ASR 1.7B',
        ready: true,
      }));
      expect(hub.listProviders('legacy-u').map((p) => p.displayName)).toEqual([
        'K · Qwen3-ASR 1.7B · #alpha1',
        'K · Qwen3-ASR 1.7B · #bravo2',
      ]);
    } finally {
      hub.stop();
    }
  });

  it('preserves DB machine names in WS broadcasts across PUT nickname reset and PUT server sharing toggles without calling hydrated GET', async () => {
    memDb.seedUser({ id: 'owner-put', username: 'owner_put', displayName: 'K', isAdmin: true });
    memDb.servers.set('srv-put-m3', {
      id: 'srv-put-m3',
      user_id: 'owner-put',
      name: 'm3 (mac)',
      display_name: 'm3 (mac)',
      ref_name: null,
      host_server_id: null,
      token_hash: 'hp1',
      node_role: 'controlled',
      os: 'darwin',
      revoked_at: null,
      created_at: 200,
    });
    memDb.servers.set('srv-put-win', {
      id: 'srv-put-win',
      user_id: 'owner-put',
      name: 'DESKTOP-PUT (windows)',
      display_name: '(win) 楼下',
      ref_name: null,
      host_server_id: null,
      token_hash: 'hp2',
      node_role: 'controlled',
      os: 'windows',
      revoked_at: null,
      created_at: 201,
    });

    const provM3 = await openVoiceWs(baseUrl, baseUrl, await issueWsTicket('owner-put'));
    const provWin = await openVoiceWs(baseUrl, baseUrl, await issueWsTicket('owner-put'));
    openSockets.push(provM3.ws, provWin.ws);

    provM3.ws.send(JSON.stringify({
      type: 'voice.provider.register',
      deviceId: 'dev-put-m3',
      deviceName: 'KOCAs-Mac',
      localServerId: 'srv-put-m3',
      model: 'qwen3-1.7b',
      modelLabel: 'Qwen3-ASR 1.7B',
      ready: true,
    }));
    provWin.ws.send(JSON.stringify({
      type: 'voice.provider.register',
      deviceId: 'dev-put-win',
      deviceName: 'DESKTOP-PUT',
      hostname: 'DESKTOP-PUT',
      model: 'qwen3-0.6b',
      modelLabel: 'Qwen3-ASR 0.6B',
      ready: true,
    }));
    await provM3.inbox.next((f) => f.type === 'voice.provider.ping');
    await provWin.inbox.next((f) => f.type === 'voice.provider.ping');

    const clientWs = await openVoiceWs(baseUrl, baseUrl, await issueWsTicket('owner-put'));
    openSockets.push(clientWs.ws);

    // Initial hydrate (mirrors opening Settings / initial provider load)
    const initialRes = await fetch(`${baseUrl}/api/voice/providers`, {
      headers: { Authorization: makeAuthHeader('owner-put') },
    });
    expect(initialRes.status).toBe(200);
    const initialBody = await initialRes.json() as { providers: Array<{ displayName: string }> };
    expect(initialBody.providers.map((p) => p.displayName)).toEqual([
      'm3 (mac) · Qwen3-ASR 1.7B',
      '(win) 楼下 · Qwen3-ASR 0.6B',
    ]);

    // 1. PUT custom nickname then reset nickname to null -> WS broadcast MUST keep DB names on BOTH machines
    await fetch(`${baseUrl}/api/voice/provider-nickname`, {
      method: 'PUT',
      headers: { Authorization: makeAuthHeader('owner-put'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-put-m3', nickname: 'Temp Alias' }),
    });
    const setNickBroadcast = await clientWs.inbox.next(
      (f) => f.type === 'voice.providers.updated'
        && Array.isArray(f.providers)
        && f.providers.some((p: { deviceId: string; displayName: string }) => p.deviceId === 'dev-put-m3' && p.displayName === 'Temp Alias'),
    ) as { providers: Array<{ deviceId: string; displayName: string }> };
    expect(setNickBroadcast.providers.find((p) => p.deviceId === 'dev-put-win')?.displayName).toBe(
      '(win) 楼下 · Qwen3-ASR 0.6B',
    );

    await fetch(`${baseUrl}/api/voice/provider-nickname`, {
      method: 'PUT',
      headers: { Authorization: makeAuthHeader('owner-put'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-put-m3', nickname: null }),
    });
    const resetNickBroadcast = await clientWs.inbox.next(
      (f) => f.type === 'voice.providers.updated'
        && Array.isArray(f.providers)
        && f.providers.some((p: { deviceId: string; displayName: string }) => p.deviceId === 'dev-put-m3' && p.displayName === 'm3 (mac) · Qwen3-ASR 1.7B'),
    ) as { providers: Array<{ deviceId: string; displayName: string }> };
    expect(resetNickBroadcast.providers.map((p) => p.displayName)).toEqual([
      'm3 (mac) · Qwen3-ASR 1.7B',
      '(win) 楼下 · Qwen3-ASR 0.6B',
    ]);

    // 2. PUT server-shared-providers toggle WITHOUT calling hydrated GET -> broadcast MUST still keep DB names
    await fetch(`${baseUrl}/api/voice/server-shared-providers`, {
      method: 'PUT',
      headers: { Authorization: makeAuthHeader('owner-put'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-put-m3', shared: true }),
    });
    const shareBroadcast = await clientWs.inbox.next(
      (f) => f.type === 'voice.providers.updated'
        && Array.isArray(f.providers)
        && f.providers.some((p: { deviceId: string; shareScope: string }) => p.deviceId === 'dev-put-m3' && p.shareScope === 'server'),
    ) as { providers: Array<{ deviceId: string; displayName: string }> };
    expect(shareBroadcast.providers.map((p) => p.displayName)).toEqual([
      'm3 (mac) · Qwen3-ASR 1.7B',
      '(win) 楼下 · Qwen3-ASR 0.6B',
    ]);
  });

  it('matches controlled ref_name=null rows whose enrolled hostname keeps .local/.lan/.localdomain suffix while preserving ambiguity guards', () => {
    const macRow: OwnerServerMachineEntry = {
      id: 'srv-studio-mac',
      name: 'studio.local (mac)',
      displayName: 'Studio M2',
      refName: null,
      hostServerId: null,
      nodeRole: 'controlled',
      os: 'mac',
    };
    const winRow: OwnerServerMachineEntry = {
      id: 'srv-win-plain',
      name: 'WIN-BOX (windows)',
      displayName: '(win) 客厅',
      refName: null,
      hostServerId: null,
      nodeRole: 'controlled',
      os: 'windows',
    };

    // macOS .local enrolled name matches normalized hostname='studio' AND equivalent deviceName='studio.local'
    expect(
      resolveDbMachineNameForProvider([macRow, winRow], {
        hostname: 'studio',
        deviceName: 'studio.local',
      }),
    ).toBe('Studio M2');

    // Windows unsuffixed enrolled name continues to match normally
    expect(
      resolveDbMachineNameForProvider([macRow, winRow], {
        hostname: 'WIN-BOX',
        deviceName: 'Windows Living Room',
      }),
    ).toBe('(win) 客厅');

    // Two distinct controlled rows normalizing to the same host ('studio.local (mac)' + 'studio (mac)') -> ambiguous -> null
    const ambiguousMacRow: OwnerServerMachineEntry = {
      id: 'srv-studio-dup',
      name: 'studio (mac)',
      displayName: 'Studio Secondary',
      refName: null,
      hostServerId: null,
      nodeRole: 'controlled',
      os: 'mac',
    };
    expect(
      resolveDbMachineNameForProvider([macRow, ambiguousMacRow], {
        hostname: 'studio',
        deviceName: 'studio.local',
      }),
    ).toBeNull();

    // Localhost suffix stays rejected and OS mismatch suffix is not stripped
    expect(
      resolveDbMachineNameForProvider(
        [
          {
            id: 'srv-localhost',
            name: 'localhost.local (mac)',
            displayName: 'Should Not Match',
            refName: null,
            hostServerId: null,
            nodeRole: 'controlled',
            os: 'mac',
          },
          {
            id: 'srv-wrong-os',
            name: 'mini.local (linux)',
            displayName: 'Wrong OS',
            refName: null,
            hostServerId: null,
            nodeRole: 'controlled',
            os: 'mac',
          },
        ],
        { hostname: 'mini', deviceName: 'localhost' },
      ),
    ).toBeNull();
  });

  it('validates, forwards, and isolates per-session hotwords across PC App and HTTP ASR sessions', async () => {
    expect(parseRemoteVoiceInboundFrame(JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'hw-1',
      targetDeviceId: 'mac-1',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
      hotwords: ['  IM.codes\u0000 ', 'im.codes', 'worktree', ''],
    }))).toEqual({
      ok: true,
      frame: {
        type: 'voice.session.start',
        sessionId: 'hw-1',
        targetDeviceId: 'mac-1',
        sampleRate: REMOTE_VOICE_SAMPLE_RATE,
        hotwords: ['IM.codes', 'worktree'],
      },
    });

    expect(parseRemoteVoiceInboundFrame(JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'hw-bad',
      targetDeviceId: 'mac-1',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
      hotwords: 'not-an-array',
    }))).toMatchObject({ ok: false, sessionId: 'hw-bad', code: 'invalid_frame' });

    const fetchCalls: Array<{ prompt: string | null }> = [];
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const form = init?.body as FormData;
      fetchCalls.push({ prompt: form.get('prompt') as string | null });
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const hub = new RemoteVoiceHub({
      readyTimeoutMs: 50,
      idleTimeoutMs: 50,
      httpAsrTimeoutMs: 500,
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    hub.setServerAsrServices([
      {
        id: 'asr_hw',
        name: 'ASR Hotwords',
        baseUrl: 'https://secret-asr.internal/v1',
        apiKey: '',
        model: 'whisper-1',
        enabled: true,
        source: 'admin',
      },
    ], false);

    const providerSent: Array<Record<string, unknown>> = [];
    const clientASent: Array<Record<string, unknown>> = [];
    const clientBSent: Array<Record<string, unknown>> = [];
    const providerWs = { readyState: WebSocket.OPEN, send: (d: string) => providerSent.push(JSON.parse(d)), on: () => {}, close: () => {} } as unknown as WebSocket;
    const clientAWs = { readyState: WebSocket.OPEN, send: (d: string) => clientASent.push(JSON.parse(d)), on: () => {}, close: () => {} } as unknown as WebSocket;
    const clientBWs = { readyState: WebSocket.OPEN, send: (d: string) => clientBSent.push(JSON.parse(d)), on: () => {}, close: () => {} } as unknown as WebSocket;

    hub.handleConnection(providerWs, 'owner-1');
    hub.handleConnection(clientAWs, 'owner-1');
    hub.handleConnection(clientBWs, 'user-b');
    hub.setServerSharedProviders([{ ownerUserId: 'owner-1', deviceId: 'mac-shared' }]);

    const proto = hub as unknown as {
      handleRawMessage: (ws: WebSocket, u: string, raw: string) => Promise<void>;
    };
    await proto.handleRawMessage(providerWs, 'owner-1', JSON.stringify({
      type: 'voice.provider.register',
      deviceId: 'mac-shared',
      model: 'qwen3-1.7b',
      modelLabel: 'Qwen3-ASR 1.7B',
      ready: true,
    }));

    // Session 1 (User A) includes hotwords -> forwarded to PC App
    await proto.handleRawMessage(clientAWs, 'owner-1', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'pc-a',
      targetDeviceId: 'mac-shared',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
      hotwords: ['IM.codes', 'worktree'],
    }));
    expect(providerSent.at(-1)).toEqual({
      type: 'voice.session.start',
      sessionId: 'pc-a',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
      hotwords: ['IM.codes', 'worktree'],
    });
    await proto.handleRawMessage(providerWs, 'owner-1', JSON.stringify({ type: 'voice.session.end', sessionId: 'pc-a' }));

    // Session 2 (User B) on same PC App without hotwords -> zero leakage
    await proto.handleRawMessage(clientBWs, 'user-b', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'pc-b',
      targetDeviceId: 'mac-shared',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
    }));
    expect(providerSent.at(-1)).toEqual({
      type: 'voice.session.start',
      sessionId: 'pc-b',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
    });
    await proto.handleRawMessage(providerWs, 'owner-1', JSON.stringify({ type: 'voice.session.end', sessionId: 'pc-b' }));

    // Cross-account privacy enforcement: even if client sends hotwords due to stale cache
    // (assuming isOwnDevice=true) without allowSharedHotwords=true, hub MUST drop hotwords when
    // resolved provider belongs to another user, and MUST forward when allowSharedHotwords=true.
    await proto.handleRawMessage(clientBWs, 'user-b', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'pc-b-stale-denied',
      targetDeviceId: 'mac-shared',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
      hotwords: ['SecretProj', 'PrivateTerm'],
    }));
    expect(providerSent.at(-1)).toEqual({
      type: 'voice.session.start',
      sessionId: 'pc-b-stale-denied',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
    });
    expect(
      (hub as unknown as { sessions: Map<string, { hotwords?: string[] }> }).sessions.get('pc-b-stale-denied')?.hotwords,
    ).toBeUndefined();
    await proto.handleRawMessage(providerWs, 'owner-1', JSON.stringify({ type: 'voice.session.end', sessionId: 'pc-b-stale-denied' }));

    await proto.handleRawMessage(clientBWs, 'user-b', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'pc-b-consented',
      targetDeviceId: 'mac-shared',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
      hotwords: ['SharedOptIn'],
      allowSharedHotwords: true,
    }));
    expect(providerSent.at(-1)).toEqual({
      type: 'voice.session.start',
      sessionId: 'pc-b-consented',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
      hotwords: ['SharedOptIn'],
    });
    await proto.handleRawMessage(providerWs, 'owner-1', JSON.stringify({ type: 'voice.session.end', sessionId: 'pc-b-consented' }));

    // Concurrent HTTP ASR: User A sends hotwords -> prompt set; User B omits -> prompt absent
    const pcm = Buffer.alloc(640, 1).toString('base64');
    await proto.handleRawMessage(clientAWs, 'owner-1', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'http-hw-a',
      targetDeviceId: 'asr_hw',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
      hotwords: ['IM.codes', 'codex-sdk'],
    }));
    await proto.handleRawMessage(clientBWs, 'user-b', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'http-hw-b',
      targetDeviceId: 'asr_hw',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
    }));
    await proto.handleRawMessage(clientAWs, 'owner-1', JSON.stringify({ type: 'voice.session.audio', sessionId: 'http-hw-a', pcmBase64: pcm }));
    await proto.handleRawMessage(clientBWs, 'user-b', JSON.stringify({ type: 'voice.session.audio', sessionId: 'http-hw-b', pcmBase64: pcm }));
    await Promise.all([
      proto.handleRawMessage(clientAWs, 'owner-1', JSON.stringify({ type: 'voice.session.stop', sessionId: 'http-hw-a' })),
      proto.handleRawMessage(clientBWs, 'user-b', JSON.stringify({ type: 'voice.session.stop', sessionId: 'http-hw-b' })),
    ]);

    await new Promise((r) => setTimeout(r, 80));
    expect(fetchCalls).toEqual([
      { prompt: 'IM.codes, codex-sdk' },
      { prompt: null },
    ]);
    expect(hub.getActiveSessionCount()).toBe(0);
    hub.stop();
  });

  it('skips upstream HTTP ASR on pure silence/faint noise and strips pure hotword hallucination loops without dropping normal speech', async () => {
    let nextTranscript = 'IM.codes，IM.codes。IM.codes，IM.codes。';
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      return new Response(JSON.stringify({ text: nextTranscript }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const hub = new RemoteVoiceHub({
      readyTimeoutMs: 50,
      idleTimeoutMs: 50,
      httpAsrTimeoutMs: 500,
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    hub.setServerAsrServices([
      {
        id: 'asr_guard',
        name: 'ASR Guard',
        baseUrl: 'https://secret-asr.internal/v1',
        apiKey: '',
        model: 'whisper-1',
        enabled: true,
        source: 'admin',
      },
    ], false);

    const clientSent: Array<Record<string, unknown>> = [];
    const clientWs = { readyState: WebSocket.OPEN, send: (d: string) => clientSent.push(JSON.parse(d)), on: () => {}, close: () => {} } as unknown as WebSocket;
    hub.handleConnection(clientWs, 'owner-guard');

    const proto = hub as unknown as {
      handleRawMessage: (ws: WebSocket, u: string, raw: string) => Promise<void>;
    };

    // 1. Pure silence (zero PCM16) + faint noise floor (< 0.005 RMS, < 0.015 peak): skip HTTP ASR call completely
    const silentPcm = Buffer.alloc(1600, 0).toString('base64');
    const faintNoiseBuf = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i += 1) {
      faintNoiseBuf.writeInt16LE(i % 2 === 0 ? 100 : -100, i * 2); // peak ~0.00305, rms ~0.00305
    }
    const faintNoisePcm = faintNoiseBuf.toString('base64');

    for (const [sid, pcmPayload] of [['http-silent', silentPcm], ['http-faint', faintNoisePcm]] as const) {
      await proto.handleRawMessage(clientWs, 'owner-guard', JSON.stringify({
        type: 'voice.session.start',
        sessionId: sid,
        targetDeviceId: 'asr_guard',
        sampleRate: REMOTE_VOICE_SAMPLE_RATE,
        hotwords: ['IM.codes', 'Codex'],
      }));
      await proto.handleRawMessage(clientWs, 'owner-guard', JSON.stringify({
        type: 'voice.session.audio',
        sessionId: sid,
        pcmBase64: pcmPayload,
      }));
      await proto.handleRawMessage(clientWs, 'owner-guard', JSON.stringify({
        type: 'voice.session.stop',
        sessionId: sid,
      }));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(clientSent.filter((f) => f.type === 'voice.session.result')).toEqual([]);
    expect(clientSent).toContainEqual({ type: 'voice.session.end', sessionId: 'http-silent' });
    expect(clientSent).toContainEqual({ type: 'voice.session.end', sessionId: 'http-faint' });

    // 2. Audible tap / noise triggers upstream ASR, which echoes "IM.codes，IM.codes。IM.codes，IM.codes。" -> stripped, no result emitted
    const audibleBuf = Buffer.alloc(1600);
    for (let i = 0; i < 800; i += 1) {
      audibleBuf.writeInt16LE(1500, i * 2); // ~0.046 amplitude (real speech / tap)
    }
    const audiblePcm = audibleBuf.toString('base64');

    nextTranscript = 'IM.codes，IM.codes。IM.codes，IM.codes。';
    await proto.handleRawMessage(clientWs, 'owner-guard', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'http-echo',
      targetDeviceId: 'asr_guard',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
      hotwords: ['IM.codes', 'Codex'],
    }));
    await proto.handleRawMessage(clientWs, 'owner-guard', JSON.stringify({
      type: 'voice.session.audio',
      sessionId: 'http-echo',
      pcmBase64: audiblePcm,
    }));
    await proto.handleRawMessage(clientWs, 'owner-guard', JSON.stringify({
      type: 'voice.session.stop',
      sessionId: 'http-echo',
    }));
    await new Promise((r) => setTimeout(r, 60));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(clientSent.filter((f) => f.sessionId === 'http-echo' && f.type === 'voice.session.result')).toEqual([]);
    expect(clientSent).toContainEqual({ type: 'voice.session.end', sessionId: 'http-echo' });

    // 3. Real sentence containing hotwords passes through intact
    nextTranscript = '打开 IM.codes 再看看 Codex';
    await proto.handleRawMessage(clientWs, 'owner-guard', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'http-real',
      targetDeviceId: 'asr_guard',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
      hotwords: ['IM.codes', 'Codex'],
    }));
    await proto.handleRawMessage(clientWs, 'owner-guard', JSON.stringify({
      type: 'voice.session.audio',
      sessionId: 'http-real',
      pcmBase64: audiblePcm,
    }));
    await proto.handleRawMessage(clientWs, 'owner-guard', JSON.stringify({
      type: 'voice.session.stop',
      sessionId: 'http-real',
    }));
    await new Promise((r) => setTimeout(r, 60));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(clientSent).toContainEqual({
      type: 'voice.session.result',
      sessionId: 'http-real',
      text: '打开 IM.codes 再看看 Codex',
      isFinal: true,
    });
    expect(hub.getActiveSessionCount()).toBe(0);
    hub.stop();
  });

  it('sanitizes control tags before hotword hallucination check across HTTP ASR and PC provider relay while preserving prior real speech', async () => {
    let nextTranscript = `Codex，${'IM.codes。'.repeat(6)}`;
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      return new Response(JSON.stringify({ text: nextTranscript }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const hub = new RemoteVoiceHub({
      readyTimeoutMs: 50,
      idleTimeoutMs: 50,
      httpAsrTimeoutMs: 500,
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    hub.setServerAsrServices([
      {
        id: 'asr_order',
        name: 'ASR Order',
        baseUrl: 'https://secret-asr.internal/v1',
        apiKey: '',
        model: 'whisper-1',
        enabled: true,
        source: 'admin',
      },
    ], false);

    const providerWs = { readyState: WebSocket.OPEN, send: () => {}, on: () => {}, close: () => {} } as unknown as WebSocket;
    const clientSent: Array<Record<string, unknown>> = [];
    const clientWs = { readyState: WebSocket.OPEN, send: (d: string) => clientSent.push(JSON.parse(d)), on: () => {}, close: () => {} } as unknown as WebSocket;
    hub.handleConnection(providerWs, 'owner-order');
    hub.handleConnection(clientWs, 'owner-order');

    const proto = hub as unknown as {
      handleRawMessage: (ws: WebSocket, u: string, raw: string) => Promise<void>;
    };

    const audibleBuf = Buffer.alloc(1600);
    for (let i = 0; i < 800; i += 1) {
      audibleBuf.writeInt16LE(1500, i * 2);
    }
    const audiblePcm = audibleBuf.toString('base64');

    // 1. HTTP ASR: "Codex，" + 6x "IM.codes。" must NOT strip IM.codes first and leave "Codex，" behind
    await proto.handleRawMessage(clientWs, 'owner-order', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'http-codex-loop',
      targetDeviceId: 'asr_order',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
      hotwords: ['Codex', 'IM.codes'],
    }));
    await proto.handleRawMessage(clientWs, 'owner-order', JSON.stringify({
      type: 'voice.session.audio',
      sessionId: 'http-codex-loop',
      pcmBase64: audiblePcm,
    }));
    await proto.handleRawMessage(clientWs, 'owner-order', JSON.stringify({
      type: 'voice.session.stop',
      sessionId: 'http-codex-loop',
    }));
    await new Promise((r) => setTimeout(r, 60));
    expect(clientSent.filter((f) => f.sessionId === 'http-codex-loop' && f.type === 'voice.session.result')).toEqual([]);
    expect(clientSent).toContainEqual({ type: 'voice.session.end', sessionId: 'http-codex-loop' });

    // 2. PC provider relay: control tag prefix before 4-repeat loop is stripped FIRST, then hotword guard catches loop
    await proto.handleRawMessage(providerWs, 'owner-order', JSON.stringify({
      type: 'voice.provider.register',
      deviceId: 'mac-order',
      model: 'qwen3-1.7b',
      modelLabel: 'Qwen3-ASR 1.7B',
      ready: true,
    }));
    await proto.handleRawMessage(clientWs, 'owner-order', JSON.stringify({
      type: 'voice.session.start',
      sessionId: 'pc-tag-order',
      targetDeviceId: 'mac-order',
      sampleRate: REMOTE_VOICE_SAMPLE_RATE,
      hotwords: ['Codex', 'IM.codes'],
    }));
    await proto.handleRawMessage(providerWs, 'owner-order', JSON.stringify({ type: 'voice.session.ready', sessionId: 'pc-tag-order' }));
    await proto.handleRawMessage(providerWs, 'owner-order', JSON.stringify({
      type: 'voice.session.result',
      sessionId: 'pc-tag-order',
      text: 'language None<asr_text>IM.codes，IM.codes。IM.codes，IM.codes。',
      isFinal: false,
    }));
    await proto.handleRawMessage(providerWs, 'owner-order', JSON.stringify({
      type: 'voice.session.result',
      sessionId: 'pc-tag-order',
      text: 'language Chinese<asr_text>打开 IM.codes',
      isFinal: false,
    }));
    await proto.handleRawMessage(providerWs, 'owner-order', JSON.stringify({
      type: 'voice.session.result',
      sessionId: 'pc-tag-order',
      text: 'language None<asr_text>IM.codes，IM.codes。IM.codes，IM.codes。',
      isFinal: true,
    }));
    await proto.handleRawMessage(providerWs, 'owner-order', JSON.stringify({ type: 'voice.session.end', sessionId: 'pc-tag-order' }));

    const pcResults = clientSent.filter((f) => f.sessionId === 'pc-tag-order' && f.type === 'voice.session.result');
    expect(pcResults).toEqual([
      { type: 'voice.session.result', sessionId: 'pc-tag-order', text: '打开 IM.codes', isFinal: false },
      { type: 'voice.session.result', sessionId: 'pc-tag-order', text: '打开 IM.codes', isFinal: true },
    ]);
    expect(hub.getActiveSessionCount()).toBe(0);
    hub.stop();
  });
});
