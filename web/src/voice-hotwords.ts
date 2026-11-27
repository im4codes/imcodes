import type { RemoteVoiceProviderInfo } from '@shared/remote-voice.js';
import {
  VOICE_HOTWORDS_CAPACITY_ERRORS,
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
const CAPACITY_ERROR_SET: ReadonlySet<string> = new Set(Object.values(VOICE_HOTWORDS_CAPACITY_ERRORS));

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
  userEditGen: number;
  userConfirmedGen: number;
  userBaseServerUpdatedAt: number;
  userServerUpdatedAt: number;
  userRejectedEditGen: number;
  userCapacityBlocked: boolean;

  projEditGen: Record<string, number>;
  projConfirmedGen: Record<string, number>;
  projBaseServerUpdatedAt: Record<string, number>;
  projServerUpdatedAt: Record<string, number>;
  projRejectedEditGen: Record<string, number>;
  projCapacityBlocked: Record<string, boolean>;

  shareEditGen: number;
  shareConfirmedGen: number;
  shareBaseServerUpdatedAt: number;
  shareServerUpdatedAt: number;
  shareCapacityBlocked: boolean;

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
    userEditGen: 0,
    userConfirmedGen: 0,
    userBaseServerUpdatedAt: 0,
    userServerUpdatedAt: 0,
    userRejectedEditGen: 0,
    userCapacityBlocked: false,
    projEditGen: createNullProtoDict<number>(),
    projConfirmedGen: createNullProtoDict<number>(),
    projBaseServerUpdatedAt: createNullProtoDict<number>(),
    projServerUpdatedAt: createNullProtoDict<number>(),
    projRejectedEditGen: createNullProtoDict<number>(),
    projCapacityBlocked: createNullProtoDict<boolean>(),
    shareEditGen: 0,
    shareConfirmedGen: 0,
    shareBaseServerUpdatedAt: 0,
    shareServerUpdatedAt: 0,
    shareCapacityBlocked: false,
    initialMigrationDone: false,
  };
}

function coerceNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function coerceNumMap(input: unknown): Record<string, number> {
  const out = createNullProtoDict<number>();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const cleanKey = normalizeVoiceHotwordProjectKey(k);
    const num = coerceNum(v);
    if (cleanKey && num > 0) setOwnDictValue(out, cleanKey, num);
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
      userEditGen: coerceNum(parsed.userEditGen),
      userConfirmedGen: coerceNum(parsed.userConfirmedGen),
      userBaseServerUpdatedAt: coerceNum(parsed.userBaseServerUpdatedAt),
      userServerUpdatedAt: coerceNum(parsed.userServerUpdatedAt),
      userRejectedEditGen: coerceNum(parsed.userRejectedEditGen),
      userCapacityBlocked: parsed.userCapacityBlocked === true,
      projEditGen: coerceNumMap(parsed.projEditGen),
      projConfirmedGen: coerceNumMap(parsed.projConfirmedGen),
      projBaseServerUpdatedAt: coerceNumMap(parsed.projBaseServerUpdatedAt),
      projServerUpdatedAt: coerceNumMap(parsed.projServerUpdatedAt),
      projRejectedEditGen: coerceNumMap(parsed.projRejectedEditGen),
      projCapacityBlocked: coerceBoolMap(parsed.projCapacityBlocked),
      shareEditGen: coerceNum(parsed.shareEditGen),
      shareConfirmedGen: coerceNum(parsed.shareConfirmedGen),
      shareBaseServerUpdatedAt: coerceNum(parsed.shareBaseServerUpdatedAt),
      shareServerUpdatedAt: coerceNum(parsed.shareServerUpdatedAt),
      shareCapacityBlocked: parsed.shareCapacityBlocked === true,
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

function extractApiErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code) return code;
  const body = (err as { body?: unknown }).body;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === 'string') return parsed.error;
    } catch { /* ignore */ }
  }
  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string') {
    for (const capCode of CAPACITY_ERROR_SET) {
      if (message.includes(capCode)) return capCode;
    }
  }
  return null;
}

