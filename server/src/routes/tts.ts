import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import { getUserById, getUserPref, setUserPref } from '../db/queries.js';
import { requireAuth } from '../security/authorization.js';
import { decryptBotConfig, encryptBotConfig } from '../security/crypto.js';
import { isUserStatusActive } from '../../../shared/user-status.js';
import logger from '../util/logger.js';
import {
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_RESPONSE_FORMAT,
  TTS_DEFAULT_VOICE,
  TTS_ENGINES,
  TTS_MAX_INPUT_CHARS,
  TTS_MAX_RESPONSE_BYTES,
  TTS_OPENAI_PRESET_VOICES,
  TTS_REQUEST_TIMEOUT_MS,
  TTS_RESPONSE_FORMATS,
  TTS_USER_CONFIG_PREF_KEY,
  TTS_VOICES_CACHE_TTL_MS,
  TTS_VOICES_MAX_RESPONSE_BYTES,
  TTS_VOICES_TIMEOUT_MS,
  clampTtsServerSpeed,
  isTtsEngineMode,
  isTtsResponseFormat,
  maskTtsApiKey,
  normalizeTtsVoiceLangKey,
  resolveOpenAiSpeechEndpoint,
  resolveOpenAiVoicesEndpoints,
  resolveServerTtsVoiceForLang,
  sanitizeTtsVoicesByLang,
  ttsAudioContentType,
  validateTtsBaseUrl,
  type TtsEngineMode,
  type TtsPublicConfig,
  type TtsResponseFormat,
  type TtsVoiceOption,
  type TtsVoicesResponse,
} from '../../../shared/tts-config.js';

export const ttsRoutes = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

ttsRoutes.use('/*', requireAuth());

interface CachedUpstreamVoicesEntry {
  voices: TtsVoiceOption[];
  fetchedAt: number;
}

const upstreamVoicesCache = new Map<string, CachedUpstreamVoicesEntry>();

/** Clear cached upstream voice discovery entries (for tests). */
export function clearServerTtsVoicesCache(): void {
  upstreamVoicesCache.clear();
}

function upstreamVoicesCacheKey(baseUrl: string, apiKey: string): string {
  const keyHash = apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 16) : '';
  return `${baseUrl}\u0000${keyHash}`;
}

interface StoredUserTtsConfig {
  mode?: TtsEngineMode;
  baseUrl?: string;
  apiKeyEncrypted?: string | null;
  model?: string;
  voice?: string;
  voicesByLang?: Record<string, string>;
  responseFormat?: TtsResponseFormat;
}

interface EnvTtsDefaults {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  voicesByLang: Record<string, string>;
  responseFormat: TtsResponseFormat;
  serverDefaultConfigured: boolean;
}

const configUpdateSchema = z.object({
  mode: z.enum(TTS_ENGINES).optional(),
  baseUrl: z.string().max(2048).optional(),
  apiKey: z.string().max(4096).optional(),
  model: z.string().max(256).optional(),
  voice: z.string().max(256).optional(),
  voicesByLang: z.record(z.string().max(32), z.string().max(256)).optional(),
  responseFormat: z.enum(TTS_RESPONSE_FORMATS).optional(),
});

const speechRequestSchema = z.object({
  input: z.string().max(TTS_MAX_INPUT_CHARS),
  model: z.string().max(256).optional(),
  voice: z.string().max(256).optional(),
  lang: z.string().max(32).optional(),
  speed: z.number().finite().optional(),
  response_format: z.enum(TTS_RESPONSE_FORMATS).optional(),
  instructions: z.string().max(1024).optional(),
});

function parseEnvVoicesByLang(raw?: string): Record<string, string> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return {};
  try {
    return sanitizeTtsVoicesByLang(JSON.parse(trimmed));
  } catch {
    return {};
  }
}

function readEnvTtsDefaults(env: Env): EnvTtsDefaults {
  const rawBaseUrl = (env.TTS_BASE_URL ?? '').trim();
  const validatedBase = rawBaseUrl ? validateTtsBaseUrl(rawBaseUrl) : null;
  const baseUrl = validatedBase?.ok ? validatedBase.url : '';
  const apiKey = (env.TTS_API_KEY ?? '').trim();
  const model = (env.TTS_MODEL ?? '').trim() || TTS_DEFAULT_MODEL;
  const voice = (env.TTS_VOICE ?? '').trim() || TTS_DEFAULT_VOICE;
  const voicesByLang = parseEnvVoicesByLang(env.TTS_VOICES_BY_LANG);
  const rawFmt = (env.TTS_RESPONSE_FORMAT ?? '').trim();
  const responseFormat = isTtsResponseFormat(rawFmt) ? rawFmt : TTS_DEFAULT_RESPONSE_FORMAT;
  return {
    baseUrl,
    apiKey,
    model,
    voice,
    voicesByLang,
    responseFormat,
    serverDefaultConfigured: Boolean(baseUrl),
  };
}

