import {
  REMOTE_VOICE_ENV_ASR_DEVICE_ID,
  REMOTE_VOICE_MAX_SERVER_ASR_SERVICES,
  REMOTE_VOICE_SAMPLE_RATE,
  REMOTE_VOICE_SERVER_ASR_SERVICES_SETTING_KEY,
  isValidRemoteVoiceId,
  maskRemoteVoiceApiKey,
  sanitizeRemoteVoiceAsrText,
  validateRemoteVoiceAsrBaseUrl,
  type RemoteVoiceServerAsrServicePublic,
} from '../../../shared/remote-voice.js';
import type { Database } from '../db/client.js';
import { getSetting } from '../db/queries.js';
import { decryptBotConfig, encryptBotConfig } from '../security/crypto.js';

export const DEFAULT_SERVER_ASR_NAME = 'Server ASR';
export const DEFAULT_SERVER_ASR_MODEL = 'whisper-1';

export interface StoredServerAsrServiceRecord {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEncrypted?: string | null;
  model: string;
  enabled: boolean;
}

export interface RuntimeServerAsrService {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  source: 'admin' | 'env';
}

export interface ServerAsrEnvInput {
  BOT_ENCRYPTION_KEY?: string;
  ASR_BASE_URL?: string;
  ASR_API_KEY?: string;
  ASR_MODEL?: string;
  ASR_NAME?: string;
}

/**
 * Wrap raw mono 16-bit signed little-endian PCM into a standard 44-byte RIFF/WAVE buffer.
 */
export function encodePcm16MonoToWav(
  pcmBuffer: Buffer,
  sampleRate: number = REMOTE_VOICE_SAMPLE_RATE,
): Buffer {
  const safeRate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.trunc(sampleRate) : REMOTE_VOICE_SAMPLE_RATE;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = safeRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;

  const header = Buffer.allocUnsafe(44);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 4, 'ascii');
  header.write('fmt ', 12, 4, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM linear quantization
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(safeRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 4, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer], 44 + dataSize);
}

/**
 * Convert a BCP-47 locale tag (e.g. `zh-CN`, `en-US`) into an ISO-639-1 language parameter
 * for OpenAI `/v1/audio/transcriptions`, or omit when empty/auto.
 */
export function normalizeAsrLanguage(locale?: string | null): string | undefined {
  if (typeof locale !== 'string') return undefined;
  const trimmed = locale.trim().toLowerCase();
  if (!trimmed || trimmed === 'auto') return undefined;
  const primary = trimmed.split(/[-_]/)[0] ?? '';
  if (!/^[a-z]{2,3}$/.test(primary)) return undefined;
  return primary;
}

export function encryptServerAsrApiKey(apiKey: string, encryptionKey: string | undefined): string {
  const key = (encryptionKey ?? '').trim();
  if (!key) {
    throw new Error('encryption_not_configured');
  }
  return encryptBotConfig({ apiKey }, key);
}

export function decryptServerAsrApiKey(
  apiKeyEncrypted: string | null | undefined,
  encryptionKey: string | undefined,
): string {
  if (!apiKeyEncrypted) return '';
  const key = (encryptionKey ?? '').trim();
  if (!key) return '';
  try {
    const parsed = decryptBotConfig(apiKeyEncrypted, key);
    return typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
  } catch {
    return '';
  }
}

