export const TTS_API_BASE = '/api/tts';
export const TTS_CONFIG_PATH = `${TTS_API_BASE}/config`;
export const TTS_SPEECH_PATH = `${TTS_API_BASE}/speech`;
export const TTS_VOICES_PATH = `${TTS_API_BASE}/voices`;

/**
 * Reserved user_preferences key holding AES-256-GCM encrypted TTS settings.
 * Blocked from generic /api/preferences/:key routes so ciphertext and config
 * cannot be read or overwritten outside /api/tts/config.
 */
export const TTS_USER_CONFIG_PREF_KEY = 'imcodes.server.tts.config';

export const TTS_ENGINES = ['system', 'server'] as const;
export type TtsEngineMode = (typeof TTS_ENGINES)[number];

export const TTS_RESPONSE_FORMATS = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] as const;
export type TtsResponseFormat = (typeof TTS_RESPONSE_FORMATS)[number];

export const TTS_OPENAI_PRESET_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
] as const;

export const TTS_VOICE_LANG_KEYS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es', 'ru'] as const;
export type TtsVoiceLangKey = (typeof TTS_VOICE_LANG_KEYS)[number];

export const TTS_DEFAULT_MODEL = 'gpt-4o-mini-tts';
export const TTS_DEFAULT_VOICE = 'alloy';
export const TTS_DEFAULT_RESPONSE_FORMAT: TtsResponseFormat = 'mp3';
export const TTS_MAX_INPUT_CHARS = 4096;
export const TTS_MIN_SPEED = 0.25;
export const TTS_MAX_SPEED = 4.0;
export const TTS_DEFAULT_SPEED = 1.0;
export const TTS_REQUEST_TIMEOUT_MS = 25_000;
export const TTS_MAX_RESPONSE_BYTES = 15 * 1024 * 1024;
export const TTS_VOICES_TIMEOUT_MS = 15_000;
export const TTS_VOICES_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const TTS_VOICES_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface TtsVoiceOption {
  id: string;
  name?: string;
  locale?: string;
  gender?: string;
}

export interface TtsVoicesResponse {
  voices: TtsVoiceOption[];
  source: 'upstream' | 'preset';
  endpointConfigured: boolean;
}

export interface TtsPublicConfig {
  mode: TtsEngineMode;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  apiKeyFingerprint?: string | null;
  model: string;
  voice: string;
  voicesByLang?: Record<string, string>;
  responseFormat: TtsResponseFormat;
  serverDefaultConfigured: boolean;
}

export interface TtsConfigUpdateBody {
  mode?: TtsEngineMode;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  voice?: string;
  voicesByLang?: Record<string, string>;
  responseFormat?: TtsResponseFormat;
}

export interface TtsSpeechRequestBody {
  input: string;
  model?: string;
  voice?: string;
  lang?: string;
  speed?: number;
  response_format?: TtsResponseFormat;
  instructions?: string;
}

const PREFERRED_VOICE_LOCALE_BY_KEY: Record<TtsVoiceLangKey, string> = {
  'zh-CN': 'zh-cn',
  'zh-TW': 'zh-tw',
  en: 'en-us',
  ja: 'ja-jp',
  ko: 'ko-kr',
  es: 'es-es',
  ru: 'ru-ru',
};

/** Map arbitrary BCP-47 / short language tags into the 7 canonical per-language voice keys. */
export function normalizeTtsVoiceLangKey(lang?: string | null): TtsVoiceLangKey | null {
  if (typeof lang !== 'string') return null;
  const raw = lang.trim().replace(/_/g, '-').toLowerCase();
  if (!raw) return null;
  const parts = raw.split('-').filter(Boolean);
  const primary = parts[0];
  if (!primary) return null;
  if (primary === 'zh') {
    if (parts.includes('tw') || parts.includes('hk') || parts.includes('mo') || parts.includes('hant')) {
      return 'zh-TW';
    }
    return 'zh-CN';
  }
  if (primary === 'en') return 'en';
  if (primary === 'ja') return 'ja';
  if (primary === 'ko') return 'ko';
  if (primary === 'es') return 'es';
  if (primary === 'ru') return 'ru';
  return null;
}

