import { maskTtsApiKey, validateTtsBaseUrl, type TtsBaseUrlValidationResult } from './tts-config.js';
import { formatVoiceHotwordsContext, sanitizeRemoteVoiceHotwords } from './voice-hotwords.js';

export const REMOTE_VOICE_WS_PATH = '/api/ws/voice-relay';
export const REMOTE_VOICE_API_PREFIX = '/api/voice';
export const REMOTE_VOICE_WS_TICKET_TYPE = 'remote_voice_ws';
export const REMOTE_VOICE_PRIMARY_PROVIDER_PREF_KEY = 'remote_voice_primary_provider_v1';
export const REMOTE_VOICE_PROVIDER_NICKNAMES_PREF_KEY = 'remote_voice_provider_nicknames_v1';
export const REMOTE_VOICE_SERVER_SHARED_SETTING_KEY = 'remote_voice_server_shared_providers_v1';
export const REMOTE_VOICE_SERVER_ASR_SERVICES_SETTING_KEY = 'remote_voice_server_asr_services_v1';
export const REMOTE_VOICE_ENV_ASR_DEVICE_ID = 'env-default';

export type RemoteVoiceShareScope = 'account' | 'server';
export type RemoteVoiceProviderKind = 'pc_app' | 'http_asr';

export const REMOTE_VOICE_MAX_PCM_CHUNK_BYTES = 64 * 1024;
export const REMOTE_VOICE_HTTP_ASR_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const REMOTE_VOICE_HTTP_ASR_TIMEOUT_MS = 25_000;
export const REMOTE_VOICE_HTTP_ASR_MAX_RESPONSE_BYTES = 1024 * 1024;
export const REMOTE_VOICE_MAX_SERVER_ASR_SERVICES = 16;
export const REMOTE_VOICE_MAX_NICKNAME_CHARS = 64;
export const REMOTE_VOICE_MAX_SESSION_DURATION_MS = 10 * 60 * 1000;
export const REMOTE_VOICE_SESSION_READY_TIMEOUT_MS = 3_000;
export const REMOTE_VOICE_SESSION_IDLE_TIMEOUT_MS = 15_000;
export const REMOTE_VOICE_SAMPLE_RATE = 16_000;

export const REMOTE_VOICE_SAFE_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

export const REMOTE_VOICE_MODEL_LABELS = {
  'qwen3-1.7b': 'Qwen3-ASR 1.7B',
  'qwen3-0.6b': 'Qwen3-ASR 0.6B',
} as const;

export type RemoteVoiceModelId = keyof typeof REMOTE_VOICE_MODEL_LABELS;
export type RemoteVoiceModelLabel = (typeof REMOTE_VOICE_MODEL_LABELS)[RemoteVoiceModelId];

export const REMOTE_VOICE_ERROR_CODES = {
  PROVIDER_OFFLINE: 'provider_offline',
  PROVIDER_NOT_READY: 'provider_not_ready',
  PROVIDER_BUSY: 'provider_busy',
  INVALID_FRAME: 'invalid_frame',
  CHUNK_TOO_LARGE: 'chunk_too_large',
  SESSION_TIMEOUT: 'session_timeout',
  SESSION_NOT_FOUND: 'session_not_found',
  UNAUTHORIZED: 'unauthorized',
  HELPER_ERROR: 'helper_error',
  UPSTREAM_ERROR: 'upstream_error',
} as const;

export type RemoteVoiceErrorCode =
  (typeof REMOTE_VOICE_ERROR_CODES)[keyof typeof REMOTE_VOICE_ERROR_CODES];

export const REMOTE_VOICE_ALLOWED_ERROR_CODES = new Set<string>(Object.values(REMOTE_VOICE_ERROR_CODES));

export interface RemoteVoiceProviderInfo {
  deviceId: string;
  deviceName?: string;
  displayName: string;
  model: string;
  modelLabel: string;
  ready: boolean;
  busy: boolean;
  shareScope: RemoteVoiceShareScope;
  providerKind?: RemoteVoiceProviderKind;
  isOwnDevice: boolean;
  customNickname?: string | null;
}

export { formatVoiceHotwordsContext, sanitizeRemoteVoiceHotwords };

