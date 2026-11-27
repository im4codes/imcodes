import type { ProviderQuotaMeta } from '@shared/provider-quota.js';
import type { SessionInfo } from './types.js';
import { isNavigableMainSession } from './session-list-merge.js';

export const SESSION_LIST_CACHE_STORAGE_KEY = 'imcodes_session_list_cache_v1';
export const MAX_CACHED_SERVERS = 16;
const MAX_CACHED_SESSIONS_PER_SERVER = 64;

interface CachedSessionSnapshot {
  name: string;
  project: string;
  role: SessionInfo['role'];
  agentType: string;
  agentVersion?: string;
  label?: string | null;
  description?: string | null;
  projectDir?: string;
  runtimeType?: SessionInfo['runtimeType'];
  providerId?: string;
  ccPreset?: string | null;
  modelDisplay?: string;
  activeModel?: string;
  requestedModel?: string;
  qwenModel?: string;
  qwenAuthType?: string;
  qwenAuthLimit?: string;
  qwenAvailableModels?: string[];
  codexAvailableModels?: string[];
  copilotAvailableModels?: string[];
  cursorAvailableModels?: string[];
  planLabel?: string;
  quotaLabel?: string;
  quotaUsageLabel?: string;
  quotaMeta?: ProviderQuotaMeta | null;
  codexCreditsBalance?: string;
  codexCreditsHasCredits?: boolean;
  codexCreditsUnlimited?: boolean;
}

interface CachedServerBucket {
  updatedAt: number;
  sessions: CachedSessionSnapshot[];
}

type SessionListCachePayload = Record<string, CachedServerBucket>;