async function loadStoredUserTtsConfig(env: Env, userId: string): Promise<StoredUserTtsConfig> {
  const raw = await getUserPref(env.DB, userId, TTS_USER_CONFIG_PREF_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};
    const sanitizedVoices = sanitizeTtsVoicesByLang(parsed.voicesByLang);
    return {
      mode: isTtsEngineMode(parsed.mode) ? parsed.mode : undefined,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
      apiKeyEncrypted: typeof parsed.apiKeyEncrypted === 'string' ? parsed.apiKeyEncrypted : null,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      voice: typeof parsed.voice === 'string' ? parsed.voice : undefined,
      ...(Object.keys(sanitizedVoices).length > 0 ? { voicesByLang: sanitizedVoices } : {}),
      responseFormat: isTtsResponseFormat(parsed.responseFormat) ? parsed.responseFormat : undefined,
    };
  } catch {
    return {};
  }
}

async function isActiveServerAdmin(db: Env['DB'], userId: string): Promise<boolean> {
  const user = await getUserById(db, userId);
  return Boolean(user && user.is_admin && isUserStatusActive(user.status));
}

function decryptStoredApiKey(stored: StoredUserTtsConfig, encryptionKey: string): string {
  if (!stored.apiKeyEncrypted) return '';
  if (!encryptionKey) {
    throw new Error('encryption_key_missing');
  }
  const decrypted = decryptBotConfig(stored.apiKeyEncrypted, encryptionKey);
  return typeof decrypted.apiKey === 'string' ? decrypted.apiKey : '';
}

function buildPublicTtsConfig(stored: StoredUserTtsConfig, env: Env, canConfigureEndpoint: boolean): TtsPublicConfig {
  const envDefaults = readEnvTtsDefaults(env);
  let userApiKey = '';
  if (canConfigureEndpoint && stored.apiKeyEncrypted && env.BOT_ENCRYPTION_KEY) {
    try {
      userApiKey = decryptStoredApiKey(stored, env.BOT_ENCRYPTION_KEY);
    } catch {
      userApiKey = '';
    }
  }
  const effectiveConfigured = canConfigureEndpoint
    ? Boolean(stored.baseUrl?.trim() || envDefaults.serverDefaultConfigured)
    : envDefaults.serverDefaultConfigured;
  const apiKeyFingerprint = canConfigureEndpoint && userApiKey
    ? createHash('sha256').update(userApiKey).digest('hex').slice(0, 16)
    : null;
  return {
    mode: stored.mode ?? (effectiveConfigured ? 'server' : 'system'),
    baseUrl: canConfigureEndpoint ? (stored.baseUrl ?? '') : '',
    hasApiKey: canConfigureEndpoint ? Boolean(userApiKey) : false,
    apiKeyMasked: canConfigureEndpoint ? maskTtsApiKey(userApiKey) : null,
    apiKeyFingerprint,
    canConfigureEndpoint,
    model: stored.model?.trim() || envDefaults.model,
    voice: stored.voice?.trim() || envDefaults.voice,
    voicesByLang: { ...envDefaults.voicesByLang, ...(stored.voicesByLang ?? {}) },
    responseFormat: stored.responseFormat ?? envDefaults.responseFormat,
    serverDefaultConfigured: envDefaults.serverDefaultConfigured,
  };
}