export type RemoteVoiceServerAsrSource = 'admin' | 'env';

export interface RemoteVoiceServerAsrServicePublic {
  id: string;
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  model: string;
  enabled: boolean;
  source: RemoteVoiceServerAsrSource;
}

export interface RemoteVoiceServerAsrServiceInput {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  enabled?: boolean;
}

export interface RemoteVoiceServerAsrServicesResponse {
  services: RemoteVoiceServerAsrServicePublic[];
  envDefault: RemoteVoiceServerAsrServicePublic | null;
  encryptionAvailable: boolean;
}

export interface RemoteVoiceServerSharedEntry {
  ownerUserId: string;
  deviceId: string;
  nickname?: string;
}

export interface RemoteVoiceProvidersSnapshot {
  primaryDeviceId: string | null;
  canManageServerSharing: boolean;
  canShareOwnProviderToServer?: boolean;
  providers: RemoteVoiceProviderInfo[];
}

export type RemoteVoiceProviderRegisterFrame = {
  type: 'voice.provider.register';
  deviceId: string;
  deviceName?: string;
  hostname?: string;
  localServerId?: string;
  model: RemoteVoiceModelId;
  modelLabel: RemoteVoiceModelLabel;
  ready: boolean;
  busy?: boolean;
};

export type RemoteVoiceSessionReadyFrame = {
  type: 'voice.session.ready';
  sessionId: string;
};

export type RemoteVoiceSessionResultFrame = {
  type: 'voice.session.result';
  sessionId: string;
  text: string;
  isFinal: boolean;
};

export type RemoteVoiceSessionEndFrame = {
  type: 'voice.session.end';
  sessionId: string;
};

export type RemoteVoiceSessionErrorFrame = {
  type: 'voice.session.error';
  sessionId: string;
  code: RemoteVoiceErrorCode;
  message?: string;
};

export type RemoteVoiceSessionStartFrame = {
  type: 'voice.session.start';
  sessionId: string;
  targetDeviceId: string;
  locale?: string;
  sampleRate: number;
  hotwords?: string[];
};

export type RemoteVoiceSessionAudioFrame = {
  type: 'voice.session.audio';
  sessionId: string;
  pcmBase64: string;
};

export type RemoteVoiceSessionStopFrame = {
  type: 'voice.session.stop';
  sessionId: string;
};

export type RemoteVoiceSessionAbortFrame = {
  type: 'voice.session.abort';
  sessionId: string;
};

export type RemoteVoiceProvidersUpdatedFrame = {
  type: 'voice.providers.updated';
  providers: RemoteVoiceProviderInfo[];
};

export type RemoteVoicePingFrame = { type: 'ping' };
export type RemoteVoicePongFrame = { type: 'pong' };
export type RemoteVoiceProviderPingFrame = { type: 'voice.provider.ping' };
export type RemoteVoiceProviderPongFrame = { type: 'voice.provider.pong' };

export type RemoteVoiceInboundFrame =
  | RemoteVoiceProviderRegisterFrame
  | RemoteVoiceProviderPongFrame
  | RemoteVoiceSessionReadyFrame
  | RemoteVoiceSessionResultFrame
  | RemoteVoiceSessionEndFrame
  | RemoteVoiceSessionErrorFrame
  | RemoteVoiceSessionStartFrame
  | RemoteVoiceSessionAudioFrame
  | RemoteVoiceSessionStopFrame
  | RemoteVoiceSessionAbortFrame
  | RemoteVoicePingFrame;

export type RemoteVoiceForwardedToProviderFrame =
  | { type: 'voice.session.start'; sessionId: string; locale?: string; sampleRate: number; hotwords?: string[] }
  | RemoteVoiceSessionAudioFrame
  | RemoteVoiceSessionStopFrame
  | RemoteVoiceSessionAbortFrame;

export type RemoteVoiceForwardedToClientFrame =
  | RemoteVoiceSessionReadyFrame
  | RemoteVoiceSessionResultFrame
  | RemoteVoiceSessionEndFrame
  | RemoteVoiceSessionErrorFrame;

export type RemoteVoiceServerFrame =
  | RemoteVoiceForwardedToProviderFrame
  | RemoteVoiceForwardedToClientFrame
  | RemoteVoiceProvidersUpdatedFrame
  | RemoteVoiceProviderPingFrame
  | RemoteVoicePongFrame;

