import type { RemoteVoiceProviderInfo } from '@shared/remote-voice.js';
import {
  mergeVoiceHotwords,
  type CompiledVoiceHotwords,
} from '@shared/voice-hotwords.js';

export const VOICE_HOTWORDS_GLOBAL_STORAGE_KEY = 'imcodes_voice_hotwords_global';
export const VOICE_HOTWORDS_PROJECTS_STORAGE_KEY = 'imcodes_voice_hotwords_projects';
export const VOICE_HOTWORDS_SHARE_WITH_OTHERS_STORAGE_KEY = 'imcodes_voice_hotwords_share_with_others';

const STORAGE_SCOPE_VERSION = 'v2';
const STANDALONE_ACCOUNT_SCOPE = '__standalone__';
const SCOPED_PROJECT_PREFIX = 'srv:';
const SCOPED_PROJECT_SEP = '::';

export interface VoiceHotwordsAuthScope {
  userId?: string | null;
  baseUrl?: string | null;
}

export interface VoiceHotwordProjectRef {
  serverId?: string | null;
  projectName?: string | null;
}

export type VoiceHotwordProjectInput = string | VoiceHotwordProjectRef | null | undefined;

export type OpenVoiceHotwordsSettingsHandler = (projectKey?: VoiceHotwordProjectInput) => void;

let _authScopeSetExplicitly = false;
let _authScopeKey: string | null = null;
let _scopeEpoch = 0;
let _activeProjectKey: string | null = null;
let _openSettingsHandler: OpenVoiceHotwordsSettingsHandler | null = null;
const _changeListeners = new Set<() => void>();

function notifyChange(): void {
  for (const listener of [..._changeListeners]) {
    try {
      listener();
    } catch { /* ignore listener errors */ }
  }
}