function resolveEffectiveUpstreamTarget(
  stored: StoredUserTtsConfig,
  env: Env,
  envDefaults: EnvTtsDefaults,
  canConfigureEndpoint: boolean,
): { effectiveBaseUrl: string; effectiveApiKey: string; decryptFailed: boolean } {
  if (!canConfigureEndpoint) {
    return {
      effectiveBaseUrl: envDefaults.baseUrl,
      effectiveApiKey: envDefaults.apiKey,
      decryptFailed: false,
    };
  }
  const userBaseUrl = stored.baseUrl?.trim() ?? '';
  const effectiveBaseUrl = userBaseUrl || envDefaults.baseUrl;
  let effectiveApiKey = '';
  if (stored.apiKeyEncrypted) {
    try {
      effectiveApiKey = decryptStoredApiKey(stored, env.BOT_ENCRYPTION_KEY);
    } catch {
      return { effectiveBaseUrl, effectiveApiKey: '', decryptFailed: true };
    }
  } else if (!userBaseUrl) {
    // Only fall back to admin TTS_API_KEY when using admin TTS_BASE_URL; never send server key to a user-supplied host.
    effectiveApiKey = envDefaults.apiKey;
  }
  return { effectiveBaseUrl, effectiveApiKey, decryptFailed: false };
}

function appendMissingCurrentVoice(voices: TtsVoiceOption[], currentVoice?: string): TtsVoiceOption[] {
  const trimmed = typeof currentVoice === 'string' ? currentVoice.trim() : '';
  if (!trimmed || voices.some((v) => v.id === trimmed)) {
    return voices;
  }
  return [{ id: trimmed, name: trimmed }, ...voices];
}

function buildPresetVoiceList(currentVoice?: string): TtsVoiceOption[] {
  const presets: TtsVoiceOption[] = TTS_OPENAI_PRESET_VOICES.map((id) => ({ id, name: id }));
  return appendMissingCurrentVoice(presets, currentVoice);
}

function normalizeVoiceEntry(raw: unknown): TtsVoiceOption | null {
  if (typeof raw === 'string') {
    const id = raw.trim();
    return id ? { id, name: id } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const idCandidate = rec.id ?? rec.ShortName ?? rec.short_name ?? rec.voice ?? rec.voice_id ?? rec.name;
  const id = typeof idCandidate === 'string' ? idCandidate.trim() : '';
  if (!id) return null;
  const nameCandidate = rec.name ?? rec.FriendlyName ?? rec.friendly_name ?? rec.displayName ?? rec.display_name;
  const localeCandidate = rec.locale ?? rec.Locale ?? rec.lang ?? rec.language;
  const genderCandidate = rec.gender ?? rec.Gender;
  const option: TtsVoiceOption = {
    id,
    name: typeof nameCandidate === 'string' && nameCandidate.trim() ? nameCandidate.trim() : id,
  };
  if (typeof localeCandidate === 'string' && localeCandidate.trim()) {
    option.locale = localeCandidate.trim();
  }
  if (typeof genderCandidate === 'string' && genderCandidate.trim()) {
    option.gender = genderCandidate.trim();
  }
  return option;
}

function normalizeUpstreamVoicesPayload(payload: unknown): TtsVoiceOption[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? (Array.isArray((payload as { voices?: unknown }).voices)
          ? (payload as { voices: unknown[] }).voices
          : Array.isArray((payload as { data?: unknown }).data)
            ? (payload as { data: unknown[] }).data
            : [])
      : [];
  const seen = new Set<string>();
  const out: TtsVoiceOption[] = [];
  for (const item of list) {
    const normalized = normalizeVoiceEntry(item);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }
  return out;
}

async function readResponseTextBounded(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function isAudioOrBinaryContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!normalized) return true;
  return normalized.startsWith('audio/') || normalized === 'application/octet-stream';
}

/** GET /api/tts/config — return current user TTS config without plaintext API key. */
ttsRoutes.get('/config', async (c) => {
  const userId = c.get('userId' as never) as string;
  const [stored, isAdmin] = await Promise.all([
    loadStoredUserTtsConfig(c.env, userId),
    isActiveServerAdmin(c.env.DB, userId),
  ]);
  return c.json(buildPublicTtsConfig(stored, c.env, isAdmin), 200, {
    'Cache-Control': 'no-store',
  });
});

