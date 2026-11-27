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
  type VoiceHotwordsAppliedScopes,
  type VoiceHotwordsPutRequest,
  type VoiceHotwordsPutResponse,
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
  updateRecord: (
    payload: VoiceHotwordsPutRequest,
    options: VoiceHotwordsSyncRequestOptions,
  ) => Promise<VoiceHotwordsPutResponse | VoiceHotwordsSyncRecord | null>;
}

interface PendingWriteRecord {
  id: string;
  editGen: number;
}

interface AccountSyncQueueState {
  readonly epoch: number;
  readonly controller: AbortController;
  tail: Promise<void>;
  activeOps: number;
}

interface LocalVoiceHotwordsSyncMeta {
  userEditGen: number;
  userConfirmedGen: number;
  userBaseServerUpdatedAt: number;
  userServerUpdatedAt: number;
  userRejectedEditGen: number;
  userCapacityBlocked: boolean;
  userPendingWrite: PendingWriteRecord | null;

  projEditGen: Record<string, number>;
  projConfirmedGen: Record<string, number>;
  projBaseServerUpdatedAt: Record<string, number>;
  projServerUpdatedAt: Record<string, number>;
  projRejectedEditGen: Record<string, number>;
  projCapacityBlocked: Record<string, boolean>;
  projPendingWrite: Record<string, PendingWriteRecord>;

  shareEditGen: number;
  shareConfirmedGen: number;
  shareBaseServerUpdatedAt: number;
  shareServerUpdatedAt: number;
  shareCapacityBlocked: boolean;
  sharePendingWrite: PendingWriteRecord | null;

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
let _currentSyncQueue: AccountSyncQueueState | null = null;
let _inFlightSyncPromise: Promise<void> | null = null;
let _inFlightSyncEpoch = -1;
let _remoteSyncTriggeredEpoch = -1;
let _writeIdCounter = 0;
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
    userPendingWrite: null,
    projEditGen: createNullProtoDict<number>(),
    projConfirmedGen: createNullProtoDict<number>(),
    projBaseServerUpdatedAt: createNullProtoDict<number>(),
    projServerUpdatedAt: createNullProtoDict<number>(),
    projRejectedEditGen: createNullProtoDict<number>(),
    projCapacityBlocked: createNullProtoDict<boolean>(),
    projPendingWrite: createNullProtoDict<PendingWriteRecord>(),
    shareEditGen: 0,
    shareConfirmedGen: 0,
    shareBaseServerUpdatedAt: 0,
    shareServerUpdatedAt: 0,
    shareCapacityBlocked: false,
    sharePendingWrite: null,
    initialMigrationDone: false,
  };
}

function coerceNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function coercePendingWriteRecord(input: unknown): PendingWriteRecord | null {
  const candidate = Array.isArray(input) ? input[0] : input;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const obj = candidate as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  const editGen = coerceNum(obj.editGen);
  if (id && id.length <= 64 && editGen > 0) {
    return { id, editGen };
  }
  return null;
}