export function isValidRemoteVoiceModel(value: unknown): value is RemoteVoiceModelId {
  return value === 'qwen3-1.7b' || value === 'qwen3-0.6b';
}

export function formatRemoteVoiceModelLabel(modelId: unknown): RemoteVoiceModelLabel | null {
  if (typeof modelId !== 'string') return null;
  const normalized = modelId.trim().toLowerCase();
  if (normalized === 'qwen3-1.7b') return 'Qwen3-ASR 1.7B';
  if (normalized === 'qwen3-0.6b') return 'Qwen3-ASR 0.6B';
  return null;
}

export function isValidRemoteVoiceModelRegistration(model: unknown, modelLabel: unknown): model is RemoteVoiceModelId {
  if (!isValidRemoteVoiceModel(model)) return false;
  return modelLabel === REMOTE_VOICE_MODEL_LABELS[model];
}

export function sanitizeRemoteVoiceProviderErrorCode(code: unknown): RemoteVoiceErrorCode {
  if (typeof code === 'string') {
    const trimmed = code.trim();
    if (REMOTE_VOICE_ALLOWED_ERROR_CODES.has(trimmed)) {
      return trimmed as RemoteVoiceErrorCode;
    }
  }
  return REMOTE_VOICE_ERROR_CODES.HELPER_ERROR;
}

const GENERIC_DEVICE_NAME_RE = /^(?:localhost(?:\.localdomain)?|127\.0\.0\.1|::1)$/i;

export function sanitizeRemoteVoiceDeviceName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const collapsed = raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.(?:localdomain|local|lan)$/i, '')
    .trim();
  if (!collapsed || GENERIC_DEVICE_NAME_RE.test(collapsed)) return undefined;
  const bounded = collapsed.slice(0, REMOTE_VOICE_MAX_NICKNAME_CHARS).trim();
  return bounded || undefined;
}

export function formatDefaultRemoteVoiceNickname(
  ownerName: string,
  modelLabel: string,
  deviceName?: string | null,
): string {
  const cleanDevice = sanitizeRemoteVoiceDeviceName(deviceName);
  const cleanOwner = ownerName.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  const cleanModel = modelLabel.trim() || 'Qwen3-ASR';
  if (cleanDevice) return `${cleanDevice} · ${cleanModel}`;
  return cleanOwner ? `${cleanOwner} · ${cleanModel}` : cleanModel;
}

export function sanitizeRemoteVoiceNickname(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, REMOTE_VOICE_MAX_NICKNAME_CHARS);
}

const UNSAFE_CROSS_ACCOUNT_HOSTNAME_RE =
  /\.(?:local|lan|home|internal|corp|arpa|intranet|host|localdomain)\b|^[a-z0-9-]+(?:\.[a-z0-9-]+)+$|^(?:DESKTOP|WIN|MACBOOK|IMAC|MACMINI|MACSTUDIO|LAPTOP|WORKSTATION|SERVER)-[A-Z0-9._-]+$|\b(?:macbook|imac|mac-?mini|mac-?studio)\b/i;
const UNSAFE_CROSS_ACCOUNT_IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const UNSAFE_CROSS_ACCOUNT_HARDWARE_RE =
  /\b(?:rtx|gtx|radeon|nvidia|geforce|quadro|tesla|cuda|metal|directml|vram|cpu|gpu|apple\s*m[1-9](?:\s*(?:pro|max|ultra))?)\b/i;

export function sanitizeCrossAccountOwnerLabel(
  rawDisplayName: unknown,
  ownerUsername?: string | null,
): string {
  const cleaned = sanitizeRemoteVoiceNickname(rawDisplayName);
  if (!cleaned) return 'Desktop';
  if (cleaned.includes('@') || cleaned.includes('/') || cleaned.includes('\\') || cleaned.includes(':')) {
    return 'Desktop';
  }
  const cleanUser = typeof ownerUsername === 'string' ? ownerUsername.trim().toLowerCase() : '';
  if (cleanUser) {
    const lowerCleaned = cleaned.toLowerCase();
    if (lowerCleaned === cleanUser || (cleanUser.length >= 3 && lowerCleaned.includes(cleanUser))) {
      return 'Desktop';
    }
  }
  if (
    UNSAFE_CROSS_ACCOUNT_IPV4_RE.test(cleaned)
    || UNSAFE_CROSS_ACCOUNT_HOSTNAME_RE.test(cleaned)
    || UNSAFE_CROSS_ACCOUNT_HARDWARE_RE.test(cleaned)
  ) {
    return 'Desktop';
  }
  return cleaned;
}

