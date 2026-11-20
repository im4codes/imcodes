export const TTS_API_BASE = '/api/tts';
export const TTS_CONFIG_PATH = `${TTS_API_BASE}/config`;
export const TTS_SPEECH_PATH = `${TTS_API_BASE}/speech`;

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

export const TTS_DEFAULT_MODEL = 'gpt-4o-mini-tts';
export const TTS_DEFAULT_VOICE = 'alloy';
export const TTS_DEFAULT_RESPONSE_FORMAT: TtsResponseFormat = 'mp3';
export const TTS_MAX_INPUT_CHARS = 4096;
export const TTS_MIN_SPEED = 0.25;
export const TTS_MAX_SPEED = 4.0;
export const TTS_DEFAULT_SPEED = 1.0;
export const TTS_REQUEST_TIMEOUT_MS = 25_000;
export const TTS_MAX_RESPONSE_BYTES = 15 * 1024 * 1024;

export interface TtsPublicConfig {
  mode: TtsEngineMode;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  model: string;
  voice: string;
  responseFormat: TtsResponseFormat;
  serverDefaultConfigured: boolean;
}

export interface TtsConfigUpdateBody {
  mode?: TtsEngineMode;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  voice?: string;
  responseFormat?: TtsResponseFormat;
}

export interface TtsSpeechRequestBody {
  input: string;
  model?: string;
  voice?: string;
  speed?: number;
  response_format?: TtsResponseFormat;
  instructions?: string;
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

/**
 * Normalize an OpenAI-compatible TTS base URL into the final `/v1/audio/speech` endpoint
 * without doubling `/v1` or `/audio/speech`.
 */
export function resolveOpenAiSpeechEndpoint(baseUrl: string): string {
  const validated = validateTtsBaseUrl(baseUrl);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  const parsed = new URL(validated.url);
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  const lowerPath = cleanPath.toLowerCase();
  let targetPath: string;
  if (lowerPath.endsWith('/audio/speech')) {
    targetPath = cleanPath;
  } else if (lowerPath.endsWith('/v1')) {
    targetPath = `${cleanPath}/audio/speech`;
  } else {
    targetPath = `${cleanPath}/v1/audio/speech`;
  }
  return `${parsed.origin}${targetPath}${parsed.search}`;
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