function readCacheStore(storage: Storage): SessionListCachePayload {
  try {
    const raw = storage.getItem(SESSION_LIST_CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: SessionListCachePayload = {};
    for (const [serverId, bucket] of Object.entries(parsed as Record<string, unknown>)) {
      if (!serverId || !bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
      const b = bucket as { updatedAt?: unknown; sessions?: unknown };
      if (!Array.isArray(b.sessions)) continue;
      out[serverId] = {
        updatedAt: typeof b.updatedAt === 'number' && Number.isFinite(b.updatedAt) ? b.updatedAt : 0,
        sessions: b.sessions as CachedSessionSnapshot[],
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeCacheStore(storage: Storage, payload: SessionListCachePayload): void {
  try {
    const entries = Object.entries(payload);
    if (entries.length === 0) {
      storage.removeItem(SESSION_LIST_CACHE_STORAGE_KEY);
      return;
    }
    if (entries.length > MAX_CACHED_SERVERS) {
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      entries.length = MAX_CACHED_SERVERS;
    }
    const bounded: SessionListCachePayload = Object.fromEntries(entries);
    storage.setItem(SESSION_LIST_CACHE_STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // Storage quota exceeded or unavailable — degrade gracefully without throwing.
  }
}

function toLightweightSnapshot(session: SessionInfo): CachedSessionSnapshot | null {
  if (!isNavigableMainSession(session) || session.incognito === true) return null;
  if (!session.name || !session.project || !session.agentType) return null;
  return {
    name: session.name,
    project: session.project,
    role: session.role,
    agentType: session.agentType,
    ...(session.agentVersion !== undefined ? { agentVersion: session.agentVersion } : {}),
    ...(session.label !== undefined ? { label: session.label } : {}),
    ...(session.description !== undefined ? { description: session.description } : {}),
    ...(session.projectDir !== undefined ? { projectDir: session.projectDir } : {}),
    ...(session.runtimeType !== undefined ? { runtimeType: session.runtimeType } : {}),
    ...(session.providerId !== undefined ? { providerId: session.providerId } : {}),
    ...(session.ccPreset !== undefined ? { ccPreset: session.ccPreset } : {}),
    ...(session.modelDisplay !== undefined ? { modelDisplay: session.modelDisplay } : {}),
    ...(session.activeModel !== undefined ? { activeModel: session.activeModel } : {}),
    ...(session.requestedModel !== undefined ? { requestedModel: session.requestedModel } : {}),
    ...(session.qwenModel !== undefined ? { qwenModel: session.qwenModel } : {}),
    ...(session.qwenAuthType !== undefined ? { qwenAuthType: session.qwenAuthType } : {}),
    ...(session.qwenAuthLimit !== undefined ? { qwenAuthLimit: session.qwenAuthLimit } : {}),
    ...(Array.isArray(session.qwenAvailableModels) ? { qwenAvailableModels: session.qwenAvailableModels } : {}),
    ...(Array.isArray(session.codexAvailableModels) ? { codexAvailableModels: session.codexAvailableModels } : {}),
    ...(Array.isArray(session.copilotAvailableModels) ? { copilotAvailableModels: session.copilotAvailableModels } : {}),
    ...(Array.isArray(session.cursorAvailableModels) ? { cursorAvailableModels: session.cursorAvailableModels } : {}),
    ...(session.planLabel !== undefined ? { planLabel: session.planLabel } : {}),
    ...(session.quotaLabel !== undefined ? { quotaLabel: session.quotaLabel } : {}),
    ...(session.quotaUsageLabel !== undefined ? { quotaUsageLabel: session.quotaUsageLabel } : {}),
    ...(session.quotaMeta !== undefined ? { quotaMeta: session.quotaMeta } : {}),
    ...(session.codexCreditsBalance !== undefined ? { codexCreditsBalance: session.codexCreditsBalance } : {}),
    ...(session.codexCreditsHasCredits !== undefined ? { codexCreditsHasCredits: session.codexCreditsHasCredits } : {}),
    ...(session.codexCreditsUnlimited !== undefined ? { codexCreditsUnlimited: session.codexCreditsUnlimited } : {}),
  };
}

function hydrateCachedSnapshot(raw: unknown): SessionInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (s.incognito === true) return null;
  if (
    typeof s.name !== 'string' || !s.name
    || typeof s.project !== 'string' || !s.project
    || typeof s.role !== 'string'
    || typeof s.agentType !== 'string' || !s.agentType
  ) {
    return null;
  }
  if (!isNavigableMainSession({ name: s.name, role: s.role })) return null;
  return {
    name: s.name,
    project: s.project,
    role: s.role as SessionInfo['role'],
    agentType: s.agentType,
    // Always restore cached tabs as 'unknown' until authoritative WS/REST confirms live state.
    state: 'unknown',
    ...(typeof s.agentVersion === 'string' ? { agentVersion: s.agentVersion } : {}),
    ...(typeof s.label === 'string' || s.label === null ? { label: s.label as string | null } : {}),
    ...(typeof s.description === 'string' || s.description === null ? { description: s.description as string | null } : {}),
    ...(typeof s.projectDir === 'string' ? { projectDir: s.projectDir } : {}),
    ...(typeof s.runtimeType === 'string' ? { runtimeType: s.runtimeType as SessionInfo['runtimeType'] } : {}),
    ...(typeof s.providerId === 'string' ? { providerId: s.providerId } : {}),
    ...(typeof s.ccPreset === 'string' || s.ccPreset === null ? { ccPreset: s.ccPreset } : {}),
    ...(typeof s.modelDisplay === 'string' ? { modelDisplay: s.modelDisplay } : {}),
    ...(typeof s.activeModel === 'string' ? { activeModel: s.activeModel } : {}),
    ...(typeof s.requestedModel === 'string' ? { requestedModel: s.requestedModel } : {}),
    ...(typeof s.qwenModel === 'string' ? { qwenModel: s.qwenModel } : {}),
    ...(typeof s.qwenAuthType === 'string' ? { qwenAuthType: s.qwenAuthType } : {}),
    ...(typeof s.qwenAuthLimit === 'string' ? { qwenAuthLimit: s.qwenAuthLimit } : {}),
    ...(Array.isArray(s.qwenAvailableModels) ? { qwenAvailableModels: s.qwenAvailableModels.filter((m): m is string => typeof m === 'string') } : {}),
    ...(Array.isArray(s.codexAvailableModels) ? { codexAvailableModels: s.codexAvailableModels.filter((m): m is string => typeof m === 'string') } : {}),
    ...(Array.isArray(s.copilotAvailableModels) ? { copilotAvailableModels: s.copilotAvailableModels.filter((m): m is string => typeof m === 'string') } : {}),
    ...(Array.isArray(s.cursorAvailableModels) ? { cursorAvailableModels: s.cursorAvailableModels.filter((m): m is string => typeof m === 'string') } : {}),
    ...(typeof s.planLabel === 'string' ? { planLabel: s.planLabel } : {}),
    ...(typeof s.quotaLabel === 'string' ? { quotaLabel: s.quotaLabel } : {}),
    ...(typeof s.quotaUsageLabel === 'string' ? { quotaUsageLabel: s.quotaUsageLabel } : {}),
    ...(s.quotaMeta === null || (s.quotaMeta && typeof s.quotaMeta === 'object' && !Array.isArray(s.quotaMeta))
      ? { quotaMeta: s.quotaMeta as ProviderQuotaMeta | null }
      : {}),
    ...(typeof s.codexCreditsBalance === 'string' ? { codexCreditsBalance: s.codexCreditsBalance } : {}),
    ...(typeof s.codexCreditsHasCredits === 'boolean' ? { codexCreditsHasCredits: s.codexCreditsHasCredits } : {}),
    ...(typeof s.codexCreditsUnlimited === 'boolean' ? { codexCreditsUnlimited: s.codexCreditsUnlimited } : {}),
  };
}

/**
 * Read lightweight cached main tabs for an owned server.
 * Never throws on missing or corrupt storage; returns `[]` on fallback.
 */
export function readCachedServerSessions(serverId: string | null | undefined, storage: Storage = localStorage): SessionInfo[] {
  if (!serverId) return [];
  const store = readCacheStore(storage);
  const bucket = store[serverId];
  if (!bucket || !Array.isArray(bucket.sessions)) return [];
  const hydrated: SessionInfo[] = [];
  for (const item of bucket.sessions) {
    const next = hydrateCachedSnapshot(item);
    if (next) hydrated.push(next);
  }
  return hydrated;
}

/**
 * Persist lightweight main tabs for an owned server (excluding incognito sessions),
 * bounded to `MAX_CACHED_SERVERS` servers.
 */
export function writeCachedServerSessions(
  serverId: string | null | undefined,
  sessions: readonly SessionInfo[],
  storage: Storage = localStorage,
): void {
  if (!serverId) return;
  const snapshots: CachedSessionSnapshot[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    const snap = toLightweightSnapshot(session);
    if (!snap || seen.has(snap.name)) continue;
    seen.add(snap.name);
    snapshots.push(snap);
    if (snapshots.length >= MAX_CACHED_SESSIONS_PER_SERVER) break;
  }
  const store = readCacheStore(storage);
  if (snapshots.length === 0) {
    delete store[serverId];
  } else {
    store[serverId] = { updatedAt: Date.now(), sessions: snapshots };
  }
  writeCacheStore(storage, store);
}

/** Clear all cached owned-server session lists (e.g. on logout). */
export function clearCachedServerSessions(storage: Storage = localStorage): void {
  try {
    storage.removeItem(SESSION_LIST_CACHE_STORAGE_KEY);
  } catch {
    // Ignore restricted/unavailable storage.
  }
}