export function isValidRemoteVoiceId(value: unknown): value is string {
  return typeof value === 'string' && REMOTE_VOICE_SAFE_ID_RE.test(value);
}

const BASE64_BODY_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function decodeBase64PcmByteLength(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length % 4 !== 0 || !BASE64_BODY_RE.test(trimmed)) {
    return null;
  }
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0;
  const decodedBytes = (trimmed.length / 4) * 3 - padding;
  if (decodedBytes <= 0 || decodedBytes % 2 !== 0) {
    return null;
  }
  return decodedBytes;
}

export function isValidPcmBase64Chunk(raw: unknown, maxBytes = REMOTE_VOICE_MAX_PCM_CHUNK_BYTES): raw is string {
  const bytes = decodeBase64PcmByteLength(raw);
  return bytes !== null && bytes <= maxBytes;
}

export function validatePrimaryProviderBody(
  raw: unknown,
): { ok: true; primaryDeviceId: string | null } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_body' };
  }
  const value = (raw as Record<string, unknown>).primaryDeviceId;
  if (value === null) {
    return { ok: true, primaryDeviceId: null };
  }
  if (!isValidRemoteVoiceId(value)) {
    return { ok: false, error: 'invalid_device_id' };
  }
  return { ok: true, primaryDeviceId: value };
}

function validateNicknameField(
  rawNickname: unknown,
): { ok: true; nickname: string | null | undefined } | { ok: false; error: string } {
  if (rawNickname === undefined) {
    return { ok: true, nickname: undefined };
  }
  if (rawNickname === null) {
    return { ok: true, nickname: null };
  }
  if (typeof rawNickname !== 'string') {
    return { ok: false, error: 'invalid_nickname' };
  }
  const cleaned = rawNickname.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (cleaned.length > REMOTE_VOICE_MAX_NICKNAME_CHARS) {
    return { ok: false, error: 'nickname_too_long' };
  }
  return { ok: true, nickname: cleaned ? cleaned : null };
}

export function validateProviderNicknameBody(
  raw: unknown,
): { ok: true; deviceId: string; nickname: string | null } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_body' };
  }
  const rec = raw as Record<string, unknown>;
  if (!isValidRemoteVoiceId(rec.deviceId)) {
    return { ok: false, error: 'invalid_device_id' };
  }
  if (!('nickname' in rec)) {
    return { ok: false, error: 'invalid_nickname' };
  }
  const parsedNick = validateNicknameField(rec.nickname);
  if (!parsedNick.ok || parsedNick.nickname === undefined) {
    return { ok: false, error: parsedNick.ok ? 'invalid_nickname' : parsedNick.error };
  }
  return { ok: true, deviceId: rec.deviceId, nickname: parsedNick.nickname };
}

export function validateServerSharedProviderBody(
  raw: unknown,
): { ok: true; deviceId: string; shared: boolean; nickname?: string | null } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_body' };
  }
  const rec = raw as Record<string, unknown>;
  if (!isValidRemoteVoiceId(rec.deviceId)) {
    return { ok: false, error: 'invalid_device_id' };
  }
  if (typeof rec.shared !== 'boolean') {
    return { ok: false, error: 'invalid_shared_flag' };
  }
  const parsedNick = validateNicknameField(rec.nickname);
  if (!parsedNick.ok) {
    return parsedNick;
  }
  return {
    ok: true,
    deviceId: rec.deviceId,
    shared: rec.shared,
    ...(parsedNick.nickname !== undefined ? { nickname: parsedNick.nickname } : {}),
  };
}