export function parseStoredServerAsrServices(raw: string | null): StoredServerAsrServiceRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: StoredServerAsrServiceRecord[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      if (!isValidRemoteVoiceId(rec.id) || rec.id === REMOTE_VOICE_ENV_ASR_DEVICE_ID) continue;
      if (seen.has(rec.id)) continue;
      const name = sanitizeRemoteVoiceAsrText(rec.name, 64);
      const model = sanitizeRemoteVoiceAsrText(rec.model, 128);
      const baseUrlRaw = typeof rec.baseUrl === 'string' ? rec.baseUrl : '';
      const checkedUrl = validateRemoteVoiceAsrBaseUrl(baseUrlRaw);
      if (!name || !model || !checkedUrl.ok) continue;
      seen.add(rec.id);
      out.push({
        id: rec.id,
        name,
        baseUrl: checkedUrl.url,
        apiKeyEncrypted: typeof rec.apiKeyEncrypted === 'string' && rec.apiKeyEncrypted.length > 0
          ? rec.apiKeyEncrypted
          : null,
        model,
        enabled: typeof rec.enabled === 'boolean' ? rec.enabled : true,
      });
      if (out.length >= REMOTE_VOICE_MAX_SERVER_ASR_SERVICES) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function readEnvServerAsrService(env?: ServerAsrEnvInput | null): RuntimeServerAsrService | null {
  const rawBaseUrl = (env?.ASR_BASE_URL ?? '').trim();
  if (!rawBaseUrl) return null;
  const checkedUrl = validateRemoteVoiceAsrBaseUrl(rawBaseUrl);
  if (!checkedUrl.ok) return null;
  const name = sanitizeRemoteVoiceAsrText(env?.ASR_NAME, 64) ?? DEFAULT_SERVER_ASR_NAME;
  const model = sanitizeRemoteVoiceAsrText(env?.ASR_MODEL, 128) ?? DEFAULT_SERVER_ASR_MODEL;
  const apiKey = typeof env?.ASR_API_KEY === 'string' ? env.ASR_API_KEY.trim() : '';
  return {
    id: REMOTE_VOICE_ENV_ASR_DEVICE_ID,
    name,
    baseUrl: checkedUrl.url,
    apiKey,
    model,
    enabled: true,
    source: 'env',
  };
}

export function resolveRuntimeServerAsrServices(
  stored: readonly StoredServerAsrServiceRecord[],
  env?: ServerAsrEnvInput | null,
): RuntimeServerAsrService[] {
  const out: RuntimeServerAsrService[] = [];
  const envDefault = readEnvServerAsrService(env);
  if (envDefault) {
    out.push(envDefault);
  }
  const encryptionKey = env?.BOT_ENCRYPTION_KEY;
  for (const item of stored) {
    out.push({
      id: item.id,
      name: item.name,
      baseUrl: item.baseUrl,
      apiKey: decryptServerAsrApiKey(item.apiKeyEncrypted, encryptionKey),
      model: item.model,
      enabled: item.enabled,
      source: 'admin',
    });
  }
  return out;
}

export async function loadRuntimeServerAsrServices(
  db: Database,
  env?: ServerAsrEnvInput | null,
): Promise<RuntimeServerAsrService[]> {
  const raw = await getSetting(db, REMOTE_VOICE_SERVER_ASR_SERVICES_SETTING_KEY);
  const stored = parseStoredServerAsrServices(raw);
  return resolveRuntimeServerAsrServices(stored, env);
}

export function toPublicServerAsrService(
  service: StoredServerAsrServiceRecord,
  encryptionKey: string | undefined,
): RemoteVoiceServerAsrServicePublic;
export function toPublicServerAsrService(
  service: RuntimeServerAsrService,
  encryptionKey?: string | undefined,
): RemoteVoiceServerAsrServicePublic;
export function toPublicServerAsrService(
  service: StoredServerAsrServiceRecord | RuntimeServerAsrService,
  encryptionKey?: string | undefined,
): RemoteVoiceServerAsrServicePublic {
  if ('source' in service) {
    const hasApiKey = Boolean(service.apiKey);
    return {
      id: service.id,
      name: service.name,
      baseUrl: service.baseUrl,
      hasApiKey,
      apiKeyMasked: hasApiKey ? maskRemoteVoiceApiKey(service.apiKey) : null,
      model: service.model,
      enabled: service.enabled,
      source: service.source,
    };
  }
  const hasApiKey = Boolean(service.apiKeyEncrypted);
  const decrypted = hasApiKey ? decryptServerAsrApiKey(service.apiKeyEncrypted, encryptionKey) : '';
  return {
    id: service.id,
    name: service.name,
    baseUrl: service.baseUrl,
    hasApiKey,
    apiKeyMasked: decrypted ? maskRemoteVoiceApiKey(decrypted) : (hasApiKey ? '****' : null),
    model: service.model,
    enabled: service.enabled,
    source: 'admin',
  };
}

/**
 * Read a fetch response body as UTF-8 text bounded to `maxBytes` bytes.
 */
export async function readAsrResponseTextBounded(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('response_too_large');
    }
    return text;
  }

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
        try {
          await reader.cancel();
        } catch {
          // Ignore cancel error.
        }
        throw new Error('response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}
