import type { RemoteVoiceProviderInfo } from '@shared/remote-voice.js';
import {
  VOICE_HOTWORDS_MAX_RAW_CHARS,
  createNullProtoDict,
  decodeVoiceHotwordProjectKey,
  deleteOwnDictKey,
  encodeVoiceHotwordProjectKey,
  getOwnDictValue,
  mergeVoiceHotwords,
  normalizeVoiceHotwordProjectKey,
  normalizeVoiceHotwordRawText,
  setOwnDictValue,
  type CompiledVoiceHotwords,
  type VoiceHotwordProjectInput,
  type VoiceHotwordProjectRef,
  type VoiceHotwordsPutRequest,
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

export interface VoiceHotwordsSyncRequestOptions {
  expectedUserId: string;
  signal?: AbortSignal;
}

export interface VoiceHotwordsSyncClient {
  fetchRecord: (options: VoiceHotwordsSyncRequestOptions) => Promise<VoiceHotwordsSyncRecord | null>;
  updateRecord: (payload: VoiceHotwordsPutRequest, options: VoiceHotwordsSyncRequestOptions) => Promise<VoiceHotwordsSyncRecord | null>;
}

interface LocalVoiceHotwordsSyncMeta {
  userUpdatedAt: number;
  userServerUpdatedAt: number;
  userDirty: boolean;
  userRejectedAt: number;
  projects: Record<string, number>;
  projectsServer: Record<string, number>;
  dirtyProjects: Record<string, boolean>;
  rejectedProjects: Record<string, number>;
  shareUpdatedAt: number;
  shareServerUpdatedAt: number;
  shareDirty: boolean;
  initialMigrationDone: boolean;
}

let _authScopeSetExplicitly = false;
let _authScopeKey: string | null = null;
let _authScopeUserId: string | null = null;
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
    userRejectedAt: 0,
    projects: createNullProtoDict<number>(),
    projectsServer: createNullProtoDict<number>(),
    dirtyProjects: createNullProtoDict<boolean>(),
    rejectedProjects: createNullProtoDict<number>(),
    shareUpdatedAt: 0,
    shareServerUpdatedAt: 0,
    shareDirty: false,
    initialMigrationDone: false,
  };
}

function coerceTs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function coerceTsMap(input: unknown): Record<string, number> {
  const out = createNullProtoDict<number>();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const cleanKey = normalizeVoiceHotwordProjectKey(k);
    const ts = coerceTs(v);
    if (cleanKey && ts > 0) setOwnDictValue(out, cleanKey, ts);
  }
  return out;
}