/** Normalize and bound a user/env per-language voice map, dropping empty or unknown entries. */
export function sanitizeTtsVoicesByLang(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, string> = {};
  let inspected = 0;
  for (const [rawKey, rawVal] of Object.entries(raw as Record<string, unknown>)) {
    if (++inspected > 32) break;
    const normKey = normalizeTtsVoiceLangKey(rawKey);
    if (!normKey || typeof rawVal !== 'string') continue;
    const voice = rawVal.trim().slice(0, 256);
    if (!voice) continue;
    result[normKey] = voice;
  }
  return result;
}

/**
 * Resolve the upstream voice for a speech segment:
 * explicit `voicesByLang` override -> matching `fallbackVoice` locale -> best localized upstream voice -> `fallbackVoice`.
 */
export function resolveServerTtsVoiceForLang(params: {
  lang?: string | null;
  voicesByLang?: Record<string, string> | null;
  availableVoices?: readonly TtsVoiceOption[] | null;
  fallbackVoice?: string | null;
}): string {
  const fallback = (typeof params.fallbackVoice === 'string' ? params.fallbackVoice.trim() : '') || TTS_DEFAULT_VOICE;
  const rawLang = typeof params.lang === 'string' ? params.lang.trim() : '';
  if (!rawLang) return fallback;

  const normKey = normalizeTtsVoiceLangKey(rawLang);
  const overrides = params.voicesByLang;
  if (overrides && typeof overrides === 'object') {
    const exactOverride = overrides[rawLang]?.trim();
    if (exactOverride) return exactOverride;
    if (normKey) {
      const normalizedOverride = overrides[normKey]?.trim();
      if (normalizedOverride) return normalizedOverride;
      for (const [k, v] of Object.entries(overrides)) {
        if (normalizeTtsVoiceLangKey(k) === normKey && typeof v === 'string' && v.trim()) {
          return v.trim();
        }
      }
    }
  }

  const voices = Array.isArray(params.availableVoices) ? params.availableVoices : [];
  if (!normKey || voices.length === 0) return fallback;

  const fallbackEntry = voices.find((v) => v.id?.trim() === fallback && v.locale && normalizeTtsVoiceLangKey(v.locale) === normKey);
  if (fallbackEntry) return fallback;

  const normalizedRawTag = rawLang.replace(/_/g, '-').toLowerCase();
  const exactTagMatch = voices.find(
    (v) => v.locale && v.locale.trim().replace(/_/g, '-').toLowerCase() === normalizedRawTag && v.id?.trim(),
  );
  if (exactTagMatch) return exactTagMatch.id.trim();

  const preferredTag = PREFERRED_VOICE_LOCALE_BY_KEY[normKey];
  const preferredMatch = voices.find(
    (v) => v.locale && v.locale.trim().replace(/_/g, '-').toLowerCase() === preferredTag && v.id?.trim(),
  );
  if (preferredMatch) return preferredMatch.id.trim();

  const familyMatch = voices.find(
    (v) => v.locale && normalizeTtsVoiceLangKey(v.locale) === normKey && v.id?.trim(),
  );
  if (familyMatch) return familyMatch.id.trim();

  return fallback;
}

export type TtsBaseUrlValidationResult =
  | { ok: true; url: string }
  | {
    ok: false;
    error:
      | 'empty_base_url'
      | 'invalid_base_url'
      | 'unsupported_protocol'
      | 'embedded_credentials'
      | 'forbidden_host';
  };

const METADATA_HOSTNAMES = new Set([
  '169.254.169.254',
  '100.100.100.200',
  'metadata.google.internal',
  'metadata.goog',
  'fd00:ec2::254',
]);

export function isTtsEngineMode(value: unknown): value is TtsEngineMode {
  return value === 'system' || value === 'server';
}

export function isTtsResponseFormat(value: unknown): value is TtsResponseFormat {
  return typeof value === 'string' && (TTS_RESPONSE_FORMATS as readonly string[]).includes(value);
}