export function parseProviderNicknamesPref(raw: string | null): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [deviceId, rawNick] of Object.entries(parsed)) {
    if (!isValidRemoteVoiceId(deviceId)) continue;
    const cleanNick = sanitizeRemoteVoiceNickname(rawNick);
    if (cleanNick) {
      out[deviceId] = cleanNick;
    }
  }
  return out;
}

export function parseServerSharedProvidersSetting(raw: string | null): RemoteVoiceServerSharedEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: RemoteVoiceServerSharedEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const ownerUserId = typeof rec.ownerUserId === 'string' ? rec.ownerUserId.trim() : '';
    const deviceId = rec.deviceId;
    if (!ownerUserId || !isValidRemoteVoiceId(deviceId)) continue;
    const key = `${ownerUserId}\0${deviceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cleanNick = sanitizeRemoteVoiceNickname(rec.nickname);
    out.push({
      ownerUserId,
      deviceId,
      ...(cleanNick ? { nickname: cleanNick } : {}),
    });
  }
  return out;
}

function readShortString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

export function parseRemoteVoiceInboundFrame(
  raw: unknown,
):
  | { ok: true; frame: RemoteVoiceInboundFrame }
  | { ok: false; sessionId?: string; code: RemoteVoiceErrorCode; message: string } {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Malformed JSON frame' };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Frame must be a JSON object' };
  }
  const rec = obj as Record<string, unknown>;
  const type = rec.type;
  if (typeof type !== 'string') {
    return { ok: false, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Missing frame type' };
  }

  switch (type) {
    case 'ping':
      return { ok: true, frame: { type: 'ping' } };
    case 'voice.provider.pong':
      return { ok: true, frame: { type: 'voice.provider.pong' } };

    case 'voice.provider.register': {
      const deviceId = rec.deviceId;
      if (!isValidRemoteVoiceId(deviceId)) {
        return { ok: false, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Invalid provider deviceId' };
      }
      if (!isValidRemoteVoiceModelRegistration(rec.model, rec.modelLabel) || typeof rec.ready !== 'boolean') {
        return { ok: false, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Unsupported provider model or modelLabel' };
      }
      if (rec.busy !== undefined && typeof rec.busy !== 'boolean') {
        return { ok: false, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Invalid provider busy flag' };
      }
      const modelLabel = REMOTE_VOICE_MODEL_LABELS[rec.model];
      const deviceName = sanitizeRemoteVoiceDeviceName(rec.deviceName);
      const hostname = sanitizeRemoteVoiceDeviceName(rec.hostname);
      const localServerId = isValidRemoteVoiceId(rec.localServerId) ? rec.localServerId : undefined;
      return {
        ok: true,
        frame: {
          type: 'voice.provider.register',
          deviceId,
          ...(deviceName ? { deviceName } : {}),
          ...(hostname ? { hostname } : {}),
          ...(localServerId ? { localServerId } : {}),
          model: rec.model,
          modelLabel,
          ready: rec.ready,
          ...(rec.busy !== undefined ? { busy: rec.busy } : {}),
        },
      };
    }

    case 'voice.session.start': {
      const sessionId = rec.sessionId;
      if (!isValidRemoteVoiceId(sessionId)) {
        return { ok: false, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Invalid sessionId' };
      }
      const targetDeviceId = rec.targetDeviceId;
      if (!isValidRemoteVoiceId(targetDeviceId)) {
        return { ok: false, sessionId, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Invalid targetDeviceId' };
      }
      if (rec.sampleRate !== REMOTE_VOICE_SAMPLE_RATE) {
        return { ok: false, sessionId, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Unsupported sampleRate' };
      }
      let locale: string | undefined;
      if (rec.locale !== undefined) {
        const cleanLocale = readShortString(rec.locale, 64);
        if (!cleanLocale) {
          return { ok: false, sessionId, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Invalid locale' };
        }
        locale = cleanLocale;
      }
      const parsedHotwords = sanitizeRemoteVoiceHotwords(rec.hotwords);
      if (!parsedHotwords.ok) {
        return { ok: false, sessionId, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: parsedHotwords.message };
      }
      return {
        ok: true,
        frame: {
          type: 'voice.session.start',
          sessionId,
          targetDeviceId,
          ...(locale ? { locale } : {}),
          sampleRate: REMOTE_VOICE_SAMPLE_RATE,
          ...(parsedHotwords.hotwords ? { hotwords: parsedHotwords.hotwords } : {}),
        },
      };
    }

    case 'voice.session.audio': {
      const sessionId = rec.sessionId;
      if (!isValidRemoteVoiceId(sessionId)) {
        return { ok: false, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Invalid sessionId' };
      }
      const byteLength = decodeBase64PcmByteLength(rec.pcmBase64);
      if (byteLength === null) {
        return { ok: false, sessionId, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Malformed pcmBase64 payload' };
      }
      if (byteLength > REMOTE_VOICE_MAX_PCM_CHUNK_BYTES) {
        return { ok: false, sessionId, code: REMOTE_VOICE_ERROR_CODES.CHUNK_TOO_LARGE, message: 'PCM chunk exceeds max size' };
      }
      return {
        ok: true,
        frame: {
          type: 'voice.session.audio',
          sessionId,
          pcmBase64: (rec.pcmBase64 as string).trim(),
        },
      };
    }

    case 'voice.session.stop':
    case 'voice.session.abort':
    case 'voice.session.ready':
    case 'voice.session.end': {
      if (!isValidRemoteVoiceId(rec.sessionId)) {
        return { ok: false, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Invalid sessionId' };
      }
      return { ok: true, frame: { type, sessionId: rec.sessionId } };
    }

    case 'voice.session.result': {
      if (!isValidRemoteVoiceId(rec.sessionId)) {
        return { ok: false, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Invalid sessionId' };
      }
      if (typeof rec.text !== 'string' || typeof rec.isFinal !== 'boolean') {
        return { ok: false, sessionId: rec.sessionId, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Invalid session result fields' };
      }
      return {
        ok: true,
        frame: {
          type: 'voice.session.result',
          sessionId: rec.sessionId,
          text: rec.text,
          isFinal: rec.isFinal,
        },
      };
    }

    case 'voice.session.error': {
      if (!isValidRemoteVoiceId(rec.sessionId)) {
        return { ok: false, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Invalid sessionId' };
      }
      const rawCode = readShortString(rec.code, 64);
      if (!rawCode) {
        return { ok: false, sessionId: rec.sessionId, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: 'Missing error code' };
      }
      // Always coerce unknown/arbitrary error codes to helper_error and strip provider diagnostic messages.
      return {
        ok: true,
        frame: {
          type: 'voice.session.error',
          sessionId: rec.sessionId,
          code: sanitizeRemoteVoiceProviderErrorCode(rawCode),
        },
      };
    }

    default:
      return { ok: false, code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME, message: `Unsupported frame type: ${type}` };
  }
}

export const maskRemoteVoiceApiKey = maskTtsApiKey;

export function sanitizeRemoteVoiceAsrText(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLen);
}

export type RemoteVoiceAsrBaseUrlValidationResult =
  | TtsBaseUrlValidationResult
  | { ok: false; error: 'base_url_too_long' };

/**
 * Validate an external OpenAI-compatible ASR server base URL using the same
 * SSRF / metadata-host protection as TTS base URL validation.
 */
export function validateRemoteVoiceAsrBaseUrl(rawUrl: string): RemoteVoiceAsrBaseUrlValidationResult {
  if (typeof rawUrl !== 'string') {
    return { ok: false, error: 'invalid_base_url' };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length > 2048) {
    return { ok: false, error: 'base_url_too_long' };
  }
  return validateTtsBaseUrl(trimmed);
}

/**
 * Normalize an OpenAI-compatible ASR base URL into `/v1/audio/transcriptions`
 * without doubling `/v1` or `/audio/transcriptions`.
 */
export function resolveOpenAiTranscriptionEndpoint(baseUrl: string): string {
  const validated = validateRemoteVoiceAsrBaseUrl(baseUrl);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  const parsed = new URL(validated.url);
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  const lowerPath = cleanPath.toLowerCase();
  let apiPrefix: string;
  if (lowerPath.endsWith('/audio/transcriptions')) {
    apiPrefix = cleanPath.slice(0, -'/audio/transcriptions'.length);
  } else if (lowerPath.endsWith('/v1')) {
    apiPrefix = cleanPath;
  } else {
    apiPrefix = `${cleanPath}/v1`;
  }
  return `${parsed.origin}${apiPrefix}/audio/transcriptions${parsed.search}`;
}

export type ServerAsrServiceBodyValidation =
  | {
    ok: true;
    data: {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      enabled?: boolean;
    };
  }
  | { ok: false; error: string };

export function validateServerAsrServiceBody(
  body: unknown,
  opts?: { partial?: boolean },
): ServerAsrServiceBodyValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid_body' };
  }
  const rec = body as Record<string, unknown>;
  const partial = opts?.partial === true;
  const out: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    enabled?: boolean;
  } = {};

  if (rec.name !== undefined || !partial) {
    if (typeof rec.name !== 'string') {
      return { ok: false, error: 'invalid_name' };
    }
    const cleanName = rec.name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!cleanName || cleanName.length > 64) {
      return { ok: false, error: 'invalid_name' };
    }
    out.name = cleanName;
  }

  if (rec.baseUrl !== undefined || !partial) {
    if (typeof rec.baseUrl !== 'string') {
      return { ok: false, error: 'invalid_base_url' };
    }
    const checkedUrl = validateRemoteVoiceAsrBaseUrl(rec.baseUrl);
    if (!checkedUrl.ok) {
      return { ok: false, error: checkedUrl.error };
    }
    out.baseUrl = checkedUrl.url;
  }

  if (rec.model !== undefined || !partial) {
    if (typeof rec.model !== 'string') {
      return { ok: false, error: 'invalid_model' };
    }
    const cleanModel = rec.model.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!cleanModel || cleanModel.length > 128) {
      return { ok: false, error: 'invalid_model' };
    }
    out.model = cleanModel;
  }

  if (rec.apiKey !== undefined) {
    if (typeof rec.apiKey !== 'string' || rec.apiKey.length > 4096) {
      return { ok: false, error: 'invalid_api_key' };
    }
    out.apiKey = rec.apiKey.trim();
  }

  if (rec.enabled !== undefined) {
    if (typeof rec.enabled !== 'boolean') {
      return { ok: false, error: 'invalid_enabled' };
    }
    out.enabled = rec.enabled;
  } else if (!partial) {
    out.enabled = true;
  }

  if (
    partial
    && out.name === undefined
    && out.baseUrl === undefined
    && out.model === undefined
    && out.apiKey === undefined
    && out.enabled === undefined
  ) {
    return { ok: false, error: 'empty_update' };
  }

  return { ok: true, data: out };
}

const ASR_SINGLE_CHAR_REPEAT_THRESHOLD = 8;
const ASR_DIGIT_REPEAT_THRESHOLD = 16;
const ASR_MULTI_CHAR_MIN_PERIOD = 2;
const ASR_MULTI_CHAR_MAX_PERIOD = 24;
const ASR_MULTI_CHAR_MIN_REPEATS = 5;
const ASR_MEANINGFUL_CHAR_RE = /[\p{L}\p{N}]/u;

function hasUniformElements(chars: string[], start: number, len: number): boolean {
  const first = chars[start];
  for (let i = 1; i < len; i += 1) {
    if (chars[start + i] !== first) return false;
  }
  return true;
}

function isAsciiDigit(ch: string): boolean {
  return ch.length === 1 && ch >= '0' && ch <= '9';
}

function collapseRunsForPeriod(chars: string[], period: number): { next: string[]; changed: boolean } {
  const n = chars.length;
  if (n < period * 2) return { next: chars, changed: false };

  const removeRanges: Array<[number, number]> = [];
  if (period === 1) {
    let runStart = 0;
    for (let i = 1; i <= n; i += 1) {
      if (i < n && chars[i] === chars[runStart]) continue;
      const runLen = i - runStart;
      const threshold = isAsciiDigit(chars[runStart]!)
        ? ASR_DIGIT_REPEAT_THRESHOLD
        : ASR_SINGLE_CHAR_REPEAT_THRESHOLD;
      if (runLen >= threshold) {
        removeRanges.push([runStart, i]);
      }
      runStart = i;
    }
  } else {
    const minMatchLen = period * (ASR_MULTI_CHAR_MIN_REPEATS - 1);
    let matchLen = 0;
    for (let i = period; i <= n; i += 1) {
      if (i < n && chars[i] === chars[i - period]) {
        matchLen += 1;
        continue;
      }
      if (matchLen >= minMatchLen) {
        const runEnd = i;
        const runStart = runEnd - matchLen - period;
        if (!hasUniformElements(chars, runStart, period)) {
          const prevRange = removeRanges[removeRanges.length - 1];
          if (!prevRange || runStart >= prevRange[1]) {
            removeRanges.push([runStart, runEnd]);
          } else if (runEnd > prevRange[1]) {
            prevRange[1] = runEnd;
          }
        }
      }
      matchLen = 0;
    }
  }

  if (removeRanges.length === 0) return { next: chars, changed: false };

  const out: string[] = [];
  let cursor = 0;
  for (const [start, end] of removeRanges) {
    for (let j = cursor; j < start; j += 1) {
      out.push(chars[j]!);
    }
    cursor = end;
  }
  for (let j = cursor; j < n; j += 1) {
    out.push(chars[j]!);
  }
  return { next: out, changed: true };
}

const ASR_CONTROL_TAG_RE = /(?:(?<![A-Za-z0-9_])language[ \t\r\n]+[A-Za-z0-9_-]+[ \t\r\n]*)?<asr_text>|<\|[^|>\r\n]{1,48}\|>/g;

/**
 * Strip Qwen3-ASR control prefixes/tags (e.g. `language None<asr_text>`,
 * `language\nChinese<asr_text>`, standalone `<asr_text>`, `<|endoftext|>`)
 * while leaving ordinary words such as `"the language model"` untouched.
 */
export function stripAsrControlTags(text: string): string {
  if (!text) return '';
  return text.replace(ASR_CONTROL_TAG_RE, '').trim();
}

/**
 * Sanitize an incoming ASR transcript result and preserve the session's last
 * non-empty sanitized transcript when a terminal `isFinal` frame collapses to
 * empty (e.g. `language None<asr_text>` or a pure repetition burst from an older helper).
 */
export function resolveSessionTranscriptResult(
  rawText: string,
  isFinal: boolean,
  lastNonEmptyText: string,
): { emit: boolean; text: string; nextLastNonEmptyText: string } {
  const sanitized = sanitizeAsrRepetitionLoop(rawText);
  if (sanitized.trim().length > 0) {
    return { emit: true, text: sanitized, nextLastNonEmptyText: sanitized };
  }
  if (!isFinal) {
    return { emit: false, text: '', nextLastNonEmptyText: lastNonEmptyText };
  }
  return { emit: true, text: lastNonEmptyText, nextLastNonEmptyText: lastNonEmptyText };
}

/**
 * Remove runaway consecutive ASR repetition loops (e.g. Qwen3-ASR greedy loop bursts
 * such as `"想，他".repeat(60)`) in bounded O(n) time while preserving normal repeated
 * speech expressions (`哈哈哈哈`, `对对对`, `10000000`, `yes yes yes`, `...`).
 */
export function sanitizeAsrRepetitionLoop(text: string): string {
  const stripped = stripAsrControlTags(text);
  if (!stripped) return '';
  if (stripped.length < ASR_SINGLE_CHAR_REPEAT_THRESHOLD) return stripped;

  let chars = Array.from(stripped);
  let removedAny = false;

  for (let round = 0; round < 2; round += 1) {
    let changedInRound = false;
    const single = collapseRunsForPeriod(chars, 1);
    if (single.changed) {
      chars = single.next;
      changedInRound = true;
      removedAny = true;
    }
    for (let period = ASR_MULTI_CHAR_MIN_PERIOD; period <= ASR_MULTI_CHAR_MAX_PERIOD; period += 1) {
      if (chars.length < period * ASR_MULTI_CHAR_MIN_REPEATS) break;
      const res = collapseRunsForPeriod(chars, period);
      if (res.changed) {
        chars = res.next;
        changedInRound = true;
        removedAny = true;
      }
    }
    if (!changedInRound) break;
  }

  if (!removedAny) return stripped;

  const cleaned = chars.join('').trim();
  if (!cleaned || !ASR_MEANINGFUL_CHAR_RE.test(cleaned)) {
    return '';
  }
  return cleaned;
}
