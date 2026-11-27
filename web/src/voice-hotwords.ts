import type { RemoteVoiceProviderInfo } from '@shared/remote-voice.js';
import {
  decodeVoiceHotwordProjectKey,
  encodeVoiceHotwordProjectKey,
  mergeVoiceHotwords,
  normalizeVoiceHotwordProjectKey,
  normalizeVoiceHotwordRawText,
  type CompiledVoiceHotwords,
  type VoiceHotwordProjectInput,
  type VoiceHotwordProjectRef,
  type VoiceHotwordsPutRequest,
  type VoiceHotwordsScopePatch,
  type VoiceHotwordsSyncRecord,
} from '@shared/voice-hotwords.js';

export {
  decodeVoiceHotwordProjectKey,
  encodeVoiceHotwordProjectKey,
  normalizeVoiceHotwordProjectKey,
  type VoiceHotwordProjectInput,
  type VoiceHotwordProjectRef,
};

export const VOICE_HOTWORDS_GLOBAL_STORAGE_KEY = 'imcodes_voice_hotwords_global';
export const VOICE_HOTWORDS_PROJECTS_STORAGE_KEY = 'imcodes_voice_hotwords_projects';
export const VOICE_HOTWORDS_SHARE_WITH_OTHERS_STORAGE_KEY = 'imcodes_voice_hotwords_share_with_others';
export const VOICE_HOTWORDS_SYNC_META_STORAGE_KEY = 'imcodes_voice_hotwords_sync_meta';

const STORAGE_SCOPE_VERSION = 'v2';
const STANDALONE_ACCOUNT_SCOPE = '__standalone__';
const PUSH_DEBOUNCE_MS = 300;

export interface VoiceHotwordsAuthScope {
  userId?: string | null;
  baseUrl?: string | null;
}

export type OpenVoiceHotwordsSettingsHandler = (projectKey?: VoiceHotwordProjectInput) => void;

export interface VoiceHotwordsSyncClient {
  fetchRecord: (signal?: AbortSignal) => Promise<VoiceHotwordsSyncRecord | null>;
  updateRecord: (payload: VoiceHotwordsPutRequest, signal?: AbortSignal) => Promise<VoiceHotwordsSyncRecord | null>;
}

interface LocalVoiceHotwordsSyncMeta {
  userUpdatedAt: number;
  userServerUpdatedAt: number;
  userDirty: boolean;
  projects: Record<string, number>;
  projectsServer: Record<string, number>;
  dirtyProjects: Record<string, boolean>;
  shareUpdatedAt: number;
  shareServerUpdatedAt: number;
  shareDirty: boolean;
}

let _authScopeSetExplicitly = false;
let _authScopeKey: string | null = null;
let _scopeEpoch = 0;
let _activeProjectKey: string | null = null;
let _openSettingsHandler: OpenVoiceHotwordsSettingsHandler | null = null;
let _syncClient: VoiceHotwordsSyncClient | null = null;
let _pushTimer: ReturnType<typeof setTimeout> | null = null;
let _syncAbortController: AbortController | null = null;
let _inFlightSyncPromise: Promise<void> | null = null;
let _inFlightSyncEpoch = -1;
const _changeListeners = new Set<() => void>();

function notifyChange(): void {
  for (const listener of [..._changeListeners]) {
    try {
      listener();
    } catch { /* ignore listener errors */ }
  }
}

function emptySyncMeta(): LocalVoiceHotwordsSyncMeta {
  return {
    userUpdatedAt: 0,
    userServerUpdatedAt: 0,
    userDirty: false,
    projects: {},
    projectsServer: {},
    dirtyProjects: {},
    shareUpdatedAt: 0,
    shareServerUpdatedAt: 0,
    shareDirty: false,
  };
}

function coerceTs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function coerceTsMap(input: unknown): Record<string, number> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const cleanKey = normalizeVoiceHotwordProjectKey(k);
    const ts = coerceTs(v);
    if (cleanKey && ts > 0) out[cleanKey] = ts;
  }
  return out;
}

function coerceBoolMap(input: unknown): Record<string, boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const cleanKey = normalizeVoiceHotwordProjectKey(k);
    if (cleanKey && v === true) out[cleanKey] = true;
  }
  return out;
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

