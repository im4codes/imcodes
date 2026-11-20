import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/index.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { signJwt } from '../src/security/crypto.js';
import { clearServerTtsVoicesCache } from '../src/routes/tts.js';
import { activeUserAnswer } from './helpers/user-status.js';
import { COOKIE_CSRF, COOKIE_SESSION, HEADER_CSRF } from '../../shared/cookie-names.js';
import {
  TTS_CONFIG_PATH,
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_RESPONSE_FORMAT,
  TTS_DEFAULT_VOICE,
  TTS_MAX_RESPONSE_BYTES,
  TTS_OPENAI_PRESET_VOICES,
  TTS_SPEECH_PATH,
  TTS_USER_CONFIG_PREF_KEY,
  TTS_VOICES_MAX_RESPONSE_BYTES,
  TTS_VOICES_PATH,
} from '../../shared/tts-config.js';

const JWT_KEY = 'test-signing-key-32chars-padding!!';
const BOT_KEY = 'test-bot-encryption-key-32chars!!';

function makeMemDb(): { db: Database; prefs: Map<string, string> } {
  const prefs = new Map<string, string>();
  const keyFor = (userId: string, key: string) => `${userId}:${key}`;

  const db = {
    query: async <T = unknown>(sql: string): Promise<T[]> => {
      const activeUser = activeUserAnswer(sql);
      if (activeUser) return [activeUser as T];
      return [];
    },
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const activeUser = activeUserAnswer(sql);
      if (activeUser) return activeUser as T;
      const s = sql.toLowerCase();
      if (s.includes('from user_preferences')) {
        const val = prefs.get(keyFor(String(params[0]), String(params[1])));
        return (val !== undefined ? { value: val } : null) as T | null;
      }
      return null;
    },
    execute: async (sql: string, params: unknown[] = []): Promise<void> => {
      const s = sql.toLowerCase();
      if (s.includes('insert into user_preferences')) {
        prefs.set(keyFor(String(params[0]), String(params[1])), String(params[2]));
      } else if (s.includes('delete from user_preferences')) {
        prefs.delete(keyFor(String(params[0]), String(params[1])));
      }
    },
    transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => fn(db),
  } as unknown as Database;

  return { db, prefs };
}

function makeEnv(db: Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: JWT_KEY,
    BOT_ENCRYPTION_KEY: BOT_KEY,
    SERVER_URL: 'https://test.im.codes',
    ALLOWED_ORIGINS: 'https://test.im.codes',
    DATABASE_URL: 'postgres://localhost/test',
    ...overrides,
  };
}

function authCookies(userId = 'user-1'): string {
  const token = signJwt({ sub: userId, role: 'owner', type: 'web' }, JWT_KEY, 3600);
  return `${COOKIE_SESSION}=${token}; ${COOKIE_CSRF}=csrf-tok-1`;
}