function coerceBoolMap(input: unknown): Record<string, boolean> {
  const out = createNullProtoDict<boolean>();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const cleanKey = normalizeVoiceHotwordProjectKey(k);
    if (cleanKey && v === true) setOwnDictValue(out, cleanKey, true);
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

function buildAccountScopeParts(auth: VoiceHotwordsAuthScope | null | undefined): { key: string; userId: string } | null {
  const userId = typeof auth?.userId === 'string' ? auth.userId.trim() : '';
  if (!userId) return null;
  const baseUrl = normalizeAuthBaseUrl(auth?.baseUrl);
  return { key: `${baseUrl}|${userId}`, userId };
}

function readLazyRccAuthScopeKey(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem('rcc_auth');
    if (!raw) return STANDALONE_ACCOUNT_SCOPE;
    const parsed = JSON.parse(raw) as { userId?: unknown; baseUrl?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return STANDALONE_ACCOUNT_SCOPE;
    const scoped = buildAccountScopeParts({
      userId: typeof parsed.userId === 'string' ? parsed.userId : null,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : null,
    });
    return scoped?.key ?? STANDALONE_ACCOUNT_SCOPE;
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
  return Boolean(_authScopeSetExplicitly && _authScopeUserId && accountKey && accountKey !== STANDALONE_ACCOUNT_SCOPE);
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
      userRejectedAt: coerceTs(parsed.userRejectedAt),
      projects: coerceTsMap(parsed.projects),
      projectsServer: coerceTsMap(parsed.projectsServer),
      dirtyProjects: coerceBoolMap(parsed.dirtyProjects),
      rejectedProjects: coerceTsMap(parsed.rejectedProjects),
      shareUpdatedAt: coerceTs(parsed.shareUpdatedAt),
      shareServerUpdatedAt: coerceTs(parsed.shareServerUpdatedAt),
      shareDirty: parsed.shareDirty === true,
      initialMigrationDone: parsed.initialMigrationDone === true,
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

function isClientValidationError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 404 && status !== 408 && status !== 429;
}

export function subscribeVoiceHotwordsChange(listener: () => void): () => void {
  _changeListeners.add(listener);
  return () => {
    _changeListeners.delete(listener);
  };
}

/** Register HTTP sync transport only; never triggers network sync before explicit auth confirmation. */
export function registerVoiceHotwordsSyncClient(client: VoiceHotwordsSyncClient | null): () => void {
  _syncClient = client;
  return () => {
    if (_syncClient === client) {
      _syncClient = null;
    }
  };
}

/**
 * Scope voice hotwords & cross-account sharing consent to the verified browser auth
 * (userId + auth server baseUrl). Switching accounts or logging out aborts in-flight
 * syncs and deactivates previous state first so zero hotwords or consent leak across accounts.
 */
export function setVoiceHotwordsAuthScope(auth: VoiceHotwordsAuthScope | null | undefined): void {
  const prevKey = resolveCurrentAccountScopeKey();
  const parts = buildAccountScopeParts(auth);
  const nextKey = parts?.key ?? null;
  const nextUserId = parts?.userId ?? null;
  const changed = !_authScopeSetExplicitly || prevKey !== nextKey || _authScopeUserId !== nextUserId;
  _authScopeSetExplicitly = true;
  _authScopeKey = nextKey;
  _authScopeUserId = nextUserId;
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
  userId?: string | null;
  epoch: number;
}

export function getVoiceHotwordsScopeSnapshot(): VoiceHotwordsScopeSnapshot {
  return {
    accountKey: resolveCurrentAccountScopeKey(),
    userId: _authScopeSetExplicitly ? _authScopeUserId : null,
    epoch: _scopeEpoch,
  };
}

export function isVoiceHotwordsScopeValid(snapshot: VoiceHotwordsScopeSnapshot): boolean {
  const currentKey = resolveCurrentAccountScopeKey();
  if (snapshot.userId !== undefined) {
    const currentUserId = _authScopeSetExplicitly ? _authScopeUserId : null;
    if (currentUserId !== snapshot.userId) return false;
  }
  return currentKey === snapshot.accountKey && _scopeEpoch === snapshot.epoch;
}

export function resetVoiceHotwordsScopeForTesting(): void {
  _authScopeSetExplicitly = false;
  _authScopeKey = null;
  _authScopeUserId = null;
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
  const out = createNullProtoDict<string>();
  try {
    const raw = globalThis.localStorage?.getItem(scopedStorageKey(VOICE_HOTWORDS_PROJECTS_STORAGE_KEY, accountKey));
    if (!raw) return out;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const cleanKey = normalizeVoiceHotwordProjectKey(k);
      if (cleanKey && typeof v === 'string' && v.length > 0) {
        setOwnDictValue(out, cleanKey, v);
      }
    }
    return out;
  } catch {
    return out;
  }
}

function readProjectsMap(): Record<string, string> {
  const accountKey = resolveCurrentAccountScopeKey();
  if (!accountKey) return createNullProtoDict<string>();
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
  meta.userRejectedAt = 0;
  writeSyncMeta(snapshot.accountKey, meta);
  notifyChange();
  scheduleVoiceHotwordsPush(snapshot);
}

export function getProjectVoiceHotwordsRaw(projectKey?: VoiceHotwordProjectInput): string {
  const key = projectKey === undefined
    ? _activeProjectKey
    : normalizeVoiceHotwordProjectKey(projectKey);
  if (!key) return '';
  return getOwnDictValue(readProjectsMap(), key) ?? '';
}

export function setProjectVoiceHotwordsRaw(projectKey: string | VoiceHotwordProjectRef, raw: string): void {
  const snapshot = getVoiceHotwordsScopeSnapshot();
  if (!snapshot.accountKey) return;
  const key = normalizeVoiceHotwordProjectKey(projectKey);
  if (!key) return;
  const map = readProjectsMapForAccount(snapshot.accountKey);
  if (!raw) {
    deleteOwnDictKey(map, key);
  } else {
    setOwnDictValue(map, key, raw);
  }
  writeProjectsMapForAccount(snapshot.accountKey, map);
  const meta = readSyncMeta(snapshot.accountKey);
  const nextTs = nextMonotonicTimestamp(
    getOwnDictValue(meta.projects, key) ?? 0,
    getOwnDictValue(meta.projectsServer, key) ?? 0,
  );
  setOwnDictValue(meta.projects, key, nextTs);
  setOwnDictValue(meta.dirtyProjects, key, true);
  deleteOwnDictKey(meta.rejectedProjects, key);
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

type PendingScopePush =
  | { kind: 'user'; ts: number; payload: VoiceHotwordsPutRequest }
  | { kind: 'project'; projectKey: string; ts: number; payload: VoiceHotwordsPutRequest }
  | { kind: 'share'; ts: number; payload: VoiceHotwordsPutRequest };

function collectDirtyScopePushes(accountKey: string, meta: LocalVoiceHotwordsSyncMeta): PendingScopePush[] {
  const out: PendingScopePush[] = [];
  const localGlobal = readGlobalRawForAccount(accountKey);
  const localProjects = readProjectsMapForAccount(accountKey);
  const localShare = readShareForAccount(accountKey);

  if (meta.userDirty && meta.userRejectedAt !== meta.userUpdatedAt) {
    if (localGlobal.length <= VOICE_HOTWORDS_MAX_RAW_CHARS) {
      const ts = meta.userUpdatedAt || 1;
      out.push({
        kind: 'user',
        ts,
        payload: { scope: 'user', raw: localGlobal, mode: 'replace', clientUpdatedAt: ts },
      });
    }
  }

  for (const key of Object.keys(meta.dirtyProjects)) {
    if (!getOwnDictValue(meta.dirtyProjects, key)) continue;
    const raw = getOwnDictValue(localProjects, key) ?? '';
    const ts = getOwnDictValue(meta.projects, key) ?? 1;
    if (getOwnDictValue(meta.rejectedProjects, key) === ts) continue;
    if (raw.length > VOICE_HOTWORDS_MAX_RAW_CHARS) continue;
    out.push({
      kind: 'project',
      projectKey: key,
      ts,
      payload: { scope: 'project', projectKey: key, raw, mode: 'replace', clientUpdatedAt: ts },
    });
  }

  if (meta.shareDirty) {
    const ts = meta.shareUpdatedAt || 1;
    out.push({
      kind: 'share',
      ts,
      payload: { scope: 'share', enabled: localShare, clientUpdatedAt: ts },
    });
  }

  return out;
}

type ConfirmedScopePush =
  | { kind: 'user'; ts: number }
  | { kind: 'project'; projectKey: string; ts: number }
  | { kind: 'share'; ts: number };

function reconcileWithServerRecord(
  accountKey: string,
  server: VoiceHotwordsSyncRecord,
  confirmed?: ConfirmedScopePush,
  markInitialMigrated = false,
): { pendingPushes: PendingScopePush[]; changedUi: boolean } {
  const meta = readSyncMeta(accountKey);
  let localGlobal = readGlobalRawForAccount(accountKey);
  const localProjects = readProjectsMapForAccount(accountKey);
  let localShare = readShareForAccount(accountKey);

  let changedUi = false;
  let globalChanged = false;
  let projectsChanged = false;
  let shareChanged = false;

  if (confirmed?.kind === 'user' && meta.userUpdatedAt === confirmed.ts) {
    meta.userDirty = false;
  } else if (confirmed?.kind === 'project' && (getOwnDictValue(meta.projects, confirmed.projectKey) ?? 0) === confirmed.ts) {
    deleteOwnDictKey(meta.dirtyProjects, confirmed.projectKey);
  } else if (confirmed?.kind === 'share' && meta.shareUpdatedAt === confirmed.ts) {
    meta.shareDirty = false;
  }

  // 1. User global scope
  const localUserTs = meta.userUpdatedAt || (localGlobal ? 1 : 0);
  const serverUserTs = server.user.updatedAt;
  meta.userServerUpdatedAt = serverUserTs;
  const userConfirmedPush = confirmed?.kind === 'user' && meta.userUpdatedAt === confirmed.ts;

  if (serverUserTs > localUserTs) {
    if (normalizeVoiceHotwordRawText(server.user.raw) !== normalizeVoiceHotwordRawText(localGlobal) || (!server.user.raw && localGlobal !== '')) {
      localGlobal = server.user.raw;
      globalChanged = true;
      changedUi = true;
    }
    meta.userUpdatedAt = serverUserTs;
    meta.userDirty = false;
  } else if (serverUserTs === localUserTs && (userConfirmedPush || !meta.userDirty)) {
    // Authoritative server wins ties; align both content and confirmed ts
    if (serverUserTs > 0 && (normalizeVoiceHotwordRawText(server.user.raw) !== normalizeVoiceHotwordRawText(localGlobal) || (!server.user.raw && localGlobal !== ''))) {
      localGlobal = server.user.raw;
      globalChanged = true;
      changedUi = true;
    }
    meta.userUpdatedAt = serverUserTs;
    meta.userDirty = false;
  } else if ((meta.userDirty || (!meta.initialMigrationDone && localGlobal.length > 0 && serverUserTs === 0)) && localGlobal.length <= VOICE_HOTWORDS_MAX_RAW_CHARS) {
    if (meta.userRejectedAt === 0 || meta.userUpdatedAt > meta.userRejectedAt) {
      const pushTs = nextMonotonicTimestamp(localUserTs, serverUserTs);
      if (!meta.userDirty) {
        meta.userUpdatedAt = pushTs;
        meta.userDirty = true;
      }
    }
  } else if (serverUserTs > 0) {
    meta.userUpdatedAt = serverUserTs;
  }

  // 2. Project scopes (null-proto union across local, sync meta, server)
  const allProjectKeys = new Set([
    ...Object.keys(localProjects),
    ...Object.keys(meta.projects),
    ...Object.keys(server.projects),
  ]);
  for (const key of allProjectKeys) {
    const localRaw = getOwnDictValue(localProjects, key) ?? '';
    const isDirty = getOwnDictValue(meta.dirtyProjects, key) === true;
    const localProjTs = getOwnDictValue(meta.projects, key) ?? (localRaw ? 1 : 0);
    const wasConfirmedOnServer = (getOwnDictValue(meta.projectsServer, key) ?? 0) > 0;
    const isRejected = localProjTs > 0 && (getOwnDictValue(meta.rejectedProjects, key) ?? 0) >= localProjTs;
    const isOversizedLocal = localRaw.length > VOICE_HOTWORDS_MAX_RAW_CHARS;
    const serverEntry = getOwnDictValue(server.projects, key);
    const serverProjTs = serverEntry?.updatedAt ?? 0;
    const serverRaw = serverEntry?.raw ?? '';
    const projConfirmedPush = confirmed?.kind === 'project' && confirmed.projectKey === key && (getOwnDictValue(meta.projects, key) ?? 0) === confirmed.ts;

    if (serverProjTs > 0) {
      setOwnDictValue(meta.projectsServer, key, serverProjTs);
    } else if (!isDirty && !isRejected && !isOversizedLocal) {
      deleteOwnDictKey(meta.projectsServer, key);
    }

    if (serverProjTs > localProjTs) {
      if (normalizeVoiceHotwordRawText(serverRaw) !== normalizeVoiceHotwordRawText(localRaw) || (!serverRaw && localRaw !== '')) {
        if (!serverRaw) {
          deleteOwnDictKey(localProjects, key);
        } else {
          setOwnDictValue(localProjects, key, serverRaw);
        }
        projectsChanged = true;
        changedUi = true;
      }
      setOwnDictValue(meta.projects, key, serverProjTs);
      deleteOwnDictKey(meta.dirtyProjects, key);
      deleteOwnDictKey(meta.rejectedProjects, key);
    } else if (serverProjTs === localProjTs && (projConfirmedPush || !isDirty)) {
      if (serverProjTs > 0 && (normalizeVoiceHotwordRawText(serverRaw) !== normalizeVoiceHotwordRawText(localRaw) || (!serverRaw && localRaw !== ''))) {
        if (!serverRaw) {
          deleteOwnDictKey(localProjects, key);
        } else {
          setOwnDictValue(localProjects, key, serverRaw);
        }
        projectsChanged = true;
        changedUi = true;
      } else if (serverProjTs === 0 && meta.initialMigrationDone && wasConfirmedOnServer && !isDirty && !isRejected && !isOversizedLocal && localRaw !== '') {
        // Already-synced cache no longer exists on server; avoid silently re-creating removed key
        deleteOwnDictKey(localProjects, key);
        deleteOwnDictKey(meta.projects, key);
        projectsChanged = true;
        changedUi = true;
      }
      if (serverProjTs > 0) {
        setOwnDictValue(meta.projects, key, serverProjTs);
      }
      deleteOwnDictKey(meta.dirtyProjects, key);
    } else if (isDirty || (!meta.initialMigrationDone && serverProjTs === 0 && localRaw.length > 0)) {
      if (!isDirty && !isRejected && !isOversizedLocal) {
        const pushTs = nextMonotonicTimestamp(localProjTs, serverProjTs);
        setOwnDictValue(meta.projects, key, pushTs);
        setOwnDictValue(meta.dirtyProjects, key, true);
      }
    } else if (serverProjTs === 0 && meta.initialMigrationDone && wasConfirmedOnServer && !isRejected && !isOversizedLocal && localRaw !== '') {
      deleteOwnDictKey(localProjects, key);
      deleteOwnDictKey(meta.projects, key);
      projectsChanged = true;
      changedUi = true;
    }
  }

  // 3. Share consent scope
  const localShareTs = meta.shareUpdatedAt || (localShare ? 1 : 0);
  const serverShareTs = server.shareWithOthers.updatedAt;
  meta.shareServerUpdatedAt = serverShareTs;
  const shareConfirmedPush = confirmed?.kind === 'share' && meta.shareUpdatedAt === confirmed.ts;

  if (serverShareTs > localShareTs) {
    if (server.shareWithOthers.enabled !== localShare) {
      localShare = server.shareWithOthers.enabled;
      shareChanged = true;
      changedUi = true;
    }
    meta.shareUpdatedAt = serverShareTs;
    meta.shareDirty = false;
  } else if (serverShareTs === localShareTs && (shareConfirmedPush || !meta.shareDirty)) {
    if (serverShareTs > 0 && server.shareWithOthers.enabled !== localShare) {
      localShare = server.shareWithOthers.enabled;
      shareChanged = true;
      changedUi = true;
    }
    meta.shareUpdatedAt = serverShareTs;
    meta.shareDirty = false;
  } else if (meta.shareDirty || (!meta.initialMigrationDone && localShare && serverShareTs === 0)) {
    if (!meta.shareDirty) {
      meta.shareUpdatedAt = nextMonotonicTimestamp(localShareTs, serverShareTs);
      meta.shareDirty = true;
    }
  } else if (serverShareTs > 0) {
    meta.shareUpdatedAt = serverShareTs;
  }

  if (markInitialMigrated) {
    meta.initialMigrationDone = true;
  }

  if (globalChanged) writeGlobalRawForAccount(accountKey, localGlobal);
  if (projectsChanged) writeProjectsMapForAccount(accountKey, localProjects);
  if (shareChanged) writeShareForAccount(accountKey, localShare);
  writeSyncMeta(accountKey, meta);

  return {
    pendingPushes: collectDirtyScopePushes(accountKey, meta),
    changedUi,
  };
}

async function executeIsolatedPushes(
  snapshot: VoiceHotwordsScopeSnapshot,
  initialPushes: PendingScopePush[],
  signal: AbortSignal,
): Promise<boolean> {
  const accountKey = snapshot.accountKey;
  const expectedUserId = snapshot.userId;
  if (!accountKey || !expectedUserId || !_syncClient) return false;

  let hasRemainingDirtyEdit = false;
  for (const item of initialPushes) {
    if (!isVoiceHotwordsScopeValid(snapshot)) return false;
    try {
      const serverRecord = await _syncClient.updateRecord(item.payload, {
        expectedUserId,
        signal,
      });
      if (!serverRecord || !isVoiceHotwordsScopeValid(snapshot)) return false;
      const confirmed: ConfirmedScopePush = item.kind === 'user'
        ? { kind: 'user', ts: item.ts }
        : item.kind === 'share'
          ? { kind: 'share', ts: item.ts }
          : { kind: 'project', projectKey: item.projectKey, ts: item.ts };
      const post = reconcileWithServerRecord(accountKey, serverRecord, confirmed);
      if (post.changedUi) notifyChange();
      // Check if this specific scope got re-dirtied while its PUT was in flight
      const latestMeta = readSyncMeta(accountKey);
      if (
        (item.kind === 'user' && latestMeta.userDirty)
        || (item.kind === 'share' && latestMeta.shareDirty)
        || (item.kind === 'project' && getOwnDictValue(latestMeta.dirtyProjects, item.projectKey) === true)
      ) {
        hasRemainingDirtyEdit = true;
      }
    } catch (err) {
      if (!isVoiceHotwordsScopeValid(snapshot)) return false;
      if (isClientValidationError(err)) {
        // Isolate 400 validation errors to THIS scope only without dropping local text or blocking other scopes
        const latestMeta = readSyncMeta(accountKey);
        if (item.kind === 'user' && latestMeta.userUpdatedAt === item.ts) {
          latestMeta.userRejectedAt = item.ts;
          latestMeta.userDirty = false;
        } else if (item.kind === 'project' && getOwnDictValue(latestMeta.projects, item.projectKey) === item.ts) {
          setOwnDictValue(latestMeta.rejectedProjects, item.projectKey, item.ts);
          deleteOwnDictKey(latestMeta.dirtyProjects, item.projectKey);
        }
        writeSyncMeta(accountKey, latestMeta);
      }
      // Transient/network errors keep dirty=true for this scope while allowing other scopes to proceed
    }
  }
  return hasRemainingDirtyEdit;
}

export async function flushVoiceHotwordsPush(): Promise<void> {
  const snapshot = getVoiceHotwordsScopeSnapshot();
  const accountKey = snapshot.accountKey;
  if (!_syncClient || !isRemoteSyncEligibleAccountKey(accountKey) || !snapshot.userId) return;

  const meta = readSyncMeta(accountKey);
  const pushes = collectDirtyScopePushes(accountKey, meta);
  if (pushes.length === 0) return;

  const controller = new AbortController();
  const prevController = _syncAbortController;
  _syncAbortController = controller;
  prevController?.abort();

  try {
    const needsReschedule = await executeIsolatedPushes(snapshot, pushes, controller.signal);
    if (needsReschedule && isVoiceHotwordsScopeValid(snapshot)) {
      scheduleVoiceHotwordsPush(snapshot);
    }
  } finally {
    if (_syncAbortController === controller) {
      _syncAbortController = null;
    }
  }
}

export async function syncVoiceHotwordsFromServer(): Promise<void> {
  const snapshot = getVoiceHotwordsScopeSnapshot();
  const accountKey = snapshot.accountKey;
  if (!_syncClient || !isRemoteSyncEligibleAccountKey(accountKey) || !snapshot.userId) return;

  if (_inFlightSyncPromise && _inFlightSyncEpoch === snapshot.epoch) {
    return _inFlightSyncPromise;
  }

  const run = (async () => {
    const controller = new AbortController();
    const prevController = _syncAbortController;
    _syncAbortController = controller;
    prevController?.abort();

    try {
      const serverRecord = await _syncClient?.fetchRecord({
        expectedUserId: snapshot.userId!,
        signal: controller.signal,
      });
      if (!serverRecord || !isVoiceHotwordsScopeValid(snapshot)) return;

      const reconciled = reconcileWithServerRecord(accountKey, serverRecord, undefined, true);
      if (reconciled.changedUi) {
        notifyChange();
      }
      if (reconciled.pendingPushes.length > 0) {
        const needsReschedule = await executeIsolatedPushes(snapshot, reconciled.pendingPushes, controller.signal);
        if (needsReschedule && isVoiceHotwordsScopeValid(snapshot)) {
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
