import type { RemoteVoiceProviderInfo } from '@shared/remote-voice.js';
import {
  mergeVoiceHotwords,
  type CompiledVoiceHotwords,
} from '@shared/voice-hotwords.js';

export const VOICE_HOTWORDS_GLOBAL_STORAGE_KEY = 'imcodes_voice_hotwords_global';
export const VOICE_HOTWORDS_PROJECTS_STORAGE_KEY = 'imcodes_voice_hotwords_projects';
export const VOICE_HOTWORDS_SHARE_WITH_OTHERS_STORAGE_KEY = 'imcodes_voice_hotwords_share_with_others';

let _activeProjectKey: string | null = null;
const _changeListeners = new Set<() => void>();

function notifyChange(): void {
  for (const listener of [..._changeListeners]) {
    try {
      listener();
    } catch { /* ignore listener errors */ }
  }
}

export function subscribeVoiceHotwordsChange(listener: () => void): () => void {
  _changeListeners.add(listener);
  return () => {
    _changeListeners.delete(listener);
  };
}

export function normalizeVoiceHotwordProjectKey(projectKey: string | null | undefined): string | null {
  if (typeof projectKey !== 'string') return null;
  const trimmed = projectKey.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function setActiveVoiceHotwordProject(projectKey: string | null | undefined): void {
  const next = normalizeVoiceHotwordProjectKey(projectKey);
  if (next === _activeProjectKey) return;
  _activeProjectKey = next;
  notifyChange();
}

export function getActiveVoiceHotwordProject(): string | null {
  return _activeProjectKey;
}

function readProjectsMap(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(VOICE_HOTWORDS_PROJECTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const cleanKey = normalizeVoiceHotwordProjectKey(k);
      if (cleanKey && typeof v === 'string') {
        out[cleanKey] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeProjectsMap(map: Record<string, string>): void {
  try {
    if (Object.keys(map).length === 0) {
      globalThis.localStorage?.removeItem(VOICE_HOTWORDS_PROJECTS_STORAGE_KEY);
    } else {
      globalThis.localStorage?.setItem(VOICE_HOTWORDS_PROJECTS_STORAGE_KEY, JSON.stringify(map));
    }
  } catch { /* localStorage may be unavailable in restricted contexts */ }
}

export function getGlobalVoiceHotwordsRaw(): string {
  try {
    return globalThis.localStorage?.getItem(VOICE_HOTWORDS_GLOBAL_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setGlobalVoiceHotwordsRaw(raw: string): void {
  try {
    if (!raw) {
      globalThis.localStorage?.removeItem(VOICE_HOTWORDS_GLOBAL_STORAGE_KEY);
    } else {
      globalThis.localStorage?.setItem(VOICE_HOTWORDS_GLOBAL_STORAGE_KEY, raw);
    }
  } catch { /* localStorage may be unavailable in restricted contexts */ }
  notifyChange();
}

export function getProjectVoiceHotwordsRaw(projectKey?: string | null): string {
  const key = normalizeVoiceHotwordProjectKey(projectKey ?? _activeProjectKey);
  if (!key) return '';
  return readProjectsMap()[key] ?? '';
}

export function setProjectVoiceHotwordsRaw(projectKey: string, raw: string): void {
  const key = normalizeVoiceHotwordProjectKey(projectKey);
  if (!key) return;
  const map = readProjectsMap();
  if (!raw) {
    delete map[key];
  } else {
    map[key] = raw;
  }
  writeProjectsMap(map);
  notifyChange();
}

export function listVoiceHotwordProjectKeys(): string[] {
  return Object.keys(readProjectsMap()).sort((a, b) => a.localeCompare(b));
}

/** Whether to include project/global hotwords when using a desktop provider shared by another account (default false). */
export function getShareHotwordsWithOthers(): boolean {
  try {
    return globalThis.localStorage?.getItem(VOICE_HOTWORDS_SHARE_WITH_OTHERS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setShareHotwordsWithOthers(enabled: boolean): void {
  try {
    if (enabled) {
      globalThis.localStorage?.setItem(VOICE_HOTWORDS_SHARE_WITH_OTHERS_STORAGE_KEY, '1');
    } else {
      globalThis.localStorage?.removeItem(VOICE_HOTWORDS_SHARE_WITH_OTHERS_STORAGE_KEY);
    }
  } catch { /* localStorage may be unavailable in restricted contexts */ }
  notifyChange();
}

export function getCompiledVoiceHotwordsForProject(projectKey?: string | null): CompiledVoiceHotwords {
  const resolvedKey = normalizeVoiceHotwordProjectKey(projectKey === undefined ? _activeProjectKey : projectKey);
  return mergeVoiceHotwords({
    projectRaw: resolvedKey ? getProjectVoiceHotwordsRaw(resolvedKey) : '',
    globalRaw: getGlobalVoiceHotwordsRaw(),
  });
}

/**
 * Privacy gate for remote voice ASR:
 * - Server HTTP ASR endpoints and user's own PC App devices always receive hotwords when non-empty.
 * - Cross-account PC App devices shared by others receive hotwords ONLY when the user opts in.
 */
export function shouldSendRemoteVoiceHotwords(
  provider: Pick<RemoteVoiceProviderInfo, 'providerKind' | 'isOwnDevice'> | null | undefined,
  shareWithOthers: boolean = getShareHotwordsWithOthers(),
): boolean {
  if (!provider) return false;
  if (provider.providerKind === 'http_asr') return true;
  if (provider.isOwnDevice === true) return true;
  return shareWithOthers === true;
}

export function resolveRemoteVoiceHotwordsForProvider(
  provider: Pick<RemoteVoiceProviderInfo, 'providerKind' | 'isOwnDevice'> | null | undefined,
  compiled: CompiledVoiceHotwords | null | undefined,
  shareWithOthers: boolean = getShareHotwordsWithOthers(),
): string[] | undefined {
  if (!compiled || compiled.terms.length === 0) return undefined;
  if (!shouldSendRemoteVoiceHotwords(provider, shareWithOthers)) return undefined;
  return compiled.terms;
}