/** PUT /api/tts/config — validate and persist per-user TTS config (custom endpoint/key restricted to active server admins). */
ttsRoutes.put('/config', async (c) => {
  const userId = c.get('userId' as never) as string;
  const body = await c.req.json().catch(() => null);
  const parsed = configUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  const isAdmin = await isActiveServerAdmin(c.env.DB, userId);
  const requestedCustomBaseUrl = (parsed.data.baseUrl?.trim().length ?? 0) > 0;
  const requestedCustomApiKey = (parsed.data.apiKey?.trim().length ?? 0) > 0;
  if (!isAdmin && (requestedCustomBaseUrl || requestedCustomApiKey)) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const existing = await loadStoredUserTtsConfig(c.env, userId);
  const next: StoredUserTtsConfig = { ...existing };

  if (parsed.data.mode !== undefined) {
    next.mode = parsed.data.mode;
  }

  if (!isAdmin) {
    // Clear any legacy per-user endpoint/key when non-admin saves with omitted or empty values.
    delete next.baseUrl;
    delete next.apiKeyEncrypted;
  } else {
    if (parsed.data.baseUrl !== undefined) {
      const trimmedBase = parsed.data.baseUrl.trim();
      if (!trimmedBase) {
        delete next.baseUrl;
      } else {
        const checked = validateTtsBaseUrl(trimmedBase);
        if (!checked.ok) {
          return c.json({ error: checked.error }, 400);
        }
        next.baseUrl = checked.url;
      }
    }

    if (parsed.data.apiKey !== undefined) {
      const trimmedKey = parsed.data.apiKey.trim();
      if (!trimmedKey) {
        next.apiKeyEncrypted = null;
      } else {
        if (!c.env.BOT_ENCRYPTION_KEY) {
          return c.json({ error: 'server_misconfigured' }, 500);
        }
        next.apiKeyEncrypted = encryptBotConfig({ apiKey: trimmedKey }, c.env.BOT_ENCRYPTION_KEY);
      }
    }
  }

  if (parsed.data.model !== undefined) {
    const trimmedModel = parsed.data.model.trim();
    if (!trimmedModel) {
      delete next.model;
    } else {
      next.model = trimmedModel;
    }
  }

  if (parsed.data.voice !== undefined) {
    const trimmedVoice = parsed.data.voice.trim();
    if (!trimmedVoice) {
      delete next.voice;
    } else {
      next.voice = trimmedVoice;
    }
  }

  if (parsed.data.voicesByLang !== undefined) {
    const mergedVoices: Record<string, string> = { ...(next.voicesByLang ?? {}) };
    for (const [rawKey, rawVoice] of Object.entries(parsed.data.voicesByLang)) {
      const key = normalizeTtsVoiceLangKey(rawKey);
      if (!key) continue;
      const trimmedVoice = rawVoice.trim();
      if (!trimmedVoice) {
        delete mergedVoices[key];
      } else {
        mergedVoices[key] = trimmedVoice;
      }
    }
    if (Object.keys(mergedVoices).length === 0) {
      delete next.voicesByLang;
    } else {
      next.voicesByLang = mergedVoices;
    }
  }

  if (parsed.data.responseFormat !== undefined) {
    next.responseFormat = parsed.data.responseFormat;
  }

  await setUserPref(c.env.DB, userId, TTS_USER_CONFIG_PREF_KEY, JSON.stringify(next));
  return c.json({ ok: true, config: buildPublicTtsConfig(next, c.env, isAdmin) }, 200, {
    'Cache-Control': 'no-store',
  });
});