function isCapacityError(err: unknown): boolean {
  const code = extractApiErrorCode(err);
  return Boolean(code && CAPACITY_ERROR_SET.has(code));
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
  if (meta.userEditGen === meta.userConfirmedGen) {
    meta.userBaseServerUpdatedAt = meta.userServerUpdatedAt;
  }
  meta.userEditGen += 1;
  meta.userRejectedEditGen = 0;
  meta.userCapacityBlocked = false;
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
  const editGen = getOwnDictValue(meta.projEditGen, key) ?? 0;
  const confirmedGen = getOwnDictValue(meta.projConfirmedGen, key) ?? 0;
  if (editGen === confirmedGen) {
    setOwnDictValue(meta.projBaseServerUpdatedAt, key, getOwnDictValue(meta.projServerUpdatedAt, key) ?? 0);
  }
  setOwnDictValue(meta.projEditGen, key, editGen + 1);
  deleteOwnDictKey(meta.projRejectedEditGen, key);
  deleteOwnDictKey(meta.projCapacityBlocked, key);
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
  if (meta.shareEditGen === meta.shareConfirmedGen) {
    meta.shareBaseServerUpdatedAt = meta.shareServerUpdatedAt;
  }
  meta.shareEditGen += 1;
  meta.shareCapacityBlocked = false;
  writeSyncMeta(snapshot.accountKey, meta);
  notifyChange();
  scheduleVoiceHotwordsPush(snapshot);
}

type PendingScopePush =
  | { kind: 'user'; editGen: number; baseUpdatedAt: number; payload: VoiceHotwordsPutRequest }
  | { kind: 'project'; projectKey: string; editGen: number; baseUpdatedAt: number; payload: VoiceHotwordsPutRequest }
  | { kind: 'share'; editGen: number; baseUpdatedAt: number; payload: VoiceHotwordsPutRequest };

function collectDirtyScopePushes(accountKey: string, meta: LocalVoiceHotwordsSyncMeta): PendingScopePush[] {
  const out: PendingScopePush[] = [];
  const localGlobal = readGlobalRawForAccount(accountKey);
  const localProjects = readProjectsMapForAccount(accountKey);
  const localShare = readShareForAccount(accountKey);

  if (
    meta.userEditGen > meta.userConfirmedGen
    && meta.userRejectedEditGen !== meta.userEditGen
    && !meta.userCapacityBlocked
    && localGlobal.length <= VOICE_HOTWORDS_MAX_RAW_CHARS
  ) {
    out.push({
      kind: 'user',
      editGen: meta.userEditGen,
      baseUpdatedAt: meta.userBaseServerUpdatedAt,
      payload: {
        scope: 'user',
        raw: localGlobal,
        mode: 'replace',
        baseUpdatedAt: meta.userBaseServerUpdatedAt,
      },
    });
  }

  for (const key of Object.keys(meta.projEditGen)) {
    const editGen = getOwnDictValue(meta.projEditGen, key) ?? 0;
    const confirmedGen = getOwnDictValue(meta.projConfirmedGen, key) ?? 0;
    if (editGen <= confirmedGen) continue;
    if (getOwnDictValue(meta.projRejectedEditGen, key) === editGen) continue;
    if (getOwnDictValue(meta.projCapacityBlocked, key) === true) continue;
    const raw = getOwnDictValue(localProjects, key) ?? '';
    if (raw.length > VOICE_HOTWORDS_MAX_RAW_CHARS) continue;
    const baseUpdatedAt = getOwnDictValue(meta.projBaseServerUpdatedAt, key) ?? 0;
    out.push({
      kind: 'project',
      projectKey: key,
      editGen,
      baseUpdatedAt,
      payload: {
        scope: 'project',
        projectKey: key,
        raw,
        mode: 'replace',
        baseUpdatedAt,
      },
    });
  }

  if (meta.shareEditGen > meta.shareConfirmedGen && !meta.shareCapacityBlocked) {
    out.push({
      kind: 'share',
      editGen: meta.shareEditGen,
      baseUpdatedAt: meta.shareBaseServerUpdatedAt,
      payload: {
        scope: 'share',
        enabled: localShare,
        baseUpdatedAt: meta.shareBaseServerUpdatedAt,
      },
    });
  }

  return out;
}

type ConfirmedScopePush =
  | { kind: 'user'; editGen: number; baseUpdatedAt: number }
  | { kind: 'project'; projectKey: string; editGen: number; baseUpdatedAt: number }
  | { kind: 'share'; editGen: number; baseUpdatedAt: number };