function coercePendingWriteMap(input: unknown): Record<string, PendingWriteRecord> {
  const out = createNullProtoDict<PendingWriteRecord>();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const cleanKey = normalizeVoiceHotwordProjectKey(k);
    if (!cleanKey) continue;
    const rec = coercePendingWriteRecord(v);
    if (rec) setOwnDictValue(out, cleanKey, rec);
  }
  return out;
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
  if (_currentSyncQueue) {
    _currentSyncQueue.controller.abort();
    _currentSyncQueue = null;
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
      userPendingWrite: coercePendingWriteRecord(parsed.userPendingWrite ?? parsed.userUnconfirmedWrites),
      projEditGen: coerceNumMap(parsed.projEditGen),
      projConfirmedGen: coerceNumMap(parsed.projConfirmedGen),
      projBaseServerUpdatedAt: coerceNumMap(parsed.projBaseServerUpdatedAt),
      projServerUpdatedAt: coerceNumMap(parsed.projServerUpdatedAt),
      projRejectedEditGen: coerceNumMap(parsed.projRejectedEditGen),
      projCapacityBlocked: coerceBoolMap(parsed.projCapacityBlocked),
      projPendingWrite: coercePendingWriteMap(parsed.projPendingWrite ?? parsed.projUnconfirmedWrites),
      shareEditGen: coerceNum(parsed.shareEditGen),
      shareConfirmedGen: coerceNum(parsed.shareConfirmedGen),
      shareBaseServerUpdatedAt: coerceNum(parsed.shareBaseServerUpdatedAt),
      shareServerUpdatedAt: coerceNum(parsed.shareServerUpdatedAt),
      shareCapacityBlocked: parsed.shareCapacityBlocked === true,
      sharePendingWrite: coercePendingWriteRecord(parsed.sharePendingWrite ?? parsed.shareUnconfirmedWrites),
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
export function setVoiceHotwordsAuthScope(
  auth: VoiceHotwordsAuthScope | null | undefined,
  options: { sync?: boolean } = {},
): void {
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
  }
  if (
    options.sync !== false
    && _syncClient
    && isRemoteSyncEligibleAccountKey(nextKey)
    && _remoteSyncTriggeredEpoch !== _scopeEpoch
  ) {
    _remoteSyncTriggeredEpoch = _scopeEpoch;
    void syncVoiceHotwordsFromServer();
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
  _remoteSyncTriggeredEpoch = -1;
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
  | { kind: 'user'; editGen: number; baseUpdatedAt: number; sentRaw: string; payload: VoiceHotwordsPutRequest }
  | { kind: 'project'; projectKey: string; editGen: number; baseUpdatedAt: number; sentRaw: string; payload: VoiceHotwordsPutRequest }
  | { kind: 'share'; editGen: number; baseUpdatedAt: number; sentEnabled: boolean; payload: VoiceHotwordsPutRequest };

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
      sentRaw: localGlobal,
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
      sentRaw: raw,
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
      sentEnabled: localShare,
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
  | { kind: 'user'; editGen: number; baseUpdatedAt: number; writeId?: string; sentRaw: string; applied?: boolean }
  | { kind: 'project'; projectKey: string; editGen: number; baseUpdatedAt: number; writeId?: string; sentRaw: string; applied?: boolean }
  | { kind: 'share'; editGen: number; baseUpdatedAt: number; writeId?: string; sentEnabled: boolean; applied?: boolean };

function rawDiffers(a: string, b: string): boolean {
  return normalizeVoiceHotwordRawText(a) !== normalizeVoiceHotwordRawText(b) || (!a && b !== '');
}

function mintVoiceHotwordsWriteId(): string {
  _writeIdCounter = (_writeIdCounter + 1) % 1_000_000_000;
  const uuid = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${_writeIdCounter}`;
  return `vhw_${uuid}`.slice(0, 64);
}

function resolveOrAllocatePendingWrite(
  current: PendingWriteRecord | null | undefined,
  editGen: number,
): { writeId: string; record: PendingWriteRecord; changed: boolean } {
  if (current && current.editGen === editGen) {
    return { writeId: current.id, record: current, changed: false };
  }
  const writeId = mintVoiceHotwordsWriteId();
  return { writeId, record: { id: writeId, editGen }, changed: true };
}

function prepareScopePushWriteId(accountKey: string, item: PendingScopePush): string {
  const meta = readSyncMeta(accountKey);
  if (item.kind === 'user') {
    const res = resolveOrAllocatePendingWrite(meta.userPendingWrite, item.editGen);
    if (res.changed) {
      meta.userPendingWrite = res.record;
      writeSyncMeta(accountKey, meta);
    }
    return res.writeId;
  }
  if (item.kind === 'share') {
    const res = resolveOrAllocatePendingWrite(meta.sharePendingWrite, item.editGen);
    if (res.changed) {
      meta.sharePendingWrite = res.record;
      writeSyncMeta(accountKey, meta);
    }
    return res.writeId;
  }
  const existing = getOwnDictValue(meta.projPendingWrite, item.projectKey);
  const res = resolveOrAllocatePendingWrite(existing, item.editGen);
  if (res.changed) {
    setOwnDictValue(meta.projPendingWrite, item.projectKey, res.record);
    writeSyncMeta(accountKey, meta);
  }
  return res.writeId;
}

function clearScopePendingWriteIfMatches(
  accountKey: string,
  item: PendingScopePush,
  editGen: number,
): void {
  const meta = readSyncMeta(accountKey);
  let mutated = false;
  if (item.kind === 'user' && meta.userPendingWrite?.editGen === editGen) {
    meta.userPendingWrite = null;
    mutated = true;
  } else if (item.kind === 'share' && meta.sharePendingWrite?.editGen === editGen) {
    meta.sharePendingWrite = null;
    mutated = true;
  } else if (item.kind === 'project') {
    const existing = getOwnDictValue(meta.projPendingWrite, item.projectKey);
    if (existing?.editGen === editGen) {
      deleteOwnDictKey(meta.projPendingWrite, item.projectKey);
      mutated = true;
    }
  }
  if (mutated) writeSyncMeta(accountKey, meta);
}

function hasAmbiguousPriorPendingWrite(meta: LocalVoiceHotwordsSyncMeta, pushes: PendingScopePush[]): boolean {
  for (const item of pushes) {
    if (item.kind === 'user') {
      if (meta.userPendingWrite && meta.userPendingWrite.editGen < item.editGen) return true;
    } else if (item.kind === 'share') {
      if (meta.sharePendingWrite && meta.sharePendingWrite.editGen < item.editGen) return true;
    } else {
      const pending = getOwnDictValue(meta.projPendingWrite, item.projectKey);
      if (pending && pending.editGen < item.editGen) return true;
    }
  }
  return false;
}

function resolveScopeAppliedFlag(
  item: PendingScopePush,
  topApplied: unknown,
  appliedScopes: VoiceHotwordsAppliedScopes | undefined,
): boolean | undefined {
  if (item.kind === 'user' && typeof appliedScopes?.user === 'boolean') return appliedScopes.user;
  if (item.kind === 'share' && typeof appliedScopes?.shareWithOthers === 'boolean') return appliedScopes.shareWithOthers;
  if (
    item.kind === 'project'
    && appliedScopes?.projects
    && typeof getOwnDictValue(appliedScopes.projects, item.projectKey) === 'boolean'
  ) {
    return getOwnDictValue(appliedScopes.projects, item.projectKey);
  }
  return typeof topApplied === 'boolean' ? topApplied : undefined;
}

function reconcileWithServerRecord(
  accountKey: string,
  server: VoiceHotwordsSyncRecord,
  confirmed?: ConfirmedScopePush,
  markInitialMigrated = false,
): { pendingPushes: PendingScopePush[]; changedUi: boolean; caughtUpFromOwnWrite: boolean } {
  const meta = readSyncMeta(accountKey);
  const fromServerFetch = confirmed === undefined;
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
  let caughtUpFromOwnWrite = false;

  // 1. User global scope
  {
    const srvRaw = server.user.raw;
    const srvTs = server.user.updatedAt;
    const srvLastWriteId = server.user.lastWriteId;
    const pendingWrite = meta.userPendingWrite;
    const matchedOwnWrite = srvLastWriteId && pendingWrite && pendingWrite.id === srvLastWriteId
      ? pendingWrite
      : undefined;
    const prevBaseTs = meta.userBaseServerUpdatedAt;
    meta.userServerUpdatedAt = srvTs;

    if (confirmed?.kind === 'user' && meta.userEditGen === confirmed.editGen) {
      if (confirmed.applied === false && matchedOwnWrite && matchedOwnWrite.editGen < meta.userEditGen) {
        meta.userConfirmedGen = Math.max(meta.userConfirmedGen, matchedOwnWrite.editGen);
        meta.userBaseServerUpdatedAt = srvTs;
        meta.userCapacityBlocked = false;
        meta.userPendingWrite = null;
        caughtUpFromOwnWrite = true;
      } else {
        if (rawDiffers(srvRaw, localGlobal)) {
          localGlobal = srvRaw;
          globalChanged = true;
          changedUi = true;
        }
        meta.userConfirmedGen = meta.userEditGen;
        meta.userBaseServerUpdatedAt = srvTs;
        meta.userRejectedEditGen = 0;
        meta.userCapacityBlocked = false;
        meta.userPendingWrite = null;
      }
    } else if (confirmed?.kind === 'user' && meta.userEditGen > confirmed.editGen) {
      const confirmedApplied = confirmed.applied === true
        || matchedOwnWrite !== undefined
        || (confirmed.applied === undefined && srvTs > confirmed.baseUpdatedAt && !rawDiffers(srvRaw, confirmed.sentRaw));
      if (confirmedApplied) {
        const resolvedGen = matchedOwnWrite
          ? Math.max(confirmed.applied ? confirmed.editGen : 0, matchedOwnWrite.editGen)
          : confirmed.editGen;
        meta.userConfirmedGen = Math.max(meta.userConfirmedGen, resolvedGen);
        if (meta.userBaseServerUpdatedAt === confirmed.baseUpdatedAt && srvTs > confirmed.baseUpdatedAt) {
          meta.userBaseServerUpdatedAt = srvTs;
        }
        meta.userCapacityBlocked = false;
        if (meta.userPendingWrite && meta.userPendingWrite.editGen <= meta.userConfirmedGen) {
          meta.userPendingWrite = null;
        }
        if (confirmed.applied === false && matchedOwnWrite) {
          caughtUpFromOwnWrite = true;
        }
      } else {
        if (rawDiffers(srvRaw, localGlobal)) {
          localGlobal = srvRaw;
          globalChanged = true;
          changedUi = true;
        }
        meta.userConfirmedGen = meta.userEditGen;
        meta.userBaseServerUpdatedAt = srvTs;
        meta.userRejectedEditGen = 0;
        meta.userCapacityBlocked = false;
        meta.userPendingWrite = null;
      }
    } else if (meta.userEditGen > meta.userConfirmedGen) {
      if (srvTs > prevBaseTs) {
        if (matchedOwnWrite) {
          meta.userConfirmedGen = Math.max(meta.userConfirmedGen, matchedOwnWrite.editGen);
          meta.userBaseServerUpdatedAt = srvTs;
          meta.userCapacityBlocked = false;
          meta.userPendingWrite = null;
          if (meta.userEditGen === meta.userConfirmedGen && rawDiffers(srvRaw, localGlobal)) {
            localGlobal = srvRaw;
            globalChanged = true;
            changedUi = true;
          }
          caughtUpFromOwnWrite = true;
        } else {
          if (rawDiffers(srvRaw, localGlobal)) {
            localGlobal = srvRaw;
            globalChanged = true;
            changedUi = true;
          }
          meta.userConfirmedGen = meta.userEditGen;
          meta.userBaseServerUpdatedAt = srvTs;
          meta.userRejectedEditGen = 0;
          meta.userCapacityBlocked = false;
          meta.userPendingWrite = null;
        }
      } else if (fromServerFetch && meta.userPendingWrite) {
        // Authoritative GET shows server did not advance beyond prevBaseTs: prior pendingWrite never committed
        meta.userPendingWrite = null;
      }
    } else if (!meta.initialMigrationDone && localGlobal.length > 0 && srvTs === 0) {
      if (localGlobal.length <= VOICE_HOTWORDS_MAX_RAW_CHARS) {
        meta.userEditGen += 1;
        meta.userBaseServerUpdatedAt = 0;
      }
    } else {
      if (rawDiffers(srvRaw, localGlobal)) {
        localGlobal = srvRaw;
        globalChanged = true;
        changedUi = true;
      }
      meta.userBaseServerUpdatedAt = srvTs;
      meta.userPendingWrite = null;
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
    const pendingWrite = getOwnDictValue(meta.projPendingWrite, key);

    const srvEntry = getOwnDictValue(server.projects, key);
    const srvTs = srvEntry?.updatedAt ?? 0;
    const srvRaw = srvEntry?.raw ?? '';
    const srvLastWriteId = srvEntry?.lastWriteId;
    const matchedOwnWrite = srvLastWriteId && pendingWrite && pendingWrite.id === srvLastWriteId
      ? pendingWrite
      : undefined;

    if (srvTs > 0) {
      setOwnDictValue(meta.projServerUpdatedAt, key, srvTs);
    } else if (!isDirty && !isRejected && !isOversizedLocal) {
      deleteOwnDictKey(meta.projServerUpdatedAt, key);
    }

    if (confirmed?.kind === 'project' && confirmed.projectKey === key && editGen === confirmed.editGen) {
      if (confirmed.applied === false && matchedOwnWrite && matchedOwnWrite.editGen < editGen) {
        const nextConfirmed = Math.max(confirmedGen, matchedOwnWrite.editGen);
        setOwnDictValue(meta.projConfirmedGen, key, nextConfirmed);
        setOwnDictValue(meta.projBaseServerUpdatedAt, key, srvTs);
        deleteOwnDictKey(meta.projCapacityBlocked, key);
        deleteOwnDictKey(meta.projPendingWrite, key);
        caughtUpFromOwnWrite = true;
      } else {
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
        deleteOwnDictKey(meta.projPendingWrite, key);
      }
    } else if (confirmed?.kind === 'project' && confirmed.projectKey === key && editGen > confirmed.editGen) {
      const confirmedApplied = confirmed.applied === true
        || matchedOwnWrite !== undefined
        || (confirmed.applied === undefined && srvTs > confirmed.baseUpdatedAt && !rawDiffers(srvRaw, confirmed.sentRaw));
      if (confirmedApplied) {
        const resolvedGen = matchedOwnWrite
          ? Math.max(confirmed.applied ? confirmed.editGen : 0, matchedOwnWrite.editGen)
          : confirmed.editGen;
        const nextConfirmed = Math.max(confirmedGen, resolvedGen);
        setOwnDictValue(meta.projConfirmedGen, key, nextConfirmed);
        if (prevBaseTs === confirmed.baseUpdatedAt && srvTs > confirmed.baseUpdatedAt) {
          setOwnDictValue(meta.projBaseServerUpdatedAt, key, srvTs);
        }
        deleteOwnDictKey(meta.projCapacityBlocked, key);
        if (pendingWrite && pendingWrite.editGen <= nextConfirmed) {
          deleteOwnDictKey(meta.projPendingWrite, key);
        }
        if (confirmed.applied === false && matchedOwnWrite) {
          caughtUpFromOwnWrite = true;
        }
      } else {
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
        deleteOwnDictKey(meta.projPendingWrite, key);
      }
    } else if (isDirty) {
      if (srvTs > prevBaseTs) {
        if (matchedOwnWrite) {
          const nextConfirmed = Math.max(confirmedGen, matchedOwnWrite.editGen);
          setOwnDictValue(meta.projConfirmedGen, key, nextConfirmed);
          setOwnDictValue(meta.projBaseServerUpdatedAt, key, srvTs);
          deleteOwnDictKey(meta.projCapacityBlocked, key);
          deleteOwnDictKey(meta.projPendingWrite, key);
          if (editGen === nextConfirmed && rawDiffers(srvRaw, localRaw)) {
            if (!srvRaw) deleteOwnDictKey(localProjects, key);
            else setOwnDictValue(localProjects, key, srvRaw);
            projectsChanged = true;
            changedUi = true;
          }
          caughtUpFromOwnWrite = true;
        } else {
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
          deleteOwnDictKey(meta.projPendingWrite, key);
        }
      } else if (fromServerFetch && pendingWrite) {
        deleteOwnDictKey(meta.projPendingWrite, key);
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
      deleteOwnDictKey(meta.projPendingWrite, key);
    } else if (srvTs === 0 && meta.initialMigrationDone && wasConfirmedOnServer && !isRejected && !isOversizedLocal && localRaw !== '') {
      deleteOwnDictKey(localProjects, key);
      deleteOwnDictKey(meta.projBaseServerUpdatedAt, key);
      deleteOwnDictKey(meta.projPendingWrite, key);
      projectsChanged = true;
      changedUi = true;
    }
  }

  // 3. Share consent scope
  {
    const srvEnabled = server.shareWithOthers.enabled;
    const srvTs = server.shareWithOthers.updatedAt;
    const srvLastWriteId = server.shareWithOthers.lastWriteId;
    const pendingWrite = meta.sharePendingWrite;
    const matchedOwnWrite = srvLastWriteId && pendingWrite && pendingWrite.id === srvLastWriteId
      ? pendingWrite
      : undefined;
    const prevBaseTs = meta.shareBaseServerUpdatedAt;
    meta.shareServerUpdatedAt = srvTs;

    if (confirmed?.kind === 'share' && meta.shareEditGen === confirmed.editGen) {
      if (confirmed.applied === false && matchedOwnWrite && matchedOwnWrite.editGen < meta.shareEditGen) {
        meta.shareConfirmedGen = Math.max(meta.shareConfirmedGen, matchedOwnWrite.editGen);
        meta.shareBaseServerUpdatedAt = srvTs;
        meta.shareCapacityBlocked = false;
        meta.sharePendingWrite = null;
        caughtUpFromOwnWrite = true;
      } else {
        if (srvEnabled !== localShare) {
          localShare = srvEnabled;
          shareChanged = true;
          changedUi = true;
        }
        meta.shareConfirmedGen = meta.shareEditGen;
        meta.shareBaseServerUpdatedAt = srvTs;
        meta.shareCapacityBlocked = false;
        meta.sharePendingWrite = null;
      }
    } else if (confirmed?.kind === 'share' && meta.shareEditGen > confirmed.editGen) {
      const confirmedApplied = confirmed.applied === true
        || matchedOwnWrite !== undefined
        || (confirmed.applied === undefined && srvTs > confirmed.baseUpdatedAt && srvEnabled === confirmed.sentEnabled);
      if (confirmedApplied) {
        const resolvedGen = matchedOwnWrite
          ? Math.max(confirmed.applied ? confirmed.editGen : 0, matchedOwnWrite.editGen)
          : confirmed.editGen;
        meta.shareConfirmedGen = Math.max(meta.shareConfirmedGen, resolvedGen);
        if (meta.shareBaseServerUpdatedAt === confirmed.baseUpdatedAt && srvTs > confirmed.baseUpdatedAt) {
          meta.shareBaseServerUpdatedAt = srvTs;
        }
        meta.shareCapacityBlocked = false;
        if (meta.sharePendingWrite && meta.sharePendingWrite.editGen <= meta.shareConfirmedGen) {
          meta.sharePendingWrite = null;
        }
        if (confirmed.applied === false && matchedOwnWrite) {
          caughtUpFromOwnWrite = true;
        }
      } else {
        if (srvEnabled !== localShare) {
          localShare = srvEnabled;
          shareChanged = true;
          changedUi = true;
        }
        meta.shareConfirmedGen = meta.shareEditGen;
        meta.shareBaseServerUpdatedAt = srvTs;
        meta.shareCapacityBlocked = false;
        meta.sharePendingWrite = null;
      }
    } else if (meta.shareEditGen > meta.shareConfirmedGen) {
      if (srvTs > prevBaseTs) {
        if (matchedOwnWrite) {
          meta.shareConfirmedGen = Math.max(meta.shareConfirmedGen, matchedOwnWrite.editGen);
          meta.shareBaseServerUpdatedAt = srvTs;
          meta.shareCapacityBlocked = false;
          meta.sharePendingWrite = null;
          if (meta.shareEditGen === meta.shareConfirmedGen && srvEnabled !== localShare) {
            localShare = srvEnabled;
            shareChanged = true;
            changedUi = true;
          }
          caughtUpFromOwnWrite = true;
        } else {
          if (srvEnabled !== localShare) {
            localShare = srvEnabled;
            shareChanged = true;
            changedUi = true;
          }
          meta.shareConfirmedGen = meta.shareEditGen;
          meta.shareBaseServerUpdatedAt = srvTs;
          meta.shareCapacityBlocked = false;
          meta.sharePendingWrite = null;
        }
      } else if (fromServerFetch && meta.sharePendingWrite) {
        meta.sharePendingWrite = null;
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
      meta.sharePendingWrite = null;
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
    caughtUpFromOwnWrite,
  };
}

function isSameScopePush(a: PendingScopePush, b: PendingScopePush): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'project' && b.kind === 'project') return a.projectKey === b.projectKey;
  return true;
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
  for (const initialItem of initialPushes) {
    let item: PendingScopePush | undefined = initialItem;
    let catchupRetries = 2;

    while (item) {
      if (!isVoiceHotwordsScopeValid(snapshot) || signal.aborted) return false;
      const currentItem: PendingScopePush = item;
      item = undefined;

      try {
        const writeId = prepareScopePushWriteId(accountKey, currentItem);
        const payloadWithWriteId = { ...currentItem.payload, writeId } as VoiceHotwordsPutRequest;
        const rawRes = await _syncClient.updateRecord(payloadWithWriteId, {
          expectedUserId,
          signal,
        });
        if (!rawRes || !isVoiceHotwordsScopeValid(snapshot) || signal.aborted) return false;

        const serverRecord = 'record' in rawRes ? rawRes.record : rawRes;
        const appliedScopes = 'appliedScopes' in rawRes ? rawRes.appliedScopes : undefined;
        const scopeApplied = 'record' in rawRes
          ? resolveScopeAppliedFlag(currentItem, rawRes.applied, appliedScopes)
          : undefined;

        const confirmed: ConfirmedScopePush = currentItem.kind === 'user'
          ? {
            kind: 'user',
            editGen: currentItem.editGen,
            baseUpdatedAt: currentItem.baseUpdatedAt,
            writeId,
            sentRaw: currentItem.sentRaw,
            applied: scopeApplied,
          }
          : currentItem.kind === 'share'
            ? {
              kind: 'share',
              editGen: currentItem.editGen,
              baseUpdatedAt: currentItem.baseUpdatedAt,
              writeId,
              sentEnabled: currentItem.sentEnabled,
              applied: scopeApplied,
            }
            : {
              kind: 'project',
              projectKey: currentItem.projectKey,
              editGen: currentItem.editGen,
              baseUpdatedAt: currentItem.baseUpdatedAt,
              writeId,
              sentRaw: currentItem.sentRaw,
              applied: scopeApplied,
            };

        const post = reconcileWithServerRecord(accountKey, serverRecord, confirmed);
        if (post.changedUi) notifyChange();

        if (post.caughtUpFromOwnWrite && catchupRetries > 0) {
          const matchingNext: PendingScopePush | undefined = post.pendingPushes.find((nextPush) => isSameScopePush(nextPush, currentItem));
          if (matchingNext) {
            catchupRetries -= 1;
            item = matchingNext;
            continue;
          }
        }

        const latestMeta = readSyncMeta(accountKey);
        if (
          (currentItem.kind === 'user' && latestMeta.userEditGen > latestMeta.userConfirmedGen && !latestMeta.userCapacityBlocked && latestMeta.userRejectedEditGen !== latestMeta.userEditGen)
          || (currentItem.kind === 'share' && latestMeta.shareEditGen > latestMeta.shareConfirmedGen && !latestMeta.shareCapacityBlocked)
          || (currentItem.kind === 'project'
            && (getOwnDictValue(latestMeta.projEditGen, currentItem.projectKey) ?? 0) > (getOwnDictValue(latestMeta.projConfirmedGen, currentItem.projectKey) ?? 0)
            && !getOwnDictValue(latestMeta.projCapacityBlocked, currentItem.projectKey)
            && getOwnDictValue(latestMeta.projRejectedEditGen, currentItem.projectKey) !== getOwnDictValue(latestMeta.projEditGen, currentItem.projectKey))
        ) {
          hasRemainingDirtyEdit = true;
        }
      } catch (err) {
        if (!isVoiceHotwordsScopeValid(snapshot) || signal.aborted) return false;
        if (isCapacityError(err)) {
          // Recoverable account-wide capacity conflict: server rejected deterministically -> clear unconfirmed writeId and pause retry until next snapshot
          clearScopePendingWriteIfMatches(accountKey, currentItem, currentItem.editGen);
          const latestMeta = readSyncMeta(accountKey);
          if (currentItem.kind === 'user' && latestMeta.userEditGen === currentItem.editGen) {
            latestMeta.userCapacityBlocked = true;
          } else if (currentItem.kind === 'share' && latestMeta.shareEditGen === currentItem.editGen) {
            latestMeta.shareCapacityBlocked = true;
          } else if (currentItem.kind === 'project' && (getOwnDictValue(latestMeta.projEditGen, currentItem.projectKey) ?? 0) === currentItem.editGen) {
            setOwnDictValue(latestMeta.projCapacityBlocked, currentItem.projectKey, true);
          }
          writeSyncMeta(accountKey, latestMeta);
        } else if (isClientValidationError(err)) {
          // Non-recoverable scope validation error: server rejected deterministically -> clear unconfirmed writeId & quarantine this editGen
          clearScopePendingWriteIfMatches(accountKey, currentItem, currentItem.editGen);
          const latestMeta = readSyncMeta(accountKey);
          if (currentItem.kind === 'user' && latestMeta.userEditGen === currentItem.editGen) {
            latestMeta.userRejectedEditGen = currentItem.editGen;
          } else if (currentItem.kind === 'project' && (getOwnDictValue(latestMeta.projEditGen, currentItem.projectKey) ?? 0) === currentItem.editGen) {
            setOwnDictValue(latestMeta.projRejectedEditGen, currentItem.projectKey, currentItem.editGen);
          }
          writeSyncMeta(accountKey, latestMeta);
        }
      }
    }
  }
  return hasRemainingDirtyEdit;
}

function enqueueAccountSyncOperation<T>(
  snapshot: VoiceHotwordsScopeSnapshot,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  if (!isVoiceHotwordsScopeValid(snapshot) || _scopeEpoch !== snapshot.epoch) {
    return Promise.resolve(undefined);
  }
  let queue = _currentSyncQueue;
  if (!queue || queue.epoch !== snapshot.epoch) {
    queue = {
      epoch: snapshot.epoch,
      controller: new AbortController(),
      tail: Promise.resolve(),
      activeOps: 0,
    };
    _currentSyncQueue = queue;
  }
  const targetQueue = queue;
  const execute = async (): Promise<T | undefined> => {
    if (
      targetQueue.controller.signal.aborted
      || !isVoiceHotwordsScopeValid(snapshot)
      || _scopeEpoch !== targetQueue.epoch
    ) {
      return undefined;
    }
    return task(targetQueue.controller.signal);
  };

  targetQueue.activeOps += 1;
  const next = (
    targetQueue.activeOps === 1
      ? execute()
      : targetQueue.tail.catch(() => undefined).then(() => execute())
  ).finally(() => {
    targetQueue.activeOps = Math.max(0, targetQueue.activeOps - 1);
  });
  targetQueue.tail = next.then(() => undefined, () => undefined);
  return next;
}

export async function flushVoiceHotwordsPush(): Promise<void> {
  const snapshot = getVoiceHotwordsScopeSnapshot();
  const accountKey = snapshot.accountKey;
  if (!_syncClient || !isRemoteSyncEligibleAccountKey(accountKey) || !snapshot.userId) return;

  await enqueueAccountSyncOperation(snapshot, async (signal) => {
    let meta = readSyncMeta(accountKey);
    let pushes = collectDirtyScopePushes(accountKey, meta);
    if (pushes.length === 0) return;

    if (hasAmbiguousPriorPendingWrite(meta, pushes)) {
      try {
        const serverRecord = await _syncClient?.fetchRecord({
          expectedUserId: snapshot.userId!,
          signal,
        });
        if (!serverRecord || !isVoiceHotwordsScopeValid(snapshot) || signal.aborted) return;
        const reconciled = reconcileWithServerRecord(accountKey, serverRecord, undefined, true);
        if (reconciled.changedUi) {
          notifyChange();
        }
        meta = readSyncMeta(accountKey);
        pushes = reconciled.pendingPushes;
        if (pushes.length === 0) return;
      } catch {
        // Network/offline error resolving earlier pending write: retain pendingWriteId untouched for reconnect recovery
        return;
      }
    }

    const needsReschedule = await executeIsolatedPushes(snapshot, pushes, signal);
    if (needsReschedule && isVoiceHotwordsScopeValid(snapshot)) {
      scheduleVoiceHotwordsPush(snapshot);
    }
  });
}

export async function syncVoiceHotwordsFromServer(): Promise<void> {
  const snapshot = getVoiceHotwordsScopeSnapshot();
  const accountKey = snapshot.accountKey;
  if (!_syncClient || !isRemoteSyncEligibleAccountKey(accountKey) || !snapshot.userId) return;

  if (_inFlightSyncPromise && _inFlightSyncEpoch === snapshot.epoch) {
    return _inFlightSyncPromise;
  }

  const run = enqueueAccountSyncOperation(snapshot, async (signal) => {
    try {
      const serverRecord = await _syncClient?.fetchRecord({
        expectedUserId: snapshot.userId!,
        signal,
      });
      if (!serverRecord || !isVoiceHotwordsScopeValid(snapshot)) return;

      const reconciled = reconcileWithServerRecord(accountKey, serverRecord, undefined, true);
      if (reconciled.changedUi) {
        notifyChange();
      }
      if (reconciled.pendingPushes.length > 0) {
        const needsReschedule = await executeIsolatedPushes(snapshot, reconciled.pendingPushes, signal);
        if (needsReschedule && isVoiceHotwordsScopeValid(snapshot)) {
          scheduleVoiceHotwordsPush(snapshot);
        }
      }
    } catch {
      // Network/transient error: retain local data & dirty state silently
    }
  }).then(() => undefined);

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