function cookieWriteHeaders(cookie: string, json = true): Record<string, string> {
  return {
    Cookie: cookie,
    Origin: 'https://test.im.codes',
    [HEADER_CSRF]: 'csrf-tok-1',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

describe('TTS routes & preferences isolation', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    clearServerTtsVoicesCache();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('requires authentication on /api/tts/config and /api/tts/speech', async () => {
    const { db } = makeMemDb();
    const env = makeEnv(db);
    const app = buildApp(env);

    const r1 = await app.request(TTS_CONFIG_PATH, { method: 'GET' }, env);
    expect(r1.status).toBe(401);

    const r2 = await app.request(TTS_SPEECH_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'hello' }),
    }, env);
    expect(r2.status).toBe(401);
  });

  it('blocks direct access to reserved TTS preference key via /api/preferences/*', async () => {
    const { db } = makeMemDb();
    const env = makeEnv(db);
    const app = buildApp(env);
    const cookie = authCookies();

    const g = await app.request(`/api/preferences/${encodeURIComponent(TTS_USER_CONFIG_PREF_KEY)}`, {
      method: 'GET',
      headers: { Cookie: cookie },
    }, env);
    expect(g.status).toBe(403);

    const p = await app.request(`/api/preferences/${encodeURIComponent(TTS_USER_CONFIG_PREF_KEY)}`, {
      method: 'PUT',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ value: { mode: 'server' } }),
    }, env);
    expect(p.status).toBe(403);

    const d = await app.request(`/api/preferences/${encodeURIComponent(TTS_USER_CONFIG_PREF_KEY)}`, {
      method: 'DELETE',
      headers: cookieWriteHeaders(cookie, false),
    }, env);
    expect(d.status).toBe(403);
  });

  it('encrypts API key at rest, masks on read, keeps on omit, and clears on empty string', async () => {
    const { db, prefs } = makeMemDb();
    const env = makeEnv(db);
    const app = buildApp(env);
    const cookie = authCookies();
    const secret = 'sk-secret-key-9876543210';

    const put1 = await app.request(TTS_CONFIG_PATH, {
      method: 'PUT',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({
        mode: 'server',
        baseUrl: 'http://127.0.0.1:8880/v1',
        apiKey: secret,
        model: 'kokoro',
        voice: 'af_sky',
        responseFormat: 'wav',
      }),
    }, env);
    expect(put1.status).toBe(200);
    const body1 = await put1.json() as { config: Record<string, unknown> };
    expect(body1.config.mode).toBe('server');
    expect(body1.config.baseUrl).toBe('http://127.0.0.1:8880/v1');
    expect(body1.config.hasApiKey).toBe(true);
    expect(body1.config.apiKeyMasked).toBe('sk-s...3210');
    expect(JSON.stringify(body1)).not.toContain(secret);

    const rawStored = prefs.get(`user-1:${TTS_USER_CONFIG_PREF_KEY}`)!;
    expect(rawStored).toBeDefined();
    expect(rawStored).not.toContain(secret);

    // Omitting apiKey preserves previously saved encrypted key
    const put2 = await app.request(TTS_CONFIG_PATH, {
      method: 'PUT',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ voice: 'af_bella' }),
    }, env);
    expect(put2.status).toBe(200);
    const get2 = await app.request(TTS_CONFIG_PATH, {
      method: 'GET',
      headers: { Cookie: cookie },
    }, env);
    expect(get2.status).toBe(200);
    const cfg2 = await get2.json() as Record<string, unknown>;
    expect(cfg2.hasApiKey).toBe(true);
    expect(cfg2.apiKeyMasked).toBe('sk-s...3210');
    expect(cfg2.voice).toBe('af_bella');
    expect(JSON.stringify(cfg2)).not.toContain(secret);

    // Empty string clears stored key
    const put3 = await app.request(TTS_CONFIG_PATH, {
      method: 'PUT',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ apiKey: '' }),
    }, env);
    expect(put3.status).toBe(200);
    const body3 = await put3.json() as { config: Record<string, unknown> };
    expect(body3.config.hasApiKey).toBe(false);
    expect(body3.config.apiKeyMasked).toBeNull();
  });

  it('rejects unsafe baseUrl targets and missing BOT_ENCRYPTION_KEY when saving apiKey', async () => {
    const { db } = makeMemDb();
    const env = makeEnv(db, { BOT_ENCRYPTION_KEY: '' });
    const app = buildApp(env);
    const cookie = authCookies();

    const badMeta = await app.request(TTS_CONFIG_PATH, {
      method: 'PUT',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ baseUrl: 'http://169.254.169.254/latest' }),
    }, env);
    expect(badMeta.status).toBe(400);

    const noKeySecret = await app.request(TTS_CONFIG_PATH, {
      method: 'PUT',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ baseUrl: 'http://127.0.0.1:8880/v1', apiKey: 'sk-1234567890' }),
    }, env);
    expect(noKeySecret.status).toBe(500);
  });

  it('proxies OpenAI speech requests with env defaults and streams audio without leaking apiKey', async () => {
    const { db } = makeMemDb();
    const env = makeEnv(db, {
      TTS_BASE_URL: 'https://tts.example.com/v1',
      TTS_API_KEY: 'env-secret-api-key-9999',
      TTS_MODEL: 'tts-1',
      TTS_VOICE: 'nova',
      TTS_RESPONSE_FORMAT: 'mp3',
    });
    const app = buildApp(env);
    const cookie = authCookies();

    const cfgRes = await app.request(TTS_CONFIG_PATH, {
      method: 'GET',
      headers: { Cookie: cookie },
    }, env);
    expect(cfgRes.status).toBe(200);
    const cfg = await cfgRes.json() as Record<string, unknown>;
    expect(cfg.mode).toBe('server');
    expect(cfg.serverDefaultConfigured).toBe(true);
    expect(cfg.model).toBe('tts-1');
    expect(cfg.voice).toBe('nova');
    expect(JSON.stringify(cfg)).not.toContain('env-secret-api-key-9999');

    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(Uint8Array.from([1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const speechRes = await app.request(TTS_SPEECH_PATH, {
      method: 'POST',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ input: 'Hello world', speed: 1.5 }),
    }, env);
    expect(speechRes.status).toBe(200);
    expect(speechRes.headers.get('content-type')).toBe('audio/mpeg');
    expect(speechRes.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await speechRes.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3, 4]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, init] = fetchMock.mock.calls[0]!;
    expect(targetUrl).toBe('https://tts.example.com/v1/audio/speech');
    expect(init?.redirect).toBe('manual');
    const hdrs = init?.headers as Record<string, string>;
    expect(hdrs.Authorization).toBe('Bearer env-secret-api-key-9999');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'tts-1',
      input: 'Hello world',
      voice: 'nova',
      response_format: 'mp3',
      speed: 1.5,
    });
  });

  it('never sends env TTS_API_KEY to a user-supplied baseUrl and blocks 3xx redirects or oversized responses', async () => {
    const { db } = makeMemDb();
    const env = makeEnv(db, {
      TTS_BASE_URL: 'https://admin-tts.example.com/v1',
      TTS_API_KEY: 'admin-only-secret-key',
    });
    const app = buildApp(env);
    const cookie = authCookies();

    // User sets their own local URL without an apiKey
    await app.request(TTS_CONFIG_PATH, {
      method: 'PUT',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ mode: 'server', baseUrl: 'http://192.168.1.50:8880' }),
    }, env);

    const fetchMock = vi.fn(async () => new Response(Uint8Array.from([9, 8]), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    const okRes = await app.request(TTS_SPEECH_PATH, {
      method: 'POST',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ input: 'Test local' }),
    }, env);
    expect(okRes.status).toBe(200);
    const hdrs = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(hdrs.Authorization).toBeUndefined();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      model: TTS_DEFAULT_MODEL,
      input: 'Test local',
      voice: TTS_DEFAULT_VOICE,
      response_format: TTS_DEFAULT_RESPONSE_FORMAT,
    });

    // 3xx redirect blocked
    globalThis.fetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'http://169.254.169.254/latest' },
    })) as typeof fetch;
    const redirRes = await app.request(TTS_SPEECH_PATH, {
      method: 'POST',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ input: 'Test redirect' }),
    }, env);
    expect(redirRes.status).toBe(502);

    // Oversized Content-Length blocked
    globalThis.fetch = vi.fn(async () => new Response(Uint8Array.from([1]), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(TTS_MAX_RESPONSE_BYTES + 1),
      },
    })) as typeof fetch;
    const bigRes = await app.request(TTS_SPEECH_PATH, {
      method: 'POST',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ input: 'Test large' }),
    }, env);
    expect(bigRes.status).toBe(502);
  });

  it('propagates client aborts to the upstream fetch signal and sanitizes upstream errors', async () => {
    const { db } = makeMemDb();
    const env = makeEnv(db);
    const app = buildApp(env);
    const cookie = authCookies();
    const secret = 'sk-do-not-leak-in-errors';

    await app.request(TTS_CONFIG_PATH, {
      method: 'PUT',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ mode: 'server', baseUrl: 'https://api.openai.com/v1', apiKey: secret }),
    }, env);

    // Upstream 401/500 does not leak API key
    globalThis.fetch = vi.fn(async () => new Response(`bad key ${secret}`, { status: 401 })) as typeof fetch;
    const errRes = await app.request(TTS_SPEECH_PATH, {
      method: 'POST',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ input: 'Hello' }),
    }, env);
    expect(errRes.status).toBe(502);
    const errText = await errRes.text();
    expect(errText).not.toContain(secret);

    // Client abort cancels upstream fetch signal
    let capturedSignal: AbortSignal | undefined;
    const clientAbort = new AbortController();
    globalThis.fetch = vi.fn((_url, init) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }) as typeof fetch;

    const reqPromise = app.request(TTS_SPEECH_PATH, {
      method: 'POST',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ input: 'Abort me' }),
      signal: clientAbort.signal,
    }, env);
    await new Promise((r) => setTimeout(r, 10));
    clientAbort.abort();
    const abortRes = await reqPromise;
    expect(capturedSignal?.aborted).toBe(true);
    expect(abortRes.status).toBe(499);
  });

  it('defaults mode to server when configured unless user explicitly saves system', async () => {
    const { db } = makeMemDb();
    const env = makeEnv(db, { TTS_BASE_URL: 'https://tts.example.com/v1' });
    const app = buildApp(env);
    const cookie = authCookies();

    // Unconfigured user without env defaults -> mode: 'system'
    const unconfiguredEnv = makeEnv(db);
    const unconfiguredApp = buildApp(unconfiguredEnv);
    const rUnconf = await unconfiguredApp.request(TTS_CONFIG_PATH, {
      method: 'GET',
      headers: { Cookie: cookie },
    }, unconfiguredEnv);
    expect((await rUnconf.json() as Record<string, unknown>).mode).toBe('system');

    // User saves baseUrl without specifying mode -> defaults to 'server'
    const rUserBase = await unconfiguredApp.request(TTS_CONFIG_PATH, {
      method: 'PUT',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ baseUrl: 'http://127.0.0.1:8880/v1' }),
    }, unconfiguredEnv);
    expect((await rUserBase.json() as { config: Record<string, unknown> }).config.mode).toBe('server');

    // Admin env TTS_BASE_URL configured -> fresh user gets mode: 'server'
    const cookie2 = authCookies('user-2');
    const rAdmin = await app.request(TTS_CONFIG_PATH, {
      method: 'GET',
      headers: { Cookie: cookie2 },
    }, env);
    expect((await rAdmin.json() as Record<string, unknown>).mode).toBe('server');

    // Explicit user override to 'system' persists
    const rSys = await app.request(TTS_CONFIG_PATH, {
      method: 'PUT',
      headers: cookieWriteHeaders(cookie2),
      body: JSON.stringify({ mode: 'system' }),
    }, env);
    expect((await rSys.json() as { config: Record<string, unknown> }).config.mode).toBe('system');
    const rAfter = await app.request(TTS_CONFIG_PATH, {
      method: 'GET',
      headers: { Cookie: cookie2 },
    }, env);
    expect((await rAfter.json() as Record<string, unknown>).mode).toBe('system');
  });

  it('GET /api/tts/voices requires auth, probes /audio/voices then /voices with key isolation, normalizes shapes, and falls back to presets', async () => {
    const { db } = makeMemDb();
    const env = makeEnv(db, {
      TTS_BASE_URL: 'https://admin-tts.example.com/v1',
      TTS_API_KEY: 'admin-secret-voices-key',
      TTS_VOICE: 'zh-CN-XiaoxiaoNeural',
    });
    const app = buildApp(env);
    const cookie = authCookies();

    // Auth required
    const unauth = await app.request(TTS_VOICES_PATH, { method: 'GET' }, env);
    expect(unauth.status).toBe(401);

    // Unconfigured returns presets
    const unconfEnv = makeEnv(db);
    const unconfApp = buildApp(unconfEnv);
    const unconfRes = await unconfApp.request(TTS_VOICES_PATH, {
      method: 'GET',
      headers: { Cookie: cookie },
    }, unconfEnv);
    expect(unconfRes.status).toBe(200);
    const unconfBody = await unconfRes.json() as { voices: Array<{ id: string }>; source: string; endpointConfigured: boolean };
    expect(unconfBody.source).toBe('preset');
    expect(unconfBody.endpointConfigured).toBe(false);
    expect(unconfBody.voices.map((v) => v.id)).toEqual(TTS_OPENAI_PRESET_VOICES);

    // /v1/audio/voices 404 -> probes /v1/voices -> normalizes Azure/Edge-TTS + includes configured voice
    const probedUrls: string[] = [];
    const seenAuths: Array<string | undefined> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      probedUrls.push(String(url));
      seenAuths.push((init?.headers as Record<string, string>)?.Authorization);
      if (String(url).endsWith('/audio/voices')) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify({
        voices: [
          { ShortName: 'zh-CN-YunxiNeural', FriendlyName: 'Yunxi', Locale: 'zh-CN', Gender: 'Male' },
          'af_bella',
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const upRes = await app.request(TTS_VOICES_PATH, {
      method: 'GET',
      headers: { Cookie: cookie },
    }, env);
    expect(upRes.status).toBe(200);
    const upBody = await upRes.json() as { voices: Array<{ id: string; name?: string; locale?: string; gender?: string }>; source: string; endpointConfigured: boolean };
    expect(probedUrls).toEqual([
      'https://admin-tts.example.com/v1/audio/voices',
      'https://admin-tts.example.com/v1/voices',
    ]);
    expect(seenAuths).toEqual(['Bearer admin-secret-voices-key', 'Bearer admin-secret-voices-key']);
    expect(upBody.source).toBe('upstream');
    expect(upBody.endpointConfigured).toBe(true);
    expect(upBody.voices).toEqual([
      { id: 'zh-CN-XiaoxiaoNeural', name: 'zh-CN-XiaoxiaoNeural' },
      { id: 'zh-CN-YunxiNeural', name: 'Yunxi', locale: 'zh-CN', gender: 'Male' },
      { id: 'af_bella', name: 'af_bella' },
    ]);

    // User-supplied baseUrl never receives admin TTS_API_KEY and blocks redirects / oversized / error -> preset fallback
    await app.request(TTS_CONFIG_PATH, {
      method: 'PUT',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ baseUrl: 'http://127.0.0.1:5050/v1', voice: 'custom_role' }),
    }, env);
    const userAuths: Array<string | undefined> = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      userAuths.push((init?.headers as Record<string, string>)?.Authorization);
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } });
    }) as typeof fetch;

    const fbRes = await app.request(TTS_VOICES_PATH, {
      method: 'GET',
      headers: { Cookie: cookie },
    }, env);
    expect(fbRes.status).toBe(200);
    const fbBody = await fbRes.json() as { voices: Array<{ id: string }>; source: string; endpointConfigured: boolean };
    expect(userAuths).toEqual([undefined, undefined]);
    expect(fbBody.source).toBe('preset');
    expect(fbBody.endpointConfigured).toBe(true);
    expect(fbBody.voices[0]?.id).toBe('custom_role');
    expect(fbBody.voices.some((v) => v.id === 'alloy')).toBe(true);

    // Oversized upstream JSON is skipped cleanly -> preset fallback
    globalThis.fetch = vi.fn(async () => new Response('x'.repeat(10), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(TTS_VOICES_MAX_RESPONSE_BYTES + 1) },
    })) as typeof fetch;
    const bigRes = await app.request(TTS_VOICES_PATH, {
      method: 'GET',
      headers: { Cookie: cookie },
    }, env);
    expect(bigRes.status).toBe(200);
    expect((await bigRes.json() as { source: string }).source).toBe('preset');
  });

  it('persists voicesByLang, preserves overrides across partial updates, clears with empty string, and resolves lang on /speech', async () => {
    const { db, prefs } = makeMemDb();
    const env = makeEnv(db, {
      TTS_BASE_URL: 'https://tts.example.com/v1',
      TTS_VOICE: 'zh-CN-XiaoxiaoNeural',
      TTS_VOICES_BY_LANG: JSON.stringify({ en: 'en-US-GuyNeural', 'zh-TW': 'zh-TW-HsiaoChenNeural', invalid: 'skip' }),
    });
    const app = buildApp(env);
    const cookie = authCookies();

    // GET /config merges env TTS_VOICES_BY_LANG defaults
    const get1 = await app.request(TTS_CONFIG_PATH, { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(get1.status).toBe(200);
    expect((await get1.json() as { voicesByLang: Record<string, string> }).voicesByLang).toEqual({
      en: 'en-US-GuyNeural',
      'zh-TW': 'zh-TW-HsiaoChenNeural',
    });

    // Legacy preference record without voicesByLang treats voicesByLang as {} cleanly
    prefs.set(`user-legacy:${TTS_USER_CONFIG_PREF_KEY}`, JSON.stringify({ voice: 'nova', mode: 'server' }));
    const legacyRes = await app.request(TTS_CONFIG_PATH, {
      method: 'GET',
      headers: { Cookie: authCookies('user-legacy') },
    }, env);
    expect((await legacyRes.json() as { voicesByLang: Record<string, string> }).voicesByLang).toEqual({
      en: 'en-US-GuyNeural',
      'zh-TW': 'zh-TW-HsiaoChenNeural',
    });

    // PUT /config saves per-language overrides + sanitizes keys
    const put1 = await app.request(TTS_CONFIG_PATH, {
      method: 'PUT',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({
        voicesByLang: {
          'en-GB': 'en-GB-SoniaNeural',
          ja: 'ja-JP-NanamiNeural',
          fr: 'ignored-lang',
          ko: '   ',
        },
      }),
    }, env);
    expect(put1.status).toBe(200);
    expect((await put1.json() as { config: { voicesByLang: Record<string, string> } }).config.voicesByLang).toEqual({
      en: 'en-GB-SoniaNeural',
      'zh-TW': 'zh-TW-HsiaoChenNeural',
      ja: 'ja-JP-NanamiNeural',
    });

    // Partial update (e.g. quick popover { voice }) preserves saved voicesByLang
    const putPartial = await app.request(TTS_CONFIG_PATH, {
      method: 'PUT',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ voice: 'zh-CN-YunxiNeural' }),
    }, env);
    expect(putPartial.status).toBe(200);
    const partialBody = await putPartial.json() as { config: { voice: string; voicesByLang: Record<string, string> } };
    expect(partialBody.config.voice).toBe('zh-CN-YunxiNeural');
    expect(partialBody.config.voicesByLang).toEqual({
      en: 'en-GB-SoniaNeural',
      'zh-TW': 'zh-TW-HsiaoChenNeural',
      ja: 'ja-JP-NanamiNeural',
    });

    // Empty string clears a language override back to default/auto
    const putClear = await app.request(TTS_CONFIG_PATH, {
      method: 'PUT',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ voicesByLang: { ja: '' } }),
    }, env);
    expect((await putClear.json() as { config: { voicesByLang: Record<string, string> } }).config.voicesByLang).toEqual({
      en: 'en-GB-SoniaNeural',
      'zh-TW': 'zh-TW-HsiaoChenNeural',
    });

    // POST /speech resolves lang -> override when body.voice omitted, explicit voice wins, unmatched falls back
    const upstreamVoices: string[] = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { voice?: string };
      upstreamVoices.push(String(parsed.voice));
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    }) as typeof fetch;

    await app.request(TTS_SPEECH_PATH, {
      method: 'POST',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ input: 'Hello world', lang: 'en-US' }),
    }, env);
    await app.request(TTS_SPEECH_PATH, {
      method: 'POST',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ input: 'Привет мир', lang: 'ru-RU' }),
    }, env);
    await app.request(TTS_SPEECH_PATH, {
      method: 'POST',
      headers: cookieWriteHeaders(cookie),
      body: JSON.stringify({ input: 'Explicit override', lang: 'en-US', voice: 'en-US-AriaNeural' }),
    }, env);

    expect(upstreamVoices).toEqual(['en-GB-SoniaNeural', 'zh-CN-YunxiNeural', 'en-US-AriaNeural']);
  });

  it('caches upstream voice lists across requests, honors ?refresh=1, isolates cache keys by target+key, and falls back to stale upstream voices on transient refresh errors', async () => {
    const { db } = makeMemDb();
    const env = makeEnv(db, {
      TTS_BASE_URL: 'https://edge-tts.example.com/v1',
      TTS_API_KEY: 'key-alpha',
      TTS_VOICE: 'zh-CN-XiaoxiaoNeural',
    });
    const app = buildApp(env);
    const cookie = authCookies();

    let upstreamCalls = 0;
    let shouldFailUpstream = false;
    let returnedVoices = [
      { ShortName: 'zh-CN-XiaoxiaoNeural', FriendlyName: 'Xiaoxiao', Locale: 'zh-CN' },
      { ShortName: 'en-US-AriaNeural', FriendlyName: 'Aria', Locale: 'en-US' },
    ];
    globalThis.fetch = vi.fn(async (url) => {
      upstreamCalls += 1;
      if (shouldFailUpstream) {
        return new Response('gateway timeout', { status: 504 });
      }
      if (String(url).endsWith('/audio/voices')) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify({ voices: returnedVoices }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    // 1. Cold fetch populates cache
    const res1 = await app.request(TTS_VOICES_PATH, { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as { voices: Array<{ id: string }>; source: string };
    expect(body1.source).toBe('upstream');
    expect(body1.voices.map((v) => v.id)).toEqual(['zh-CN-XiaoxiaoNeural', 'en-US-AriaNeural']);
    const callsAfterCold = upstreamCalls;
    expect(callsAfterCold).toBeGreaterThan(0);

    // 2. Subsequent GET serves from cache with zero upstream calls (even if upstream is currently failing)
    shouldFailUpstream = true;
    const res2 = await app.request(TTS_VOICES_PATH, { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as { voices: Array<{ id: string }>; source: string };
    expect(body2.source).toBe('upstream');
    expect(body2.voices.map((v) => v.id)).toEqual(['zh-CN-XiaoxiaoNeural', 'en-US-AriaNeural']);
    expect(upstreamCalls).toBe(callsAfterCold);

    // 3. Forced ?refresh=1 probes upstream; if upstream transiently fails, retains stale upstream list (NOT preset!)
    const res3 = await app.request(`${TTS_VOICES_PATH}?refresh=1`, { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res3.status).toBe(200);
    const body3 = await res3.json() as { voices: Array<{ id: string }>; source: string };
    expect(body3.source).toBe('upstream');
    expect(body3.voices.map((v) => v.id)).toEqual(['zh-CN-XiaoxiaoNeural', 'en-US-AriaNeural']);
    expect(upstreamCalls).toBeGreaterThan(callsAfterCold);

    // 4. Forced ?refresh=1 updates cache when upstream recovers with new voices
    shouldFailUpstream = false;
    returnedVoices = [
      { ShortName: 'zh-CN-YunxiNeural', FriendlyName: 'Yunxi', Locale: 'zh-CN' },
    ];
    const res4 = await app.request(`${TTS_VOICES_PATH}?refresh=1`, { method: 'GET', headers: { Cookie: cookie } }, env);
    const body4 = await res4.json() as { voices: Array<{ id: string }>; source: string };
    expect(body4.source).toBe('upstream');
    // Unmatched user currentVoice is still prepended cleanly without polluting cache
    expect(body4.voices.map((v) => v.id)).toEqual(['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural']);

    // 5. Different apiKey / baseUrl isolates cache keys cleanly (never serves stale voices from another key)
    const otherKeyEnv = makeEnv(db, {
      TTS_BASE_URL: 'https://edge-tts.example.com/v1',
      TTS_API_KEY: 'key-beta',
      TTS_VOICE: 'alloy',
    });
    const otherApp = buildApp(otherKeyEnv);
    shouldFailUpstream = true;
    const otherRes = await otherApp.request(TTS_VOICES_PATH, { method: 'GET', headers: { Cookie: cookie } }, otherKeyEnv);
    const otherBody = await otherRes.json() as { voices: Array<{ id: string }>; source: string };
    expect(otherBody.source).toBe('preset');
  });
});