function isRemoteSyncEligibleAccountKey(accountKey: string | null): accountKey is string {
  return Boolean(accountKey && accountKey !== STANDALONE_ACCOUNT_SCOPE);
}

function scopedStorageKey(baseKey: string, accountKey: string): string {
  if (accountKey === STANDALONE_ACCOUNT_SCOPE) {
    return baseKey;
  }
  return `${baseKey}:${STORAGE_SCOPE_VERSION}:${encodeURIComponent(accountKey)}`;
}

function clearPendingSyncState(): void {
  if (_pushTimer !== null) {
    clearTimeout(_pushTimer);
    _pushTimer = null;
  }
  if (_syncAbortController) {
    _syncAbortController.abort();
    _syncAbortController = null;
  }
  _inFlightSyncPromise = null;
  _inFlightSyncEpoch = -1;
}

function readSyncMeta(accountKey: string): LocalVoiceHotwordsSyncMeta {
  try {
    const raw = globalThis.localStorage?.getItem(scopedStorageKey(VOICE_HOTWORDS_SYNC_META_STORAGE_KEY, accountKey));
    if (!raw) return emptySyncMeta();
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptySyncMeta();
    return {
      userUpdatedAt: coerceTs(parsed.userUpdatedAt),
      userServerUpdatedAt: coerceTs(parsed.userServerUpdatedAt),
      userDirty: parsed.userDirty === true,
      projects: coerceTsMap(parsed.projects),
      projectsServer: coerceTsMap(parsed.projectsServer),
      dirtyProjects: coerceBoolMap(parsed.dirtyProjects),
      shareUpdatedAt: coerceTs(parsed.shareUpdatedAt),
      shareServerUpdatedAt: coerceTs(parsed.shareServerUpdatedAt),
      shareDirty: parsed.shareDirty === true,
    };
  } catch {
    return emptySyncMeta();
  }
}

function writeSyncMeta(accountKey: string, meta: LocalVoiceHotwordsSyncMeta): void {
  const storageKey = scopedStorageKey(VOICE_HOTWORDS_SYNC_META_STORAGE_KEY, accountKey);
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(meta));
  } catch { /* localStorage may be unavailable */ }
}

function nextMonotonicTimestamp(prevLocalTs: number, serverTs: number): number {
  return Math.max(Date.now(), prevLocalTs + 1, serverTs + 1);
}

export function subscribeVoiceHotwordsChange(listener: () => void): () => void {
  _changeListeners.add(listener);
  return () => {
    _changeListeners.delete(listener);
  };
}