/** GET /api/tts/voices — probe upstream OpenAI-compatible voice endpoints (with 6h upstream cache) or fall back to standard presets. */
ttsRoutes.get('/voices', async (c) => {
  const userId = c.get('userId' as never) as string;
  const [stored, isAdmin] = await Promise.all([
    loadStoredUserTtsConfig(c.env, userId),
    isActiveServerAdmin(c.env.DB, userId),
  ]);
  const envDefaults = readEnvTtsDefaults(c.env);
  const currentVoice = stored.voice?.trim() || envDefaults.voice;
  const { effectiveBaseUrl, effectiveApiKey, decryptFailed } = resolveEffectiveUpstreamTarget(stored, c.env, envDefaults, isAdmin);

  const respondPreset = (endpointConfigured: boolean) => {
    const body: TtsVoicesResponse = {
      voices: buildPresetVoiceList(currentVoice),
      source: 'preset',
      endpointConfigured,
    };
    return c.json(body, 200, { 'Cache-Control': 'no-store' });
  };

  if (!effectiveBaseUrl || decryptFailed) {
    return respondPreset(Boolean(effectiveBaseUrl));
  }

  const respondUpstream = (voices: TtsVoiceOption[]) => {
    const body: TtsVoicesResponse = {
      voices: appendMissingCurrentVoice(voices, currentVoice),
      source: 'upstream',
      endpointConfigured: true,
    };
    return c.json(body, 200, { 'Cache-Control': 'no-store' });
  };

  const cacheKey = upstreamVoicesCacheKey(effectiveBaseUrl, effectiveApiKey);
  const cachedEntry = upstreamVoicesCache.get(cacheKey);
  const forceRefresh = c.req.query('refresh') === '1';
  if (!forceRefresh && cachedEntry && (Date.now() - cachedEntry.fetchedAt) < TTS_VOICES_CACHE_TTL_MS) {
    return respondUpstream(cachedEntry.voices);
  }

  let endpoints: string[];
  try {
    endpoints = resolveOpenAiVoicesEndpoints(effectiveBaseUrl);
  } catch {
    return respondPreset(false);
  }

  const clientSignal = c.req.raw.signal;
  if (clientSignal?.aborted) {
    return c.json({ error: 'request_aborted' }, 499 as never);
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (effectiveApiKey) {
    headers.Authorization = `Bearer ${effectiveApiKey}`;
  }

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const onClientAbort = () => controller.abort(clientSignal?.reason ?? new Error('client_aborted'));
    clientSignal?.addEventListener('abort', onClientAbort, { once: true });
    const timeoutHandle = setTimeout(() => controller.abort(new Error('upstream_timeout')), TTS_VOICES_TIMEOUT_MS);
    try {
      const upstreamRes = await fetch(endpoint, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (upstreamRes.type === 'opaqueredirect' || (upstreamRes.status >= 300 && upstreamRes.status < 400)) {
        await upstreamRes.body?.cancel().catch(() => {});
        continue;
      }
      if (!upstreamRes.ok) {
        await upstreamRes.body?.cancel().catch(() => {});
        continue;
      }
      const lenHeader = upstreamRes.headers.get('content-length');
      if (lenHeader) {
        const len = Number(lenHeader);
        if (Number.isFinite(len) && len > TTS_VOICES_MAX_RESPONSE_BYTES) {
          await upstreamRes.body?.cancel().catch(() => {});
          continue;
        }
      }
      const rawText = await readResponseTextBounded(upstreamRes, TTS_VOICES_MAX_RESPONSE_BYTES);
      if (!rawText) continue;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawText);
      } catch {
        continue;
      }
      const normalized = normalizeUpstreamVoicesPayload(parsedJson);
      if (normalized.length > 0) {
        upstreamVoicesCache.set(cacheKey, { voices: normalized, fetchedAt: Date.now() });
        return respondUpstream(normalized);
      }
    } catch {
      if (clientSignal?.aborted) {
        return c.json({ error: 'request_aborted' }, 499 as never);
      }
    } finally {
      clearTimeout(timeoutHandle);
      clientSignal?.removeEventListener('abort', onClientAbort);
    }
  }

  if (cachedEntry && cachedEntry.voices.length > 0) {
    return respondUpstream(cachedEntry.voices);
  }
  return respondPreset(true);
});