function normalizeAuthBaseUrl(baseUrl: string | null | undefined): string {
  if (typeof baseUrl !== 'string') return '';
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.origin.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function buildAccountScopeKey(auth: VoiceHotwordsAuthScope | null | undefined): string | null {
  const userId = typeof auth?.userId === 'string' ? auth.userId.trim() : '';
  if (!userId) return null;
  const baseUrl = normalizeAuthBaseUrl(auth?.baseUrl);
  return `${baseUrl}|${userId}`;
}

function readLazyRccAuthScopeKey(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem('rcc_auth');
    if (!raw) return STANDALONE_ACCOUNT_SCOPE;
    const parsed = JSON.parse(raw) as { userId?: unknown; baseUrl?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return STANDALONE_ACCOUNT_SCOPE;
    const scoped = buildAccountScopeKey({
      userId: typeof parsed.userId === 'string' ? parsed.userId : null,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : null,
    });
    return scoped ?? STANDALONE_ACCOUNT_SCOPE;
  } catch {
    return STANDALONE_ACCOUNT_SCOPE;
  }
}

function resolveCurrentAccountScopeKey(): string | null {
  if (_authScopeSetExplicitly) {
    return _authScopeKey;
  }
  return readLazyRccAuthScopeKey();
}

function scopedStorageKey(baseKey: string, accountKey: string): string {
  if (accountKey === STANDALONE_ACCOUNT_SCOPE) {
    return baseKey;
  }
  return `${baseKey}:${STORAGE_SCOPE_VERSION}:${encodeURIComponent(accountKey)}`;
}

export function subscribeVoiceHotwordsChange(listener: () => void): () => void {
  _changeListeners.add(listener);
  return () => {
    _changeListeners.delete(listener);
  };
}

/**
 * Scope voice hotwords & cross-account sharing consent to the active browser auth
 * (userId + auth server baseUrl). Switching accounts or logging out deactivates
 * previous in-memory state first so zero hotwords or consent leak across accounts.
 */
export function setVoiceHotwordsAuthScope(auth: VoiceHotwordsAuthScope | null | undefined): void {
  const prevKey = resolveCurrentAccountScopeKey();
  const nextKey = buildAccountScopeKey(auth);
  const changed = !_authScopeSetExplicitly || prevKey !== nextKey;
  _authScopeSetExplicitly = true;
  _authScopeKey = nextKey;
  if (changed) {
    _scopeEpoch += 1;
    _activeProjectKey = null;
    notifyChange();
  }
}

export function getVoiceHotwordsAuthScopeKey(): string | null {
  return resolveCurrentAccountScopeKey();
}

export interface VoiceHotwordsScopeSnapshot {
  accountKey: string | null;
  epoch: number;
}

export function getVoiceHotwordsScopeSnapshot(): VoiceHotwordsScopeSnapshot {
  return {
    accountKey: resolveCurrentAccountScopeKey(),
    epoch: _scopeEpoch,
  };
}

export function isVoiceHotwordsScopeValid(snapshot: VoiceHotwordsScopeSnapshot): boolean {
  const currentKey = resolveCurrentAccountScopeKey();
  return currentKey === snapshot.accountKey && _scopeEpoch === snapshot.epoch;
}

export function resetVoiceHotwordsScopeForTesting(): void {
  _authScopeSetExplicitly = false;
  _authScopeKey = null;
  _scopeEpoch += 1;
  _activeProjectKey = null;
  _openSettingsHandler = null;
  notifyChange();
}

export function registerOpenVoiceHotwordsSettingsHandler(
  handler: OpenVoiceHotwordsSettingsHandler | null,
): () => void {
  _openSettingsHandler = handler;
  return () => {
    if (_openSettingsHandler === handler) {
      _openSettingsHandler = null;
    }
  };
}

export function hasVoiceHotwordsSettingsHandler(): boolean {
  return _openSettingsHandler !== null;
}

export function openVoiceHotwordsSettings(projectKey?: VoiceHotwordProjectInput): boolean {
  if (!_openSettingsHandler) return false;
  _openSettingsHandler(projectKey);
  return true;
}

export function encodeVoiceHotwordProjectKey(
  projectName: string | null | undefined,
  serverId?: string | null,
): string | null {
  if (typeof projectName !== 'string') return null;
  const trimmedName = projectName.trim();
  if (!trimmedName) return null;
  if (trimmedName.startsWith(SCOPED_PROJECT_PREFIX)) {
    const sepIdx = trimmedName.indexOf(SCOPED_PROJECT_SEP, SCOPED_PROJECT_PREFIX.length);
    if (sepIdx > SCOPED_PROJECT_PREFIX.length) {
      const innerProject = trimmedName.slice(sepIdx + SCOPED_PROJECT_SEP.length).trim();
      if (!innerProject) return null;
      return trimmedName;
    }
  }
  const cleanServer = typeof serverId === 'string' ? serverId.trim() : '';
  if (!cleanServer) return trimmedName;
  return `${SCOPED_PROJECT_PREFIX}${encodeURIComponent(cleanServer)}${SCOPED_PROJECT_SEP}${trimmedName}`;
}

export function decodeVoiceHotwordProjectKey(
  rawKey: string | null | undefined,
): { serverId: string | null; projectName: string } | null {
  if (typeof rawKey !== 'string') return null;
  const trimmed = rawKey.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(SCOPED_PROJECT_PREFIX)) {
    const sepIdx = trimmed.indexOf(SCOPED_PROJECT_SEP, SCOPED_PROJECT_PREFIX.length);
    if (sepIdx > SCOPED_PROJECT_PREFIX.length) {
      const encodedServer = trimmed.slice(SCOPED_PROJECT_PREFIX.length, sepIdx);
      const projectName = trimmed.slice(sepIdx + SCOPED_PROJECT_SEP.length).trim();
      if (projectName) {
        try {
          return { serverId: decodeURIComponent(encodedServer), projectName };
        } catch {
          return { serverId: encodedServer, projectName };
        }
      }
    }
  }
  return { serverId: null, projectName: trimmed };
}

export function normalizeVoiceHotwordProjectKey(projectInput: VoiceHotwordProjectInput): string | null {
  if (!projectInput) return null;
  if (typeof projectInput === 'string') {
    return encodeVoiceHotwordProjectKey(projectInput);
  }
  return encodeVoiceHotwordProjectKey(projectInput.projectName, projectInput.serverId);
}

export function formatVoiceHotwordProjectLabel(
  rawKey: string,
  serverNamesById?: Record<string, string> | null,
): string {
  const decoded = decodeVoiceHotwordProjectKey(rawKey);
  if (!decoded) return rawKey;
  if (!decoded.serverId) return decoded.projectName;
  const serverLabel = serverNamesById?.[decoded.serverId]?.trim() || decoded.serverId;
  return `${decoded.projectName} · ${serverLabel}`;
}