export function clampTtsServerSpeed(speed: unknown): number {
  const num = typeof speed === 'number' ? speed : Number(speed);
  if (!Number.isFinite(num)) return TTS_DEFAULT_SPEED;
  return Math.min(TTS_MAX_SPEED, Math.max(TTS_MIN_SPEED, num));
}

export function maskTtsApiKey(apiKey: string | null | undefined): string | null {
  const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!trimmed) return null;
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function normalizeHostnameForCheck(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  const zoneIdx = host.indexOf('%');
  if (zoneIdx !== -1) {
    host = host.slice(0, zoneIdx);
  }
  return host;
}

function isForbiddenMetadataHost(rawHostname: string): boolean {
  const host = normalizeHostnameForCheck(rawHostname);
  if (!host) return true;
  if (METADATA_HOSTNAMES.has(host)) return true;
  // Block link-local IPv4 (169.254.0.0/16) and IPv4-mapped IPv6 forms (::ffff:169.254.169.254 / ::ffff:a9fe:a9fe).
  if (host.startsWith('169.254.')) return true;
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice('::ffff:'.length);
    if (mapped === 'a9fe:a9fe' || mapped.startsWith('a9fe:') || mapped.startsWith('169.254.')) {
      return true;
    }
  }
  return false;
}

/**
 * Validate and normalize a user- or env-configured OpenAI-compatible TTS base URL.
 * Allows http:/https: including localhost and private LAN hosts for self-hosted engines,
 * while rejecting non-HTTP schemes, embedded credentials, and cloud metadata endpoints.
 */
export function validateTtsBaseUrl(rawUrl: string): TtsBaseUrlValidationResult {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed) {
    return { ok: false, error: 'empty_base_url' };
  }
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, error: 'invalid_base_url' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'invalid_base_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'unsupported_protocol' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'embedded_credentials' };
  }
  if (!parsed.hostname) {
    return { ok: false, error: 'invalid_base_url' };
  }
  if (isForbiddenMetadataHost(parsed.hostname)) {
    return { ok: false, error: 'forbidden_host' };
  }
  if (parsed.hash) {
    return { ok: false, error: 'invalid_base_url' };
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return {
    ok: true,
    url: `${parsed.origin}${cleanPath}${parsed.search}`,
  };
}

function normalizeOpenAiApiPrefix(baseUrl: string): { origin: string; apiPrefix: string; search: string } {
  const validated = validateTtsBaseUrl(baseUrl);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  const parsed = new URL(validated.url);
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  const lowerPath = cleanPath.toLowerCase();
  let apiPrefix: string;
  if (lowerPath.endsWith('/audio/speech')) {
    apiPrefix = cleanPath.slice(0, -'/audio/speech'.length);
  } else if (lowerPath.endsWith('/v1')) {
    apiPrefix = cleanPath;
  } else {
    apiPrefix = `${cleanPath}/v1`;
  }
  return { origin: parsed.origin, apiPrefix, search: parsed.search };
}

/**
 * Normalize an OpenAI-compatible TTS base URL into the final `/v1/audio/speech` endpoint
 * without doubling `/v1` or `/audio/speech`.
 */
export function resolveOpenAiSpeechEndpoint(baseUrl: string): string {
  const { origin, apiPrefix, search } = normalizeOpenAiApiPrefix(baseUrl);
  return `${origin}${apiPrefix}/audio/speech${search}`;
}

/**
 * Resolve standard OpenAI-compatible voice discovery endpoints (`/v1/audio/voices`,
 * `/v1/voices`) from a configured TTS base URL without doubling path prefixes.
 */
export function resolveOpenAiVoicesEndpoints(baseUrl: string): string[] {
  const { origin, apiPrefix, search } = normalizeOpenAiApiPrefix(baseUrl);
  return Array.from(new Set([
    `${origin}${apiPrefix}/audio/voices${search}`,
    `${origin}${apiPrefix}/voices${search}`,
  ]));
}

export function ttsAudioContentType(format: TtsResponseFormat): string {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    case 'opus':
      return 'audio/opus';
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'wav':
      return 'audio/wav';
    case 'pcm':
      return 'audio/pcm';
  }
}