export function registerVoiceHotwordsSyncClient(client: VoiceHotwordsSyncClient | null): () => void {
  _syncClient = client;
  if (client) {
    const accountKey = resolveCurrentAccountScopeKey();
    if (isRemoteSyncEligibleAccountKey(accountKey)) {
      void syncVoiceHotwordsFromServer();
    }
  }
  return () => {
    if (_syncClient === client) {
      _syncClient = null;
    }
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
    clearPendingSyncState();
    notifyChange();
    if (_syncClient && isRemoteSyncEligibleAccountKey(nextKey)) {
      void syncVoiceHotwordsFromServer();
    }
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
  _syncClient = null;
  clearPendingSyncState();
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

function readProjectsMapForAccount(accountKey: string): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(scopedStorageKey(VOICE_HOTWORDS_PROJECTS_STORAGE_KEY, accountKey));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const cleanKey = normalizeVoiceHotwordProjectKey(k);
      if (cleanKey && typeof v === 'string' && v.length > 0) {
        out[cleanKey] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function readProjectsMap(): Record<string, string> {
  const accountKey = resolveCurrentAccountScopeKey();
  if (!accountKey) return {};
  return readProjectsMapForAccount(accountKey);
}

function writeProjectsMapForAccount(accountKey: string, map: Record<string, string>): void {
  const storageKey = scopedStorageKey(VOICE_HOTWORDS_PROJECTS_STORAGE_KEY, accountKey);
  try {
    if (Object.keys(map).length === 0) {
      globalThis.localStorage?.removeItem(storageKey);
    } else {
      globalThis.localStorage?.setItem(storageKey, JSON.stringify(map));
    }
  } catch { /* localStorage may be unavailable in restricted contexts */ }
}

function readGlobalRawForAccount(accountKey: string): string {
  try {
    return globalThis.localStorage?.getItem(scopedStorageKey(VOICE_HOTWORDS_GLOBAL_STORAGE_KEY, accountKey)) ?? '';
  } catch {
    return '';
  }
}

function writeGlobalRawForAccount(accountKey: string, raw: string): void {
  const storageKey = scopedStorageKey(VOICE_HOTWORDS_GLOBAL_STORAGE_KEY, accountKey);
  try {
    if (!raw) {
      globalThis.localStorage?.removeItem(storageKey);
    } else {
      globalThis.localStorage?.setItem(storageKey, raw);
    }
  } catch { /* localStorage may be unavailable in restricted contexts */ }
}

function readShareForAccount(accountKey: string): boolean {
  try {
    return globalThis.localStorage?.getItem(scopedStorageKey(VOICE_HOTWORDS_SHARE_WITH_OTHERS_STORAGE_KEY, accountKey)) === '1';
  } catch {
    return false;
  }
}

function writeShareForAccount(accountKey: string, enabled: boolean): void {
  const storageKey = scopedStorageKey(VOICE_HOTWORDS_SHARE_WITH_OTHERS_STORAGE_KEY, accountKey);
  try {
    if (enabled) {
      globalThis.localStorage?.setItem(storageKey, '1');
    } else {
      globalThis.localStorage?.removeItem(storageKey);
    }
  } catch { /* localStorage may be unavailable in restricted contexts */ }
}

function scheduleVoiceHotwordsPush(snapshot: VoiceHotwordsScopeSnapshot): void {
  if (!_syncClient || !isRemoteSyncEligibleAccountKey(snapshot.accountKey)) return;
  if (_pushTimer !== null) {
    clearTimeout(_pushTimer);
  }
  _pushTimer = setTimeout(() => {
    _pushTimer = null;
    if (!isVoiceHotwordsScopeValid(snapshot)) return;
    void flushVoiceHotwordsPush();
  }, PUSH_DEBOUNCE_MS);
}

export function getGlobalVoiceHotwordsRaw(): string {
  const accountKey = resolveCurrentAccountScopeKey();
  if (!accountKey) return '';
  return readGlobalRawForAccount(accountKey);
}

export function setGlobalVoiceHotwordsRaw(raw: string): void {
  const snapshot = getVoiceHotwordsScopeSnapshot();
  if (!snapshot.accountKey) return;
  writeGlobalRawForAccount(snapshot.accountKey, raw);
  const meta = readSyncMeta(snapshot.accountKey);
  meta.userUpdatedAt = nextMonotonicTimestamp(meta.userUpdatedAt, meta.userServerUpdatedAt);
  meta.userDirty = true;
  writeSyncMeta(snapshot.accountKey, meta);
  notifyChange();
  scheduleVoiceHotwordsPush(snapshot);
}

export function getProjectVoiceHotwordsRaw(projectKey?: VoiceHotwordProjectInput): string {
  const key = projectKey === undefined
    ? _activeProjectKey
    : normalizeVoiceHotwordProjectKey(projectKey);
  if (!key) return '';
  return readProjectsMap()[key] ?? '';
}

export function setProjectVoiceHotwordsRaw(projectKey: string | VoiceHotwordProjectRef, raw: string): void {
  const snapshot = getVoiceHotwordsScopeSnapshot();
  if (!snapshot.accountKey) return;
  const key = normalizeVoiceHotwordProjectKey(projectKey);
  if (!key) return;
  const map = readProjectsMapForAccount(snapshot.accountKey);
  if (!raw) {
    delete map[key];
  } else {
    map[key] = raw;
  }
  writeProjectsMapForAccount(snapshot.accountKey, map);
  const meta = readSyncMeta(snapshot.accountKey);
  meta.projects[key] = nextMonotonicTimestamp(meta.projects[key] ?? 0, meta.projectsServer[key] ?? 0);
  meta.dirtyProjects[key] = true;
  writeSyncMeta(snapshot.accountKey, meta);
  notifyChange();
  scheduleVoiceHotwordsPush(snapshot);
}

export function listVoiceHotwordProjectKeys(): string[] {
  return Object.keys(readProjectsMap()).sort((a, b) => a.localeCompare(b));
}

/** Whether to include project/global hotwords when using a desktop provider shared by another account (default false). */
export function getShareHotwordsWithOthers(): boolean {
  const accountKey = resolveCurrentAccountScopeKey();
  if (!accountKey) return false;
  return readShareForAccount(accountKey);
}

export function setShareHotwordsWithOthers(enabled: boolean): void {
  const snapshot = getVoiceHotwordsScopeSnapshot();
  if (!snapshot.accountKey) return;
  writeShareForAccount(snapshot.accountKey, enabled);
  const meta = readSyncMeta(snapshot.accountKey);
  meta.shareUpdatedAt = nextMonotonicTimestamp(meta.shareUpdatedAt, meta.shareServerUpdatedAt);
  meta.shareDirty = true;
  writeSyncMeta(snapshot.accountKey, meta);
  notifyChange();
  scheduleVoiceHotwordsPush(snapshot);
}

function buildDirtyPushPayload(
  accountKey: string,
  meta: LocalVoiceHotwordsSyncMeta,
): { payload: VoiceHotwordsPutRequest | null; pushedUserTs?: number; pushedProjectsTs: Record<string, number>; pushedShareTs?: number } {
  const localGlobal = readGlobalRawForAccount(accountKey);
  const localProjects = readProjectsMapForAccount(accountKey);
  const localShare = readShareForAccount(accountKey);

  const payload: VoiceHotwordsPutRequest = {};
  let hasChanges = false;
  let pushedUserTs: number | undefined;
  const pushedProjectsTs: Record<string, number> = {};
  let pushedShareTs: number | undefined;

  if (meta.userDirty) {
    const ts = meta.userUpdatedAt || 1;
    payload.user = { raw: localGlobal, mode: 'replace', clientUpdatedAt: ts };
    pushedUserTs = ts;
    hasChanges = true;
  }

  const dirtyProjectKeys = Object.keys(meta.dirtyProjects).filter((k) => meta.dirtyProjects[k]);
  if (dirtyProjectKeys.length > 0) {
    const projectsPatch: Record<string, VoiceHotwordsScopePatch> = {};
    for (const key of dirtyProjectKeys) {
      const ts = meta.projects[key] ?? 1;
      projectsPatch[key] = { raw: localProjects[key] ?? '', mode: 'replace', clientUpdatedAt: ts };
      pushedProjectsTs[key] = ts;
    }
    payload.projects = projectsPatch;
    hasChanges = true;
  }

  if (meta.shareDirty) {
    const ts = meta.shareUpdatedAt || 1;
    payload.shareWithOthers = { enabled: localShare, clientUpdatedAt: ts };
    pushedShareTs = ts;
    hasChanges = true;
  }

  return {
    payload: hasChanges ? payload : null,
    pushedUserTs,
    pushedProjectsTs,
    pushedShareTs,
  };
}

function reconcileWithServerRecord(
  accountKey: string,
  server: VoiceHotwordsSyncRecord,
  pushed?: {
    pushedUserTs?: number;
    pushedProjectsTs: Record<string, number>;
    pushedShareTs?: number;
  },
): { pendingPush: VoiceHotwordsPutRequest | null; changedUi: boolean; pushedMeta?: { pushedUserTs?: number; pushedProjectsTs: Record<string, number>; pushedShareTs?: number } } {
  const meta = readSyncMeta(accountKey);
  let localGlobal = readGlobalRawForAccount(accountKey);
  const localProjects = readProjectsMapForAccount(accountKey);
  let localShare = readShareForAccount(accountKey);

  let changedUi = false;
  let globalChanged = false;
  let projectsChanged = false;
  let shareChanged = false;

  // Clear dirty flags for fields confirmed by an in-flight push whose timestamp did not advance mid-flight
  if (pushed?.pushedUserTs !== undefined && meta.userUpdatedAt === pushed.pushedUserTs) {
    meta.userDirty = false;
  }
  for (const [key, ts] of Object.entries(pushed?.pushedProjectsTs ?? {})) {
    if ((meta.projects[key] ?? 0) === ts) {
      delete meta.dirtyProjects[key];
    }
  }
  if (pushed?.pushedShareTs !== undefined && meta.shareUpdatedAt === pushed.pushedShareTs) {
    meta.shareDirty = false;
  }

  const pendingPush: VoiceHotwordsPutRequest = {};
  let hasPendingPush = false;
  const nextPushedProjectsTs: Record<string, number> = {};
  let nextPushedUserTs: number | undefined;
  let nextPushedShareTs: number | undefined;

  // 1. User global scope
  const localUserTs = meta.userUpdatedAt || (localGlobal ? 1 : 0);
  const serverUserTs = server.user.updatedAt;
  meta.userServerUpdatedAt = serverUserTs;
  if (serverUserTs > localUserTs) {
    if (normalizeVoiceHotwordRawText(server.user.raw) !== normalizeVoiceHotwordRawText(localGlobal) || (!server.user.raw && localGlobal !== '')) {
      localGlobal = server.user.raw;
      globalChanged = true;
      changedUi = true;
    }
    meta.userUpdatedAt = serverUserTs;
    meta.userDirty = false;
  } else if (meta.userDirty || localUserTs > serverUserTs) {
    const pushTs = Math.max(localUserTs, serverUserTs + 1);
    meta.userUpdatedAt = pushTs;
    meta.userDirty = true;
    pendingPush.user = { raw: localGlobal, mode: 'replace', clientUpdatedAt: pushTs };
    nextPushedUserTs = pushTs;
    hasPendingPush = true;
  } else {
    meta.userUpdatedAt = serverUserTs;
  }

  // 2. Project scopes (union of local, meta tombstones, and server)
  const allProjectKeys = new Set([
    ...Object.keys(localProjects),
    ...Object.keys(meta.projects),
    ...Object.keys(server.projects),
  ]);
  const pendingProjects: Record<string, VoiceHotwordsScopePatch> = {};
  for (const key of allProjectKeys) {
    const localRaw = localProjects[key] ?? '';
    const localProjTs = meta.projects[key] ?? (localRaw ? 1 : 0);
    const serverEntry = server.projects[key];
    const serverProjTs = serverEntry?.updatedAt ?? 0;
    const serverRaw = serverEntry?.raw ?? '';

    if (serverProjTs > 0) {
      meta.projectsServer[key] = serverProjTs;
    }

    if (serverProjTs > localProjTs) {
      if (normalizeVoiceHotwordRawText(serverRaw) !== normalizeVoiceHotwordRawText(localRaw) || (!serverRaw && localRaw !== '')) {
        if (!serverRaw) {
          delete localProjects[key];
        } else {
          localProjects[key] = serverRaw;
        }
        projectsChanged = true;
        changedUi = true;
      }
      meta.projects[key] = serverProjTs;
      delete meta.dirtyProjects[key];
    } else if (meta.dirtyProjects[key] || localProjTs > serverProjTs) {
      const pushTs = Math.max(localProjTs, serverProjTs + 1);
      meta.projects[key] = pushTs;
      meta.dirtyProjects[key] = true;
      pendingProjects[key] = { raw: localRaw, mode: 'replace', clientUpdatedAt: pushTs };
      nextPushedProjectsTs[key] = pushTs;
      hasPendingPush = true;
    } else {
      meta.projects[key] = serverProjTs;
    }
  }
  if (Object.keys(pendingProjects).length > 0) {
    pendingPush.projects = pendingProjects;
  }

  // 3. Share consent scope
  const localShareTs = meta.shareUpdatedAt || (localShare ? 1 : 0);
  const serverShareTs = server.shareWithOthers.updatedAt;
  meta.shareServerUpdatedAt = serverShareTs;
  if (serverShareTs > localShareTs) {
    if (server.shareWithOthers.enabled !== localShare) {
      localShare = server.shareWithOthers.enabled;
      shareChanged = true;
      changedUi = true;
    }
    meta.shareUpdatedAt = serverShareTs;
    meta.shareDirty = false;
  } else if (meta.shareDirty || localShareTs > serverShareTs) {
    const pushTs = Math.max(localShareTs, serverShareTs + 1);
    meta.shareUpdatedAt = pushTs;
    meta.shareDirty = true;
    pendingPush.shareWithOthers = { enabled: localShare, clientUpdatedAt: pushTs };
    nextPushedShareTs = pushTs;
    hasPendingPush = true;
  } else {
    meta.shareUpdatedAt = serverShareTs;
  }

  if (globalChanged) writeGlobalRawForAccount(accountKey, localGlobal);
  if (projectsChanged) writeProjectsMapForAccount(accountKey, localProjects);
  if (shareChanged) writeShareForAccount(accountKey, localShare);
  writeSyncMeta(accountKey, meta);

  return {
    pendingPush: hasPendingPush ? pendingPush : null,
    changedUi,
    pushedMeta: hasPendingPush
      ? {
          pushedUserTs: nextPushedUserTs,
          pushedProjectsTs: nextPushedProjectsTs,
          pushedShareTs: nextPushedShareTs,
        }
      : undefined,
  };
}

export async function flushVoiceHotwordsPush(): Promise<void> {
  const snapshot = getVoiceHotwordsScopeSnapshot();
  if (!_syncClient || !isRemoteSyncEligibleAccountKey(snapshot.accountKey)) return;

  const meta = readSyncMeta(snapshot.accountKey);
  const built = buildDirtyPushPayload(snapshot.accountKey, meta);
  if (!built.payload) return;

  const controller = new AbortController();
  const prevController = _syncAbortController;
  _syncAbortController = controller;
  prevController?.abort();

  try {
    const serverRecord = await _syncClient.updateRecord(built.payload, controller.signal);
    if (!serverRecord || !isVoiceHotwordsScopeValid(snapshot)) return;
    const result = reconcileWithServerRecord(snapshot.accountKey, serverRecord, {
      pushedUserTs: built.pushedUserTs,
      pushedProjectsTs: built.pushedProjectsTs,
      pushedShareTs: built.pushedShareTs,
    });
    if (result.changedUi) notifyChange();
    if (result.pendingPush) {
      // User edited again while PUT was in-flight; schedule immediate follow-up push
      scheduleVoiceHotwordsPush(snapshot);
    }
  } catch {
    // Keep dirty flags intact for later retry (focus/visibility/online/edit)
  } finally {
    if (_syncAbortController === controller) {
      _syncAbortController = null;
    }
  }
}

export async function syncVoiceHotwordsFromServer(): Promise<void> {
  const snapshot = getVoiceHotwordsScopeSnapshot();
  const accountKey = snapshot.accountKey;
  if (!_syncClient || !isRemoteSyncEligibleAccountKey(accountKey)) return;

  if (_inFlightSyncPromise && _inFlightSyncEpoch === snapshot.epoch) {
    return _inFlightSyncPromise;
  }

  const run = (async () => {
    const controller = new AbortController();
    const prevController = _syncAbortController;
    _syncAbortController = controller;
    prevController?.abort();

    try {
      const serverRecord = await _syncClient?.fetchRecord(controller.signal);
      if (!serverRecord || !isVoiceHotwordsScopeValid(snapshot)) return;

      const reconciled = reconcileWithServerRecord(accountKey, serverRecord);
      if (reconciled.changedUi) {
        notifyChange();
      }
      if (reconciled.pendingPush && reconciled.pushedMeta) {
        const pushedRecord = await _syncClient?.updateRecord(reconciled.pendingPush, controller.signal);
        if (!pushedRecord || !isVoiceHotwordsScopeValid(snapshot)) return;
        const postPush = reconcileWithServerRecord(accountKey, pushedRecord, reconciled.pushedMeta);
        if (postPush.changedUi) {
          notifyChange();
        }
        if (postPush.pendingPush) {
          scheduleVoiceHotwordsPush(snapshot);
        }
      }
    } catch {
      // Network/transient error: retain local data & dirty state silently
    } finally {
      if (_syncAbortController === controller) {
        _syncAbortController = null;
      }
    }
  })();

  const wrapped = run.finally(() => {
    if (_inFlightSyncPromise === wrapped) {
      _inFlightSyncPromise = null;
      _inFlightSyncEpoch = -1;
    }
  });
  _inFlightSyncEpoch = snapshot.epoch;
  _inFlightSyncPromise = wrapped;
  return wrapped;
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