/** POST /api/tts/speech — proxy text to the configured OpenAI-compatible /v1/audio/speech endpoint. */
ttsRoutes.post('/speech', async (c) => {
  const userId = c.get('userId' as never) as string;
  const rawBody = await c.req.json().catch(() => null);
  const parsed = speechRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  const inputText = parsed.data.input.trim();
  if (!inputText) {
    return c.json({ error: 'empty_input' }, 400);
  }

  const [stored, isAdmin] = await Promise.all([
    loadStoredUserTtsConfig(c.env, userId),
    isActiveServerAdmin(c.env.DB, userId),
  ]);
  const envDefaults = readEnvTtsDefaults(c.env);
  const { effectiveBaseUrl, effectiveApiKey, decryptFailed } = resolveEffectiveUpstreamTarget(stored, c.env, envDefaults, isAdmin);
  if (!effectiveBaseUrl) {
    return c.json({ error: 'tts_not_configured' }, 400);
  }
  if (decryptFailed) {
    return c.json({ error: 'tts_config_decrypt_failed' }, 500);
  }

  let endpoint: string;
  try {
    endpoint = resolveOpenAiSpeechEndpoint(effectiveBaseUrl);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'invalid_base_url' }, 400);
  }

  const responseFormat: TtsResponseFormat =
    parsed.data.response_format ?? stored.responseFormat ?? envDefaults.responseFormat;
  const fallbackVoice = stored.voice?.trim() || envDefaults.voice;
  const mergedVoicesByLang = { ...envDefaults.voicesByLang, ...(stored.voicesByLang ?? {}) };
  const resolvedVoice =
    parsed.data.voice?.trim()
    || resolveServerTtsVoiceForLang({
      lang: parsed.data.lang,
      voicesByLang: mergedVoicesByLang,
      fallbackVoice,
    });
  const upstreamPayload: Record<string, unknown> = {
    model: parsed.data.model?.trim() || stored.model?.trim() || envDefaults.model,
    input: inputText,
    voice: resolvedVoice,
    response_format: responseFormat,
  };
  if (parsed.data.speed !== undefined) {
    upstreamPayload.speed = clampTtsServerSpeed(parsed.data.speed);
  }
  if (parsed.data.instructions?.trim()) {
    upstreamPayload.instructions = parsed.data.instructions.trim();
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'audio/*, application/octet-stream',
  };
  if (effectiveApiKey) {
    headers.Authorization = `Bearer ${effectiveApiKey}`;
  }

  const controller = new AbortController();
  let timedOut = false;
  let clientAborted = false;
  const clientSignal = c.req.raw.signal;
  const onClientAbort = () => {
    clientAborted = true;
    controller.abort(clientSignal?.reason ?? new Error('client_aborted'));
  };

  if (clientSignal?.aborted) {
    return c.json({ error: 'request_aborted' }, 499 as never);
  }
  clientSignal?.addEventListener('abort', onClientAbort, { once: true });

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('upstream_timeout'));
  }, TTS_REQUEST_TIMEOUT_MS);

  const cleanupListeners = () => {
    clearTimeout(timeoutHandle);
    clientSignal?.removeEventListener('abort', onClientAbort);
  };

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamPayload),
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    cleanupListeners();
    if (clientAborted) {
      return c.json({ error: 'request_aborted' }, 499 as never);
    }
    if (timedOut) {
      logger.warn({ userId }, 'tts speech upstream request timed out');
      return c.json({ error: 'upstream_timeout' }, 504);
    }
    logger.warn({ userId, err: err instanceof Error ? err.message : 'fetch_failed' }, 'tts speech upstream fetch failed');
    return c.json({ error: 'upstream_unreachable' }, 502);
  }

  if (upstreamRes.type === 'opaqueredirect' || (upstreamRes.status >= 300 && upstreamRes.status < 400)) {
    cleanupListeners();
    await upstreamRes.body?.cancel().catch(() => {});
    return c.json({ error: 'upstream_redirect_blocked' }, 502);
  }

  if (!upstreamRes.ok) {
    cleanupListeners();
    await upstreamRes.body?.cancel().catch(() => {});
    logger.warn({ userId, upstreamStatus: upstreamRes.status }, 'tts speech upstream returned error status');
    const status = upstreamRes.status === 429 ? 429 : 502;
    return c.json({ error: 'upstream_tts_error', upstreamStatus: upstreamRes.status }, status);
  }

  const contentLengthHeader = upstreamRes.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > TTS_MAX_RESPONSE_BYTES) {
      cleanupListeners();
      await upstreamRes.body?.cancel().catch(() => {});
      return c.json({ error: 'upstream_response_too_large' }, 502);
    }
  }

  const upstreamContentType = upstreamRes.headers.get('content-type');
  if (!isAudioOrBinaryContentType(upstreamContentType)) {
    cleanupListeners();
    await upstreamRes.body?.cancel().catch(() => {});
    return c.json({ error: 'invalid_upstream_content_type' }, 502);
  }

  const responseContentType = upstreamContentType?.trim() || ttsAudioContentType(responseFormat);
  if (!upstreamRes.body) {
    cleanupListeners();
    return c.json({ error: 'upstream_empty_body' }, 502);
  }

  const reader = upstreamRes.body.getReader();
  let totalBytes = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanupListeners();
          streamController.close();
          return;
        }
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > TTS_MAX_RESPONSE_BYTES) {
            cleanupListeners();
            await reader.cancel().catch(() => {});
            streamController.error(new Error('upstream_response_too_large'));
            return;
          }
          streamController.enqueue(value);
        }
      } catch (err) {
        cleanupListeners();
        streamController.error(err);
      }
    },
    async cancel(reason) {
      cleanupListeners();
      await reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': responseContentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