function rawDiffers(a: string, b: string): boolean {
  return normalizeVoiceHotwordRawText(a) !== normalizeVoiceHotwordRawText(b) || (!a && b !== '');
}

function reconcileWithServerRecord(
  accountKey: string,
  server: VoiceHotwordsSyncRecord,
  confirmed?: ConfirmedScopePush,
  markInitialMigrated = false,
): { pendingPushes: PendingScopePush[]; changedUi: boolean } {
  const meta = readSyncMeta(accountKey);
  if (markInitialMigrated) {
    // Re-enable capacity-blocked scopes once a fresh server snapshot arrives
    meta.userCapacityBlocked = false;
    meta.shareCapacityBlocked = false;
    meta.projCapacityBlocked = createNullProtoDict<boolean>();
  }

  let localGlobal = readGlobalRawForAccount(accountKey);
  const localProjects = readProjectsMapForAccount(accountKey);
  let localShare = readShareForAccount(accountKey);

  let changedUi = false;
  let globalChanged = false;
  let projectsChanged = false;
  let shareChanged = false;

  // 1. User global scope
  {
    const srvRaw = server.user.raw;
    const srvTs = server.user.updatedAt;
    const isConfirmedForCurrentEdit = confirmed?.kind === 'user' && meta.userEditGen === confirmed.editGen;
    meta.userServerUpdatedAt = srvTs;

    if (isConfirmedForCurrentEdit) {
      if (rawDiffers(srvRaw, localGlobal)) {
        localGlobal = srvRaw;
        globalChanged = true;
        changedUi = true;
      }
      meta.userConfirmedGen = meta.userEditGen;
      meta.userBaseServerUpdatedAt = srvTs;
      meta.userRejectedEditGen = 0;
      meta.userCapacityBlocked = false;
    } else if (confirmed?.kind === 'user' && meta.userEditGen > confirmed.editGen) {
      // User kept editing mid-flight: advance base only if our in-flight write succeeded from prev base
      if (meta.userBaseServerUpdatedAt === confirmed.baseUpdatedAt && srvTs > confirmed.baseUpdatedAt) {
        meta.userBaseServerUpdatedAt = srvTs;
      }
    } else if (meta.userEditGen > meta.userConfirmedGen) {
      // Pending offline edit: only survives if server did NOT move ahead of its base version
      if (srvTs > meta.userBaseServerUpdatedAt) {
        if (rawDiffers(srvRaw, localGlobal)) {
          localGlobal = srvRaw;
          globalChanged = true;
          changedUi = true;
        }
        meta.userConfirmedGen = meta.userEditGen;
        meta.userBaseServerUpdatedAt = srvTs;
        meta.userCapacityBlocked = false;
      }
    } else if (!meta.initialMigrationDone && localGlobal.length > 0 && srvTs === 0) {
      // Unmigrated legacy local value against uninitialized server
      if (localGlobal.length <= VOICE_HOTWORDS_MAX_RAW_CHARS) {
        meta.userEditGen += 1;
        meta.userBaseServerUpdatedAt = 0;
      }
    } else {
      // Clean synced state (or unmigrated legacy against already-initialized server)
      if (rawDiffers(srvRaw, localGlobal)) {
        localGlobal = srvRaw;
        globalChanged = true;
        changedUi = true;
      }
      meta.userBaseServerUpdatedAt = srvTs;
    }
  }

  // 2. Project scopes (null-proto union across local, sync meta, and server)
  const allProjectKeys = new Set([
    ...Object.keys(localProjects),
    ...Object.keys(meta.projEditGen),
    ...Object.keys(meta.projServerUpdatedAt),
    ...Object.keys(server.projects),
  ]);
  for (const key of allProjectKeys) {
    const localRaw = getOwnDictValue(localProjects, key) ?? '';
    const editGen = getOwnDictValue(meta.projEditGen, key) ?? 0;
    const confirmedGen = getOwnDictValue(meta.projConfirmedGen, key) ?? 0;
    const isDirty = editGen > confirmedGen;
    const prevBaseTs = getOwnDictValue(meta.projBaseServerUpdatedAt, key) ?? 0;
    const wasConfirmedOnServer = (getOwnDictValue(meta.projServerUpdatedAt, key) ?? 0) > 0;
    const isRejected = editGen > 0 && (getOwnDictValue(meta.projRejectedEditGen, key) ?? 0) >= editGen;
    const isOversizedLocal = localRaw.length > VOICE_HOTWORDS_MAX_RAW_CHARS;

    const srvEntry = getOwnDictValue(server.projects, key);
    const srvTs = srvEntry?.updatedAt ?? 0;
    const srvRaw = srvEntry?.raw ?? '';

    const isConfirmedForCurrentEdit = confirmed?.kind === 'project'
      && confirmed.projectKey === key
      && editGen === confirmed.editGen;

    if (srvTs > 0) {
      setOwnDictValue(meta.projServerUpdatedAt, key, srvTs);
    } else if (!isDirty && !isRejected && !isOversizedLocal) {
      deleteOwnDictKey(meta.projServerUpdatedAt, key);
    }

    if (isConfirmedForCurrentEdit) {
      if (rawDiffers(srvRaw, localRaw)) {
        if (!srvRaw) deleteOwnDictKey(localProjects, key);
        else setOwnDictValue(localProjects, key, srvRaw);
        projectsChanged = true;
        changedUi = true;
      }
      setOwnDictValue(meta.projConfirmedGen, key, editGen);
      setOwnDictValue(meta.projBaseServerUpdatedAt, key, srvTs);
      deleteOwnDictKey(meta.projRejectedEditGen, key);
      deleteOwnDictKey(meta.projCapacityBlocked, key);
    } else if (confirmed?.kind === 'project' && confirmed.projectKey === key && editGen > confirmed.editGen) {
      if (prevBaseTs === confirmed.baseUpdatedAt && srvTs > confirmed.baseUpdatedAt) {
        setOwnDictValue(meta.projBaseServerUpdatedAt, key, srvTs);
      }
    } else if (isDirty) {
      if (srvTs > prevBaseTs) {
        if (rawDiffers(srvRaw, localRaw)) {
          if (!srvRaw) deleteOwnDictKey(localProjects, key);
          else setOwnDictValue(localProjects, key, srvRaw);
          projectsChanged = true;
          changedUi = true;
        }
        setOwnDictValue(meta.projConfirmedGen, key, editGen);
        setOwnDictValue(meta.projBaseServerUpdatedAt, key, srvTs);
        deleteOwnDictKey(meta.projCapacityBlocked, key);
      }
    } else if (!meta.initialMigrationDone && localRaw.length > 0 && srvTs === 0) {
      if (!isOversizedLocal) {
        setOwnDictValue(meta.projEditGen, key, editGen + 1);
        setOwnDictValue(meta.projBaseServerUpdatedAt, key, 0);
      }
    } else if (srvTs > 0) {
      if (rawDiffers(srvRaw, localRaw)) {
        if (!srvRaw) deleteOwnDictKey(localProjects, key);
        else setOwnDictValue(localProjects, key, srvRaw);
        projectsChanged = true;
        changedUi = true;
      }
      setOwnDictValue(meta.projBaseServerUpdatedAt, key, srvTs);
    } else if (srvTs === 0 && meta.initialMigrationDone && wasConfirmedOnServer && !isRejected && !isOversizedLocal && localRaw !== '') {
      deleteOwnDictKey(localProjects, key);
      deleteOwnDictKey(meta.projBaseServerUpdatedAt, key);
      projectsChanged = true;
      changedUi = true;
    }
  }

  // 3. Share consent scope
  {
    const srvEnabled = server.shareWithOthers.enabled;
    const srvTs = server.shareWithOthers.updatedAt;
    const isConfirmedForCurrentEdit = confirmed?.kind === 'share' && meta.shareEditGen === confirmed.editGen;
    meta.shareServerUpdatedAt = srvTs;

    if (isConfirmedForCurrentEdit) {
      if (srvEnabled !== localShare) {
        localShare = srvEnabled;
        shareChanged = true;
        changedUi = true;
      }
      meta.shareConfirmedGen = meta.shareEditGen;
      meta.shareBaseServerUpdatedAt = srvTs;
      meta.shareCapacityBlocked = false;
    } else if (confirmed?.kind === 'share' && meta.shareEditGen > confirmed.editGen) {
      if (meta.shareBaseServerUpdatedAt === confirmed.baseUpdatedAt && srvTs > confirmed.baseUpdatedAt) {
        meta.shareBaseServerUpdatedAt = srvTs;
      }
    } else if (meta.shareEditGen > meta.shareConfirmedGen) {
      if (srvTs > meta.shareBaseServerUpdatedAt) {
        if (srvEnabled !== localShare) {
          localShare = srvEnabled;
          shareChanged = true;
          changedUi = true;
        }
        meta.shareConfirmedGen = meta.shareEditGen;
        meta.shareBaseServerUpdatedAt = srvTs;
        meta.shareCapacityBlocked = false;
      }
    } else if (!meta.initialMigrationDone && localShare && srvTs === 0) {
      meta.shareEditGen += 1;
      meta.shareBaseServerUpdatedAt = 0;
    } else {
      if (srvTs > 0 && srvEnabled !== localShare) {
        localShare = srvEnabled;
        shareChanged = true;
        changedUi = true;
      }
      meta.shareBaseServerUpdatedAt = srvTs;
    }
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
        ? { kind: 'user', editGen: item.editGen, baseUpdatedAt: item.baseUpdatedAt }
        : item.kind === 'share'
          ? { kind: 'share', editGen: item.editGen, baseUpdatedAt: item.baseUpdatedAt }
          : { kind: 'project', projectKey: item.projectKey, editGen: item.editGen, baseUpdatedAt: item.baseUpdatedAt };
      const post = reconcileWithServerRecord(accountKey, serverRecord, confirmed);
      if (post.changedUi) notifyChange();

      const latestMeta = readSyncMeta(accountKey);
      if (
        (item.kind === 'user' && latestMeta.userEditGen > latestMeta.userConfirmedGen && !latestMeta.userCapacityBlocked && latestMeta.userRejectedEditGen !== latestMeta.userEditGen)
        || (item.kind === 'share' && latestMeta.shareEditGen > latestMeta.shareConfirmedGen && !latestMeta.shareCapacityBlocked)
        || (item.kind === 'project'
          && (getOwnDictValue(latestMeta.projEditGen, item.projectKey) ?? 0) > (getOwnDictValue(latestMeta.projConfirmedGen, item.projectKey) ?? 0)
          && !getOwnDictValue(latestMeta.projCapacityBlocked, item.projectKey)
          && getOwnDictValue(latestMeta.projRejectedEditGen, item.projectKey) !== getOwnDictValue(latestMeta.projEditGen, item.projectKey))
      ) {
        hasRemainingDirtyEdit = true;
      }
    } catch (err) {
      if (!isVoiceHotwordsScopeValid(snapshot)) return false;
      if (isCapacityError(err)) {
        // Recoverable account-wide capacity conflict: preserve dirty editGen, pause retry until next fresh server snapshot (no 300ms spin)
        const latestMeta = readSyncMeta(accountKey);
        if (item.kind === 'user' && latestMeta.userEditGen === item.editGen) {
          latestMeta.userCapacityBlocked = true;
        } else if (item.kind === 'share' && latestMeta.shareEditGen === item.editGen) {
          latestMeta.shareCapacityBlocked = true;
        } else if (item.kind === 'project' && (getOwnDictValue(latestMeta.projEditGen, item.projectKey) ?? 0) === item.editGen) {
          setOwnDictValue(latestMeta.projCapacityBlocked, item.projectKey, true);
        }
        writeSyncMeta(accountKey, latestMeta);
      } else if (isClientValidationError(err)) {
        // Non-recoverable scope validation error: quarantine only this editGen until user edits again
        const latestMeta = readSyncMeta(accountKey);
        if (item.kind === 'user' && latestMeta.userEditGen === item.editGen) {
          latestMeta.userRejectedEditGen = item.editGen;
        } else if (item.kind === 'project' && (getOwnDictValue(latestMeta.projEditGen, item.projectKey) ?? 0) === item.editGen) {
          setOwnDictValue(latestMeta.projRejectedEditGen, item.projectKey, item.editGen);
        }
        writeSyncMeta(accountKey, latestMeta);
      }
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
