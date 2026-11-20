import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import { getUserPref, setUserPref } from '../db/queries.js';
import { requireAuth } from '../security/authorization.js';
import { decryptBotConfig, encryptBotConfig } from '../security/crypto.js';
import logger from '../util/logger.js';
import {
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_RESPONSE_FORMAT,
  TTS_DEFAULT_VOICE,
  TTS_ENGINES,
  TTS_MAX_INPUT_CHARS,
  TTS_MAX_RESPONSE_BYTES,
  TTS_REQUEST_TIMEOUT_MS,
  TTS_RESPONSE_FORMATS,
  TTS_USER_CONFIG_PREF_KEY,
  clampTtsServerSpeed,
  isTtsEngineMode,
  isTtsResponseFormat,
  maskTtsApiKey,
  resolveOpenAiSpeechEndpoint,
  ttsAudioContentType,
  validateTtsBaseUrl,
  type TtsEngineMode,
  type TtsPublicConfig,
  type TtsResponseFormat,
} from '../../../shared/tts-config.js';

export const ttsRoutes = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

ttsRoutes.use('/*', requireAuth());

interface StoredUserTtsConfig {
  mode?: TtsEngineMode;
  baseUrl?: string;
  apiKeyEncrypted?: string | null;
  model?: string;
  voice?: string;
  responseFormat?: TtsResponseFormat;
}

interface EnvTtsDefaults {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  responseFormat: TtsResponseFormat;
  serverDefaultConfigured: boolean;
}

const configUpdateSchema = z.object({
  mode: z.enum(TTS_ENGINES).optional(),
  baseUrl: z.string().max(2048).optional(),
  apiKey: z.string().max(4096).optional(),
  model: z.string().max(256).optional(),
  voice: z.string().max(256).optional(),
  responseFormat: z.enum(TTS_RESPONSE_FORMATS).optional(),
});

const speechRequestSchema = z.object({
  input: z.string().max(TTS_MAX_INPUT_CHARS),
  model: z.string().max(256).optional(),
  voice: z.string().max(256).optional(),
  speed: z.number().finite().optional(),
  response_format: z.enum(TTS_RESPONSE_FORMATS).optional(),
  instructions: z.string().max(1024).optional(),
});

function readEnvTtsDefaults(env: Env): EnvTtsDefaults {
  const rawBaseUrl = (env.TTS_BASE_URL ?? '').trim();
  const validatedBase = rawBaseUrl ? validateTtsBaseUrl(rawBaseUrl) : null;
  const baseUrl = validatedBase?.ok ? validatedBase.url : '';
  const apiKey = (env.TTS_API_KEY ?? '').trim();
  const model = (env.TTS_MODEL ?? '').trim() || TTS_DEFAULT_MODEL;
  const voice = (env.TTS_VOICE ?? '').trim() || TTS_DEFAULT_VOICE;
  const rawFmt = (env.TTS_RESPONSE_FORMAT ?? '').trim();
  const responseFormat = isTtsResponseFormat(rawFmt) ? rawFmt : TTS_DEFAULT_RESPONSE_FORMAT;
  return {
    baseUrl,
    apiKey,
    model,
    voice,
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
    return {
      mode: isTtsEngineMode(parsed.mode) ? parsed.mode : undefined,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
      apiKeyEncrypted: typeof parsed.apiKeyEncrypted === 'string' ? parsed.apiKeyEncrypted : null,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      voice: typeof parsed.voice === 'string' ? parsed.voice : undefined,
      responseFormat: isTtsResponseFormat(parsed.responseFormat) ? parsed.responseFormat : undefined,
    };
  } catch {
    return {};
  }
}

function decryptStoredApiKey(stored: StoredUserTtsConfig, encryptionKey: string): string {
  if (!stored.apiKeyEncrypted) return '';
  if (!encryptionKey) {
    throw new Error('encryption_key_missing');
  }
  const decrypted = decryptBotConfig(stored.apiKeyEncrypted, encryptionKey);
  return typeof decrypted.apiKey === 'string' ? decrypted.apiKey : '';
}

function buildPublicTtsConfig(stored: StoredUserTtsConfig, env: Env): TtsPublicConfig {
  const envDefaults = readEnvTtsDefaults(env);
  let userApiKey = '';
  if (stored.apiKeyEncrypted && env.BOT_ENCRYPTION_KEY) {
    try {
      userApiKey = decryptStoredApiKey(stored, env.BOT_ENCRYPTION_KEY);
    } catch {
      userApiKey = '';
    }
  }
  return {
    mode: stored.mode ?? 'system',
    baseUrl: stored.baseUrl ?? '',
    hasApiKey: Boolean(userApiKey),
    apiKeyMasked: maskTtsApiKey(userApiKey),
    model: stored.model?.trim() || envDefaults.model,
    voice: stored.voice?.trim() || envDefaults.voice,
    responseFormat: stored.responseFormat ?? envDefaults.responseFormat,
    serverDefaultConfigured: envDefaults.serverDefaultConfigured,
  };
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
  const stored = await loadStoredUserTtsConfig(c.env, userId);
  return c.json(buildPublicTtsConfig(stored, c.env), 200, {
    'Cache-Control': 'no-store',
  });
});

/** PUT /api/tts/config — validate and persist per-user TTS config (API key encrypted at rest). */
ttsRoutes.put('/config', async (c) => {
  const userId = c.get('userId' as never) as string;
  const body = await c.req.json().catch(() => null);
  const parsed = configUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  const existing = await loadStoredUserTtsConfig(c.env, userId);
  const next: StoredUserTtsConfig = { ...existing };

  if (parsed.data.mode !== undefined) {
    next.mode = parsed.data.mode;
  }

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

  if (parsed.data.responseFormat !== undefined) {
    next.responseFormat = parsed.data.responseFormat;
  }

  await setUserPref(c.env.DB, userId, TTS_USER_CONFIG_PREF_KEY, JSON.stringify(next));
  return c.json({ ok: true, config: buildPublicTtsConfig(next, c.env) }, 200, {
    'Cache-Control': 'no-store',
  });
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

  const stored = await loadStoredUserTtsConfig(c.env, userId);
  const envDefaults = readEnvTtsDefaults(c.env);
  const userBaseUrl = stored.baseUrl?.trim() ?? '';
  const effectiveBaseUrl = userBaseUrl || envDefaults.baseUrl;
  if (!effectiveBaseUrl) {
    return c.json({ error: 'tts_not_configured' }, 400);
  }

  let endpoint: string;
  try {
    endpoint = resolveOpenAiSpeechEndpoint(effectiveBaseUrl);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'invalid_base_url' }, 400);
  }

  let effectiveApiKey = '';
  if (stored.apiKeyEncrypted) {
    try {
      effectiveApiKey = decryptStoredApiKey(stored, c.env.BOT_ENCRYPTION_KEY);
    } catch {
      return c.json({ error: 'tts_config_decrypt_failed' }, 500);
    }
  } else if (!userBaseUrl) {
    // Only fall back to admin TTS_API_KEY when using admin TTS_BASE_URL; never send server key to a user-supplied host.
    effectiveApiKey = envDefaults.apiKey;
  }

  const responseFormat: TtsResponseFormat =
    parsed.data.response_format ?? stored.responseFormat ?? envDefaults.responseFormat;
  const upstreamPayload: Record<string, unknown> = {
    model: parsed.data.model?.trim() || stored.model?.trim() || envDefaults.model,
    input: inputText,
    voice: parsed.data.voice?.trim() || stored.voice?.trim() || envDefaults.voice,
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