export function setActiveVoiceHotwordProject(projectKey: VoiceHotwordProjectInput): void {
  const next = normalizeVoiceHotwordProjectKey(projectKey);
  if (next === _activeProjectKey) return;
  _activeProjectKey = next;
  notifyChange();
}

export function getActiveVoiceHotwordProject(): string | null {
  return _activeProjectKey;
}

function readProjectsMap(): Record<string, string> {
  const accountKey = resolveCurrentAccountScopeKey();
  if (!accountKey) return {};
  try {
    const raw = globalThis.localStorage?.getItem(scopedStorageKey(VOICE_HOTWORDS_PROJECTS_STORAGE_KEY, accountKey));
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
  const accountKey = resolveCurrentAccountScopeKey();
  if (!accountKey) return;
  const storageKey = scopedStorageKey(VOICE_HOTWORDS_PROJECTS_STORAGE_KEY, accountKey);
  try {
    if (Object.keys(map).length === 0) {
      globalThis.localStorage?.removeItem(storageKey);
    } else {
      globalThis.localStorage?.setItem(storageKey, JSON.stringify(map));
    }
  } catch { /* localStorage may be unavailable in restricted contexts */ }
}

export function getGlobalVoiceHotwordsRaw(): string {
  const accountKey = resolveCurrentAccountScopeKey();
  if (!accountKey) return '';
  try {
    return globalThis.localStorage?.getItem(scopedStorageKey(VOICE_HOTWORDS_GLOBAL_STORAGE_KEY, accountKey)) ?? '';
  } catch {
    return '';
  }
}

export function setGlobalVoiceHotwordsRaw(raw: string): void {
  const accountKey = resolveCurrentAccountScopeKey();
  if (!accountKey) return;
  const storageKey = scopedStorageKey(VOICE_HOTWORDS_GLOBAL_STORAGE_KEY, accountKey);
  try {
    if (!raw) {
      globalThis.localStorage?.removeItem(storageKey);
    } else {
      globalThis.localStorage?.setItem(storageKey, raw);
    }
  } catch { /* localStorage may be unavailable in restricted contexts */ }
  notifyChange();
}

export function getProjectVoiceHotwordsRaw(projectKey?: VoiceHotwordProjectInput): string {
  const key = projectKey === undefined
    ? _activeProjectKey
    : normalizeVoiceHotwordProjectKey(projectKey);
  if (!key) return '';
  return readProjectsMap()[key] ?? '';
}

export function setProjectVoiceHotwordsRaw(projectKey: string | VoiceHotwordProjectRef, raw: string): void {
  if (!resolveCurrentAccountScopeKey()) return;
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
  const accountKey = resolveCurrentAccountScopeKey();
  if (!accountKey) return false;
  try {
    return globalThis.localStorage?.getItem(scopedStorageKey(VOICE_HOTWORDS_SHARE_WITH_OTHERS_STORAGE_KEY, accountKey)) === '1';
  } catch {
    return false;
  }
}

export function setShareHotwordsWithOthers(enabled: boolean): void {
  const accountKey = resolveCurrentAccountScopeKey();
  if (!accountKey) return;
  const storageKey = scopedStorageKey(VOICE_HOTWORDS_SHARE_WITH_OTHERS_STORAGE_KEY, accountKey);
  try {
    if (enabled) {
      globalThis.localStorage?.setItem(storageKey, '1');
    } else {
      globalThis.localStorage?.removeItem(storageKey);
    }
  } catch { /* localStorage may be unavailable in restricted contexts */ }
  notifyChange();
}

export function getCompiledVoiceHotwordsForProject(projectKey?: VoiceHotwordProjectInput): CompiledVoiceHotwords {
  if (!resolveCurrentAccountScopeKey()) {
    return { terms: [], asrTerms: [], contextText: '', replacements: [] };
  }
  // Explicit `null` means an explicit no-project voice entry (global hotwords only, never active-project fallback).
  const resolvedKey = projectKey === null
    ? null
    : projectKey === undefined
      ? _activeProjectKey
      : normalizeVoiceHotwordProjectKey(projectKey);
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
  const asrTerms = compiled?.asrTerms ?? compiled?.terms;
  if (!asrTerms || asrTerms.length === 0) return undefined;
  if (!shouldSendRemoteVoiceHotwords(provider, shareWithOthers)) return undefined;
  return asrTerms;
}
