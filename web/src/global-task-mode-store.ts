import {
  GLOBAL_TASK_MODE_MSG,
  GLOBAL_TASK_SNAPSHOT_PATH,
  GLOBAL_TASK_TICKET_PATH,
  GLOBAL_TASK_WS_PATH,
  isGlobalTaskAttentionNeeded,
  isGlobalTaskTerminalStatus,
  isGlobalTaskWithinSyncWindow,
  type GlobalTaskBrainSummary,
  type GlobalTaskBrainTextEvent,
  type GlobalTaskCompletionStats,
  type GlobalTaskNotificationEvent,
  type GlobalTaskServerFrame,
  type GlobalTaskServerSummary,
  type GlobalTaskSnapshotResponse,
  type GlobalTaskSummaryRow,
} from '@shared/global-task-mode.js';
import { SESSION_SEND_DELIVERY_MODES } from '@shared/session-send-delivery.js';
import { TASK_PAIR_CLOSE_ERROR, type TaskPairCloseAction, type TaskPairCloseResponse } from '@shared/task-pair-close.js';
import { fallbackReadableSessionDisplay, pickReadableSessionDisplay } from '@shared/session-display.js';
import { parseSyncedPreference, type SyncedPreferencePayload } from '@shared/synced-preference.js';
import { formatLabel } from './format-label.js';
import { ApiError, apiFetch, closeServerTaskPair, getApiBaseUrl, getUserPref, saveUserPref, sendSessionViaHttp } from './api.js';
import { isNative } from './native.js';
import { isPcAppDesktop } from './native-platform.js';

export const GLOBAL_TASK_MUTED_SERVERS_STORAGE_KEY = 'imcodes.global-task-mode.muted-servers';
export const GLOBAL_TASK_PINNED_BRAINS_STORAGE_KEY = 'imcodes.global-task-mode.pinned-brains';
export const GLOBAL_TASK_RECENT_BRAINS_STORAGE_KEY = 'imcodes.global-task-mode.recent-brains';
export const TASK_MODE_OPEN_STORAGE_KEY = 'imcodes:task-mode-open';
export const RELOAD_INTENT_STORAGE_KEY = 'imcodes:reload-intent';
export const MAX_RECENT_BRAINS = 8;

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 30_000;
const MAX_BRAIN_TEXT_CACHE_ENTRIES = 500;
const MAX_SEEN_BRAIN_EVENT_IDS = 1000;

export interface GlobalTaskPinnedBrain {
  serverId: string;
  sessionName: string;
  label?: string;
  projectName?: string;
}

export interface GlobalTaskRecentBrain extends GlobalTaskPinnedBrain {
  lastUsedAt: number;
}

export interface GlobalTaskQuickDispatchBrain {
  serverId: string;
  serverName: string;
  serverOnline: boolean;
  sessionName: string;
  projectName: string;
  label: string;
  state: string;
  agentType: string;
  pinned: boolean;
  recent: boolean;
  lastUsedAt?: number;
  serverPinned?: boolean;
  sessionPinned?: boolean;
}

export interface GlobalTaskQuickDispatchPinContext {
  pinnedServerIds?: ReadonlySet<string>;
  pinnedSessionNames?: ReadonlySet<string>;
  serverOrder?: readonly string[];
  tabOrder?: readonly string[];
}

export interface GlobalTaskModeState {
  connected: boolean;
  connecting: boolean;
  loading: boolean;
  error: string | null;
  snapshotSeq: number;
  tasks: GlobalTaskSummaryRow[];
  brains: GlobalTaskBrainSummary[];
  servers: GlobalTaskServerSummary[];
  stats: GlobalTaskCompletionStats | null;
  mutedServerIds: string[];
  pinnedBrains: GlobalTaskPinnedBrain[];
  recentBrains: GlobalTaskRecentBrain[];
  latestBrainTexts: Record<string, GlobalTaskBrainTextEvent>;
  lastSyncedAt: number | null;
}

export interface SendGlobalBrainMessageInput {
  serverId: string;
  sessionName: string;
  text: string;
  taskTitle?: string;
  locale?: string;
  projectName?: string;
  label?: string;
}

export type BrainTextListener = (event: GlobalTaskBrainTextEvent) => void;
export type NotificationListener = (event: GlobalTaskNotificationEvent) => void;
export type StoreListener = (state: GlobalTaskModeState) => void;

function readStorageJson<T>(key: string, fallback: T): T {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeStorageJson(key: string, value: unknown): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore restricted/quota-exceeded storage errors cleanly.
  }
}

function hasStoredMutedServerFilter(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(GLOBAL_TASK_MUTED_SERVERS_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function loadMutedServerIds(): string[] {
  const raw = readStorageJson<unknown>(GLOBAL_TASK_MUTED_SERVERS_STORAGE_KEY, []);
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((s) => s.trim()))];
}

/**
 * Compute default muted server IDs when the user has not explicitly customized the Task Mode server filter.
 * Defaults to showing only workspace-pinned servers, falling back to all servers when none match.
 */
export function computeDefaultMutedServerIds(
  servers: readonly GlobalTaskServerSummary[],
  pinnedServerIds?: ReadonlySet<string>,
): string[] {
  if (!pinnedServerIds || pinnedServerIds.size === 0 || servers.length === 0) {
    return [];
  }
  const hasMatchingPinned = servers.some((s) => pinnedServerIds.has(s.id));
  if (!hasMatchingPinned) {
    return [];
  }
  return servers.filter((s) => !pinnedServerIds.has(s.id)).map((s) => s.id);
}

function sanitizePinnedBrains(raw: unknown): GlobalTaskPinnedBrain[] {
  if (!Array.isArray(raw)) return [];
  const out: GlobalTaskPinnedBrain[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const serverId = typeof obj.serverId === 'string' ? obj.serverId.trim() : '';
    const sessionName = typeof obj.sessionName === 'string' ? obj.sessionName.trim() : '';
    if (!serverId || !sessionName) continue;
    const key = brainKey(serverId, sessionName);
    if (seen.has(key)) continue;
    seen.add(key);
    const rawLabel = typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim() : undefined;
    const projectName = typeof obj.projectName === 'string' && obj.projectName.trim() ? obj.projectName.trim() : undefined;
    const label = rawLabel ? normalizeStoredSessionLabel(rawLabel, projectName, sessionName) : undefined;
    out.push({
      serverId,
      sessionName,
      ...(label ? { label } : {}),
      ...(projectName ? { projectName } : {}),
    });
  }
  return out;
}

function parsePinnedBrainsEnvelope(raw: unknown): SyncedPreferencePayload<GlobalTaskPinnedBrain[]> | null {
  const parsed = parseSyncedPreference<unknown>(raw);
  if (!parsed || !Array.isArray(parsed.v)) return null;
  return { v: sanitizePinnedBrains(parsed.v), t: parsed.t };
}

function parsePinnedBrainsLocalValue(rawText: string | null): SyncedPreferencePayload<GlobalTaskPinnedBrain[]> | null {
  if (!rawText) return null;
  const envelope = parsePinnedBrainsEnvelope(rawText);
  if (envelope) return envelope;
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (Array.isArray(parsed)) {
      const migrated = sanitizePinnedBrains(parsed);
      // Empty legacy un-enveloped array has no write timestamp (treat as t=0 untouched default)
      // so a fresh device never overwrites synced remote stars with [].
      return migrated.length > 0 ? { v: migrated, t: 1 } : null;
    }
  } catch {
    // Ignore malformed legacy data.
  }
  return null;
}

function readLocalPinnedBrainsPayload(): SyncedPreferencePayload<GlobalTaskPinnedBrain[]> | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return parsePinnedBrainsLocalValue(localStorage.getItem(GLOBAL_TASK_PINNED_BRAINS_STORAGE_KEY));
  } catch {
    return null;
  }
}

function samePinnedBrains(a: readonly GlobalTaskPinnedBrain[], b: readonly GlobalTaskPinnedBrain[]): boolean {
  if (a.length !== b.length) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function loadRecentBrains(): GlobalTaskRecentBrain[] {
  const raw = readStorageJson<unknown>(GLOBAL_TASK_RECENT_BRAINS_STORAGE_KEY, []);
  if (!Array.isArray(raw)) return [];
  const out: GlobalTaskRecentBrain[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const serverId = typeof obj.serverId === 'string' ? obj.serverId.trim() : '';
    const sessionName = typeof obj.sessionName === 'string' ? obj.sessionName.trim() : '';
    if (!serverId || !sessionName) continue;
    const key = brainKey(serverId, sessionName);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      serverId,
      sessionName,
      lastUsedAt: Number(obj.lastUsedAt ?? 0) || 0,
      ...(typeof obj.label === 'string' && obj.label.trim() ? { label: obj.label.trim() } : {}),
      ...(typeof obj.projectName === 'string' && obj.projectName.trim() ? { projectName: obj.projectName.trim() } : {}),
    });
    if (out.length >= MAX_RECENT_BRAINS) break;
  }
  return out;
}

export function brainKey(serverId: string, sessionName: string): string {
  return `${serverId}\u0000${sessionName}`;
}

export function taskKey(serverId: string, taskId: string): string {
  return `${serverId}\u0000${taskId}`;
}

export function formatTaskReplyMessage(taskTitle: string, message: string, locale?: string): string {
  const cleanTitle = taskTitle.replace(/[\r\n]+/g, ' ').trim();
  if (!cleanTitle) return message;
  const trimmedStart = message.trimStart();
  if (trimmedStart.startsWith('[关于任务「') || trimmedStart.startsWith('[Regarding task "')) {
    return message;
  }
  const effectiveLocale = (
    locale
    ?? (typeof navigator !== 'undefined' ? navigator.language : '')
    ?? 'en'
  ).toLowerCase();
  if (effectiveLocale.startsWith('zh')) {
    return `[关于任务「${cleanTitle}」]\n${message}`;
  }
  return `[Regarding task "${cleanTitle}"]\n${message}`;
}

function activeSortRank(item: GlobalTaskSummaryRow): number {
  if (item.needsAttention) return 0;
  if (
    item.status === 'working'
    || item.status === 'in_audit'
    || item.status === 'awaiting_audit'
    || item.status === 'rework'
  ) {
    return 1;
  }
  if (item.status === 'passed') return 2;
  if (item.status === 'queued' || item.status === 'paused') return 3;
  return 4;
}

export function sortGlobalTaskCards(items: readonly GlobalTaskSummaryRow[]): GlobalTaskSummaryRow[] {
  return [...items].sort((a, b) => {
    if (a.isTerminal !== b.isTerminal) {
      return a.isTerminal ? 1 : -1;
    }
    if (!a.isTerminal) {
      const rankDiff = activeSortRank(a) - activeSortRank(b);
      if (rankDiff !== 0) return rankDiff;
    }
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

function buildOrderIndex(order?: readonly string[]): Map<string, number> {
  const index = new Map<string, number>();
  if (!order) return index;
  for (let i = 0; i < order.length; i += 1) {
    const id = order[i];
    if (id && !index.has(id)) {
      index.set(id, i);
    }
  }
  return index;
}

export function sortGlobalTaskServers(
  servers: readonly GlobalTaskServerSummary[],
  pinnedServerIds?: ReadonlySet<string>,
  serverOrder?: readonly string[],
): GlobalTaskServerSummary[] {
  const hasPinned = Boolean(pinnedServerIds && pinnedServerIds.size > 0);
  const hasOrder = Boolean(serverOrder && serverOrder.length > 0);
  if (!hasPinned && !hasOrder) {
    return [...servers];
  }
  const serverOrderIndex = buildOrderIndex(serverOrder);
  return [...servers].sort((a, b) => {
    const aPinned = Boolean(pinnedServerIds?.has(a.id));
    const bPinned = Boolean(pinnedServerIds?.has(b.id));
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    if (!aPinned && a.online !== b.online) {
      return a.online ? -1 : 1;
    }
    const orderA = serverOrderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const orderB = serverOrderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    return a.name.localeCompare(b.name);
  });
}

export function resolveReadableSessionName(
  candidates: ReadonlyArray<string | null | undefined>,
  sessionName?: string | null,
  options?: { defaultLabel?: string; workerLabel?: string },
): string {
  const readable = pickReadableSessionDisplay([...candidates], sessionName);
  if (readable) return formatLabel(readable);
  return fallbackReadableSessionDisplay(sessionName, options);
}

function normalizeStoredSessionLabel(
  label: string | undefined,
  projectName: string | undefined,
  sessionName: string,
): string | undefined {
  const readable = pickReadableSessionDisplay([label, projectName], sessionName);
  return readable ? formatLabel(readable) : undefined;
}

export function resolveQuickDispatchBrains(
  pinned: readonly GlobalTaskPinnedBrain[],
  recent: readonly GlobalTaskRecentBrain[],
  brainsFromSnapshot: readonly GlobalTaskBrainSummary[],
  mutedServerIds: readonly string[],
  pinCtx?: GlobalTaskQuickDispatchPinContext,
): GlobalTaskQuickDispatchBrain[] {
  const mutedSet = new Set(mutedServerIds);
  const liveByKey = new Map<string, GlobalTaskBrainSummary>();
  for (const b of brainsFromSnapshot) {
    if (mutedSet.has(b.serverId)) continue;
    liveByKey.set(brainKey(b.serverId, b.sessionName), b);
  }

  const recentByKey = new Map<string, GlobalTaskRecentBrain>();
  for (const r of recent) {
    if (mutedSet.has(r.serverId)) continue;
    recentByKey.set(brainKey(r.serverId, r.sessionName), r);
  }

  const pinnedIndexByKey = new Map<string, number>();
  const candidates: GlobalTaskQuickDispatchBrain[] = [];
  const seen = new Set<string>();

  const pushBrain = (
    entry: { serverId: string; sessionName: string; label?: string; projectName?: string; lastUsedAt?: number },
    pinnedFlag: boolean,
    recentFlag: boolean,
  ) => {
    if (mutedSet.has(entry.serverId)) return;
    const key = brainKey(entry.serverId, entry.sessionName);
    if (seen.has(key)) return;
    const isServerPinned = Boolean(pinCtx?.pinnedServerIds?.has(entry.serverId));
    const isSessionPinned = pinnedFlag || Boolean(pinCtx?.pinnedSessionNames?.has(entry.sessionName));
    if (!isSessionPinned) return;
    seen.add(key);
    const live = liveByKey.get(key);
    const recentEntry = recentByKey.get(key);
    const projectName = live?.projectName ?? entry.projectName ?? recentEntry?.projectName ?? '';
    candidates.push({
      serverId: entry.serverId,
      serverName: live?.serverName ?? entry.serverId,
      serverOnline: live?.serverOnline ?? false,
      sessionName: entry.sessionName,
      projectName,
      label: resolveReadableSessionName(
        [live?.label, entry.label, recentEntry?.label, projectName],
        entry.sessionName,
      ),
      state: live?.state ?? 'unknown',
      agentType: live?.agentType ?? '',
      pinned: pinnedFlag,
      recent: recentFlag || recentByKey.has(key),
      serverPinned: isServerPinned,
      sessionPinned: isSessionPinned,
      ...(entry.lastUsedAt ?? recentEntry?.lastUsedAt ? { lastUsedAt: entry.lastUsedAt ?? recentEntry?.lastUsedAt } : {}),
    });
  };

  for (let i = 0; i < pinned.length; i += 1) {
    const p = pinned[i]!;
    const key = brainKey(p.serverId, p.sessionName);
    if (!pinnedIndexByKey.has(key)) {
      pinnedIndexByKey.set(key, i);
    }
    pushBrain(p, true, false);
  }
  const sortedRecent = [...recent].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  for (const r of sortedRecent) {
    pushBrain(r, false, true);
  }
  for (const live of brainsFromSnapshot) {
    pushBrain(live, false, false);
  }

  const serverOrderIndex = buildOrderIndex(pinCtx?.serverOrder);
  const tabOrderIndex = buildOrderIndex(pinCtx?.tabOrder);

  const tierOf = (item: GlobalTaskQuickDispatchBrain): number => {
    const srv = Boolean(item.serverPinned);
    const ses = Boolean(item.sessionPinned);
    if (srv && ses) return 0;
    if (ses) return 1;
    return 2;
  };

  candidates.sort((a, b) => {
    const tierDiff = tierOf(a) - tierOf(b);
    if (tierDiff !== 0) return tierDiff;

    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) {
      const idxA = pinnedIndexByKey.get(brainKey(a.serverId, a.sessionName)) ?? Number.MAX_SAFE_INTEGER;
      const idxB = pinnedIndexByKey.get(brainKey(b.serverId, b.sessionName)) ?? Number.MAX_SAFE_INTEGER;
      if (idxA !== idxB) return idxA - idxB;
    }

    const usedDiff = (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
    if (usedDiff !== 0) return usedDiff;

    if (a.serverOnline !== b.serverOnline) return a.serverOnline ? -1 : 1;

    const srvOrderA = serverOrderIndex.get(a.serverId) ?? Number.MAX_SAFE_INTEGER;
    const srvOrderB = serverOrderIndex.get(b.serverId) ?? Number.MAX_SAFE_INTEGER;
    if (srvOrderA !== srvOrderB) return srvOrderA - srvOrderB;

    const tabOrderA = tabOrderIndex.get(a.sessionName) ?? Number.MAX_SAFE_INTEGER;
    const tabOrderB = tabOrderIndex.get(b.sessionName) ?? Number.MAX_SAFE_INTEGER;
    if (tabOrderA !== tabOrderB) return tabOrderA - tabOrderB;

    const labelCmp = a.label.localeCompare(b.label);
    if (labelCmp !== 0) return labelCmp;
    return a.serverName.localeCompare(b.serverName);
  });

  return candidates;
}

function makeCommandId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `gt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export class GlobalTaskModeStore {
  private ws: WebSocket | null = null;
  private connectionGeneration = 0;
  private running = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<StoreListener>();
  private brainTextListeners = new Set<BrainTextListener>();
  private notificationListeners = new Set<NotificationListener>();
  private seenBrainEventIds = new Set<string>();
  private seenNotificationEventIds = new Set<string>();
  private activeConsumerCount = 0;
  private brainTextOrder: string[] = [];
  private hasExplicitMutedFilter = hasStoredMutedServerFilter();
  private pinnedBrainsPayload: SyncedPreferencePayload<GlobalTaskPinnedBrain[]> | null = readLocalPinnedBrainsPayload();
  private pinnedLocalWriteSeq = 0;
  private pinnedSyncEpoch = 0;
  private pinnedSaveEpoch = 0;
  private pinnedSyncInFlight = false;
  private pinnedSyncQueued = false;
  private pinnedSaveInFlight = false;
  private pinnedSaveQueued = false;
  private syncAbortController: AbortController | null = null;
  private syncListenersAttached = false;
  private state: GlobalTaskModeState = this.createInitialState();

  private createInitialState(): GlobalTaskModeState {
    return {
      connected: false,
      connecting: false,
      loading: false,
      error: null,
      snapshotSeq: 0,
      tasks: [],
      brains: [],
      servers: [],
      stats: null,
      mutedServerIds: loadMutedServerIds(),
      pinnedBrains: this.pinnedBrainsPayload?.v ?? [],
      recentBrains: loadRecentBrains(),
      latestBrainTexts: {},
      lastSyncedAt: null,
    };
  }

  getState(): GlobalTaskModeState {
    return this.state;
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeBrainText(listener: BrainTextListener): () => void {
    this.brainTextListeners.add(listener);
    return () => {
      this.brainTextListeners.delete(listener);
    };
  }

  subscribeNotifications(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  acquire(): () => void {
    this.activeConsumerCount += 1;
    if (this.activeConsumerCount === 1) {
      void this.start();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeConsumerCount = Math.max(0, this.activeConsumerCount - 1);
      if (this.activeConsumerCount === 0) {
        this.stop();
      }
    };
  }

  getLatestBrainText(serverId: string, sessionName: string): GlobalTaskBrainTextEvent | undefined {
    return this.state.latestBrainTexts[brainKey(serverId, sessionName)];
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.state);
      } catch {
        // Never allow one subscriber failure to break store delivery.
      }
    }
  }

  private setState(partial: Partial<GlobalTaskModeState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  private readonly handleWindowWake = (): void => {
    if (!this.running) return;
    void this.syncPinnedBrainsFromServer();
  };

  private readonly handleVisibilityChange = (): void => {
    if (!this.running || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    void this.syncPinnedBrainsFromServer();
  };

  private readonly handleStorageEvent = (event: StorageEvent): void => {
    if (!this.running || event.key !== GLOBAL_TASK_PINNED_BRAINS_STORAGE_KEY) return;
    const incoming = parsePinnedBrainsLocalValue(event.newValue);
    const local = this.readLatestPinnedPayload();
    if (incoming && (!local || incoming.t >= local.t)) {
      this.pinnedLocalWriteSeq += 1;
      this.applySyncedPinnedPayload(incoming, false);
    } else if (local && incoming && incoming.t < local.t) {
      writeStorageJson(GLOBAL_TASK_PINNED_BRAINS_STORAGE_KEY, local);
    }
  };

  private attachSyncListeners(): void {
    if (this.syncListenersAttached) return;
    this.syncListenersAttached = true;
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.handleWindowWake);
      window.addEventListener('online', this.handleWindowWake);
      window.addEventListener('storage', this.handleStorageEvent);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  private detachSyncListeners(): void {
    if (!this.syncListenersAttached) return;
    this.syncListenersAttached = false;
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', this.handleWindowWake);
      window.removeEventListener('online', this.handleWindowWake);
      window.removeEventListener('storage', this.handleStorageEvent);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  private readLatestPinnedPayload(): SyncedPreferencePayload<GlobalTaskPinnedBrain[]> | null {
    const disk = readLocalPinnedBrainsPayload();
    const memory = this.pinnedBrainsPayload;
    return disk && (!memory || disk.t > memory.t) ? disk : memory;
  }

  private applySyncedPinnedPayload(payload: SyncedPreferencePayload<GlobalTaskPinnedBrain[]>, writeDisk: boolean): void {
    this.pinnedBrainsPayload = payload;
    if (writeDisk) {
      writeStorageJson(GLOBAL_TASK_PINNED_BRAINS_STORAGE_KEY, payload);
    }
    if (!samePinnedBrains(this.state.pinnedBrains, payload.v)) {
      this.setState({ pinnedBrains: payload.v });
    }
  }

  private pinnedSaveToken = 0;
  private pinnedSyncToken = 0;

  private async flushPinnedSaveQueue(): Promise<void> {
    if (this.pinnedSaveInFlight) {
      this.pinnedSaveQueued = true;
      return;
    }
    this.pinnedSaveInFlight = true;
    const loopEpoch = this.pinnedSaveEpoch;
    const myToken = ++this.pinnedSaveToken;
    try {
      do {
        this.pinnedSaveQueued = false;
        const payload = this.pinnedBrainsPayload;
        if (!payload || this.pinnedSaveEpoch !== loopEpoch) break;
        try {
          await saveUserPref(GLOBAL_TASK_PINNED_BRAINS_STORAGE_KEY, JSON.stringify(payload));
        } catch {
          // Preserve local payload; subsequent lifecycle sync reconciles when reachable.
        }
      } while (this.pinnedSaveQueued && this.pinnedSaveEpoch === loopEpoch);
    } finally {
      if (this.pinnedSaveToken === myToken) {
        this.pinnedSaveInFlight = false;
      }
    }
  }

  async syncPinnedBrainsFromServer(): Promise<void> {
    if (this.pinnedSyncInFlight) {
      this.pinnedSyncQueued = true;
      return;
    }
    this.pinnedSyncInFlight = true;
    const loopEpoch = this.pinnedSyncEpoch;
    const myToken = ++this.pinnedSyncToken;
    try {
      do {
        this.pinnedSyncQueued = false;
        const writeSeqAtStart = this.pinnedLocalWriteSeq;
        const signal = this.syncAbortController?.signal;
        if (signal?.aborted) break;
        try {
          const raw = await getUserPref(GLOBAL_TASK_PINNED_BRAINS_STORAGE_KEY, { strict: true, signal });
          if (this.pinnedSyncEpoch !== loopEpoch || signal?.aborted) break;
          // If a local toggle occurred while GET was in flight, never overwrite it with the stale response.
          if (this.pinnedLocalWriteSeq !== writeSeqAtStart) continue;

          if (raw !== null) {
            const remote = parsePinnedBrainsEnvelope(raw);
            if (!remote) continue;
            const local = this.readLatestPinnedPayload();
            if (!local || remote.t >= local.t) {
              this.applySyncedPinnedPayload(remote, true);
            } else {
              await this.flushPinnedSaveQueue();
            }
          } else {
            const local = this.readLatestPinnedPayload();
            if (local) {
              this.applySyncedPinnedPayload(local, true);
              await this.flushPinnedSaveQueue();
            }
          }
        } catch {
          // Transient read failure is never treated as missing preference.
        }
      } while (this.pinnedSyncQueued && this.pinnedSyncEpoch === loopEpoch);
    } finally {
      if (this.pinnedSyncToken === myToken) {
        this.pinnedSyncInFlight = false;
      }
    }
  }

  async start(): Promise<void> {
    if (this.running && (this.ws || this.state.connecting || this.reconnectTimer)) {
      return;
    }
    this.running = true;
    if (!this.syncAbortController || this.syncAbortController.signal.aborted) {
      this.syncAbortController = new AbortController();
    }
    this.attachSyncListeners();
    void this.syncPinnedBrainsFromServer();
    await this.connectOnce();
  }

  stop(): void {
    this.running = false;
    this.connectionGeneration += 1;
    this.pinnedSyncEpoch += 1;
    this.pinnedSyncToken += 1;
    this.pinnedSyncInFlight = false;
    this.pinnedSyncQueued = false;
    this.detachSyncListeners();
    if (this.syncAbortController) {
      this.syncAbortController.abort();
      this.syncAbortController = null;
    }
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(1000, 'global task mode stopped'); } catch { /* ignore */ }
    }
    this.setState({ connected: false, connecting: false, loading: false });
  }

  refresh(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: GLOBAL_TASK_MODE_MSG.REFRESH }));
        return;
      } catch {
        // Fall through to HTTP snapshot fallback.
      }
    }
    void this.fetchSnapshotHttp();
  }

  async fetchSnapshotHttp(): Promise<GlobalTaskSnapshotResponse> {
    const query = this.state.mutedServerIds.length > 0
      ? `?mutedServerIds=${encodeURIComponent(this.state.mutedServerIds.join(','))}`
      : '';
    const snapshot = await apiFetch<GlobalTaskSnapshotResponse>(`${GLOBAL_TASK_SNAPSHOT_PATH}${query}`);
    this.applySnapshot(snapshot);
    return snapshot;
  }

  hasExplicitMutedServerFilter(): boolean {
    return this.hasExplicitMutedFilter || hasStoredMutedServerFilter();
  }

  private applyMutedFilterState(nextMuted: string[]): void {
    const mutedSet = new Set(nextMuted);

    const nextLatestBrainTexts: Record<string, GlobalTaskBrainTextEvent> = {};
    for (const [key, event] of Object.entries(this.state.latestBrainTexts)) {
      if (!mutedSet.has(event.serverId)) nextLatestBrainTexts[key] = event;
    }

    this.setState({
      mutedServerIds: nextMuted,
      tasks: this.state.tasks.filter((t) => !mutedSet.has(t.serverId)),
      brains: this.state.brains.filter((b) => !mutedSet.has(b.serverId)),
      latestBrainTexts: nextLatestBrainTexts,
    });

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({
          type: GLOBAL_TASK_MODE_MSG.SET_FILTER,
          mutedServerIds: nextMuted,
        }));
      } catch {
        // Reconnect sends SET_FILTER cleanly on open.
      }
    }
  }

  setMutedServerIds(mutedServerIds: readonly string[]): void {
    const nextMuted = [...new Set(mutedServerIds.map((id) => id.trim()).filter(Boolean))];
    this.hasExplicitMutedFilter = true;
    writeStorageJson(GLOBAL_TASK_MUTED_SERVERS_STORAGE_KEY, nextMuted);
    this.applyMutedFilterState(nextMuted);
  }

  /**
   * Apply a computed default server filter without persisting an explicit user preference.
   * Returns true if the active filter changed.
   */
  applyDefaultMutedServerIds(mutedServerIds: readonly string[]): boolean {
    if (this.hasExplicitMutedServerFilter()) return false;
    const nextMuted = [...new Set(mutedServerIds.map((id) => id.trim()).filter(Boolean))];
    const currentSet = new Set(this.state.mutedServerIds);
    if (nextMuted.length === currentSet.size && nextMuted.every((id) => currentSet.has(id))) {
      return false;
    }
    this.applyMutedFilterState(nextMuted);
    return true;
  }

  toggleMutedServer(serverId: string): void {
    const trimmed = serverId.trim();
    if (!trimmed) return;
    const exists = this.state.mutedServerIds.includes(trimmed);
    const next = exists
      ? this.state.mutedServerIds.filter((id) => id !== trimmed)
      : [...this.state.mutedServerIds, trimmed];
    this.setMutedServerIds(next);
  }

  togglePinnedBrain(entry: GlobalTaskPinnedBrain): void {
    const serverId = entry.serverId.trim();
    const sessionName = entry.sessionName.trim();
    if (!serverId || !sessionName) return;
    const key = brainKey(serverId, sessionName);
    const exists = this.state.pinnedBrains.some((p) => brainKey(p.serverId, p.sessionName) === key);
    const normalizedLabel = normalizeStoredSessionLabel(entry.label, entry.projectName, sessionName);
    const next = exists
      ? this.state.pinnedBrains.filter((p) => brainKey(p.serverId, p.sessionName) !== key)
      : [
        ...this.state.pinnedBrains,
        {
          serverId,
          sessionName,
          ...(normalizedLabel ? { label: normalizedLabel } : {}),
          ...(entry.projectName ? { projectName: entry.projectName } : {}),
        },
      ];
    const prevPayload = this.readLatestPinnedPayload();
    const payload: SyncedPreferencePayload<GlobalTaskPinnedBrain[]> = {
      v: next,
      t: Math.max(Date.now(), (prevPayload?.t ?? 0) + 1),
    };
    this.pinnedLocalWriteSeq += 1;
    this.pinnedBrainsPayload = payload;
    writeStorageJson(GLOBAL_TASK_PINNED_BRAINS_STORAGE_KEY, payload);
    this.setState({ pinnedBrains: next });
    void this.flushPinnedSaveQueue();
  }

  recordRecentBrain(entry: Omit<GlobalTaskRecentBrain, 'lastUsedAt'> & { lastUsedAt?: number }): void {
    const serverId = entry.serverId.trim();
    const sessionName = entry.sessionName.trim();
    if (!serverId || !sessionName) return;
    const key = brainKey(serverId, sessionName);
    const normalizedLabel = normalizeStoredSessionLabel(entry.label, entry.projectName, sessionName);
    const nextEntry: GlobalTaskRecentBrain = {
      serverId,
      sessionName,
      lastUsedAt: entry.lastUsedAt ?? Date.now(),
      ...(normalizedLabel ? { label: normalizedLabel } : {}),
      ...(entry.projectName ? { projectName: entry.projectName } : {}),
    };
    const next = [
      nextEntry,
      ...this.state.recentBrains.filter((r) => brainKey(r.serverId, r.sessionName) !== key),
    ].slice(0, MAX_RECENT_BRAINS);
    writeStorageJson(GLOBAL_TASK_RECENT_BRAINS_STORAGE_KEY, next);
    this.setState({ recentBrains: next });
  }

  async sendGlobalBrainMessage(input: SendGlobalBrainMessageInput): Promise<void> {
    const serverId = input.serverId.trim();
    const sessionName = input.sessionName.trim();
    const body = input.text.trim();
    if (!serverId || !sessionName) {
      throw new Error('serverId and sessionName are required');
    }
    if (!body) {
      throw new Error('message text is required');
    }
    const finalText = input.taskTitle?.trim()
      ? formatTaskReplyMessage(input.taskTitle, body, input.locale)
      : body;

    await sendSessionViaHttp(serverId, {
      sessionName,
      text: finalText,
      commandId: makeCommandId(),
      deliveryMode: SESSION_SEND_DELIVERY_MODES.APPEND,
    });

    this.recordRecentBrain({
      serverId,
      sessionName,
      label: input.label,
      projectName: input.projectName,
    });
  }

  async closeTaskPair(input: {
    serverId: string;
    taskId: string;
    action: TaskPairCloseAction;
    force?: boolean;
  }): Promise<TaskPairCloseResponse> {
    const serverId = input.serverId.trim();
    const taskId = input.taskId.trim();
    if (!serverId || !taskId) {
      return { ok: false, error: TASK_PAIR_CLOSE_ERROR.INVALID_REQUEST };
    }
    const result = await closeServerTaskPair(serverId, taskId, {
      action: input.action,
      ...(input.force !== undefined ? { force: input.force } : {}),
    });
    if (result.ok && result.status) {
      const targetKey = taskKey(serverId, taskId);
      const updatedAt = typeof result.updatedAt === 'number' && Number.isFinite(result.updatedAt)
        ? result.updatedAt
        : Date.now();
      const nextTasks = sortGlobalTaskCards(
        this.state.tasks.map((row) => {
          if (taskKey(row.serverId, row.taskId) !== targetKey) return row;
          const nextStatus = result.status!;
          const nextFlags = result.effect === 'forced' && !row.flags.includes('unaudited')
            ? row.flags
            : row.flags;
          return {
            ...row,
            status: nextStatus,
            flags: nextFlags,
            isTerminal: isGlobalTaskTerminalStatus(nextStatus),
            needsAttention: isGlobalTaskAttentionNeeded(nextStatus, nextFlags),
            updatedAt,
            ...(result.endedAt !== undefined ? { endedAt: result.endedAt } : isGlobalTaskTerminalStatus(nextStatus) ? { endedAt: updatedAt } : {}),
          };
        }),
      );
      this.setState({ tasks: nextTasks, lastSyncedAt: Date.now() });
    }
    return result;
  }

  clearSessionState(): void {
    this.activeConsumerCount = 0;
    this.stop();
    this.pinnedLocalWriteSeq += 1;
    this.pinnedSaveEpoch += 1;
    this.pinnedSaveToken += 1;
    this.pinnedSaveInFlight = false;
    this.pinnedSaveQueued = false;
    this.pinnedBrainsPayload = null;
    this.seenBrainEventIds.clear();
    this.seenNotificationEventIds.clear();
    this.brainTextOrder = [];
    this.hasExplicitMutedFilter = false;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(GLOBAL_TASK_MUTED_SERVERS_STORAGE_KEY);
        localStorage.removeItem(GLOBAL_TASK_PINNED_BRAINS_STORAGE_KEY);
        localStorage.removeItem(GLOBAL_TASK_RECENT_BRAINS_STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
    this.state = {
      connected: false,
      connecting: false,
      loading: false,
      error: null,
      snapshotSeq: 0,
      tasks: [],
      brains: [],
      servers: [],
      stats: null,
      mutedServerIds: [],
      pinnedBrains: [],
      recentBrains: [],
      latestBrainTexts: {},
      lastSyncedAt: null,
    };
    this.emit();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private async connectOnce(): Promise<void> {
    if (!this.running) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const gen = ++this.connectionGeneration;
    this.setState({ connecting: true, loading: this.state.lastSyncedAt == null, error: null });

    let ticket: string;
    try {
      const res = await apiFetch<{ ticket: string }>(GLOBAL_TASK_TICKET_PATH, { method: 'POST' });
      ticket = res.ticket;
    } catch (err) {
      if (!this.running || gen !== this.connectionGeneration) return;
      const message = err instanceof Error ? err.message : 'ws_ticket_failed';
      this.setState({ connecting: false, loading: false, error: message });
      if (err instanceof ApiError && err.status === 401) {
        return;
      }
      this.scheduleReconnect(gen);
      return;
    }

    if (!this.running || gen !== this.connectionGeneration) return;

    const wsBase = getApiBaseUrl().replace(/^http/, 'ws').replace(/\/$/, '');
    const wsUrl = `${wsBase}${GLOBAL_TASK_WS_PATH}?ticket=${encodeURIComponent(ticket)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      this.setState({
        connecting: false,
        loading: false,
        error: err instanceof Error ? err.message : 'ws_construct_failed',
      });
      this.scheduleReconnect(gen);
      return;
    }

    this.ws = ws;

    ws.addEventListener('open', () => {
      if (!this.running || this.ws !== ws || gen !== this.connectionGeneration) {
        try { ws.close(1000, 'stale socket'); } catch { /* ignore */ }
        return;
      }
      this.reconnectAttempts = 0;
      this.setState({ connected: true, connecting: false, error: null });
      try {
        ws.send(JSON.stringify({
          type: GLOBAL_TASK_MODE_MSG.SET_FILTER,
          mutedServerIds: this.state.mutedServerIds,
        }));
      } catch {
        // close event handles reconnect
      }
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        try { ws.send(JSON.stringify({ type: GLOBAL_TASK_MODE_MSG.PING })); } catch { /* ignore */ }
      }, PING_INTERVAL_MS);
    });

    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws || gen !== this.connectionGeneration) return;
      let frame: GlobalTaskServerFrame;
      try {
        frame = JSON.parse(String((ev as MessageEvent).data)) as GlobalTaskServerFrame;
      } catch {
        return;
      }
      this.handleServerFrame(frame);
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.setState({ connected: false, connecting: false, loading: false });
      if (this.running && gen === this.connectionGeneration) {
        this.scheduleReconnect(gen);
      }
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws) return;
      this.setState({ error: 'websocket_error' });
    });
  }

  private scheduleReconnect(gen: number): void {
    if (!this.running || gen !== this.connectionGeneration) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 10);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running || gen !== this.connectionGeneration) return;
      void this.connectOnce();
    }, delay);
  }

  private handleServerFrame(frame: GlobalTaskServerFrame): void {
    if (!frame || typeof frame !== 'object') return;

    if (frame.type === GLOBAL_TASK_MODE_MSG.SNAPSHOT) {
      this.applySnapshot(frame);
      return;
    }

    if (frame.type === GLOBAL_TASK_MODE_MSG.UPSERT) {
      const task = frame.task;
      if (!task || this.state.mutedServerIds.includes(task.serverId)) return;
      const key = taskKey(task.serverId, task.taskId);
      const remaining = this.state.tasks.filter((item) => taskKey(item.serverId, item.taskId) !== key);
      const nextTasks = isGlobalTaskWithinSyncWindow(task)
        ? sortGlobalTaskCards([...remaining, task])
        : sortGlobalTaskCards(remaining);
      this.setState({ tasks: nextTasks, lastSyncedAt: Date.now() });
      return;
    }

    if (frame.type === GLOBAL_TASK_MODE_MSG.BRAIN_TEXT) {
      const event = frame.event;
      if (!event || !event.eventId || this.state.mutedServerIds.includes(event.serverId)) return;
      if (this.seenBrainEventIds.has(event.eventId)) return;
      this.rememberBrainEventId(event.eventId);

      const key = brainKey(event.serverId, event.sessionName);
      const nextMap = { ...this.state.latestBrainTexts, [key]: event };
      this.brainTextOrder = [...this.brainTextOrder.filter((k) => k !== key), key];
      while (this.brainTextOrder.length > MAX_BRAIN_TEXT_CACHE_ENTRIES) {
        const oldest = this.brainTextOrder.shift();
        if (oldest) delete nextMap[oldest];
      }

      this.setState({ latestBrainTexts: nextMap });
      for (const listener of [...this.brainTextListeners]) {
        try {
          listener(event);
        } catch {
          // isolate subscriber failures
        }
      }
      return;
    }

    if (frame.type === GLOBAL_TASK_MODE_MSG.NOTIFICATION) {
      const event = frame.event;
      if (!event || !event.eventId || !event.title) return;
      if (this.seenNotificationEventIds.has(event.eventId)) return;
      this.seenNotificationEventIds.add(event.eventId);
      if (this.seenNotificationEventIds.size > MAX_SEEN_BRAIN_EVENT_IDS) {
        const oldest = this.seenNotificationEventIds.values().next().value;
        if (oldest !== undefined) this.seenNotificationEventIds.delete(oldest);
      }
      for (const listener of [...this.notificationListeners]) {
        try {
          listener(event);
        } catch {
          // isolate subscriber failures
        }
      }
      return;
    }

    if (frame.type === GLOBAL_TASK_MODE_MSG.SERVER_STATE) {
      const { serverId, online } = frame;
      this.setState({
        servers: this.state.servers.map((s) => (s.id === serverId ? { ...s, online } : s)),
        tasks: this.state.tasks.map((t) => (t.serverId === serverId ? { ...t, serverOnline: online } : t)),
        brains: this.state.brains.map((b) => (b.serverId === serverId ? { ...b, serverOnline: online } : b)),
      });
    }
  }

  private applySnapshot(snapshot: GlobalTaskSnapshotResponse): void {
    const now = Date.now();
    const mutedSet = new Set(this.state.mutedServerIds);
    const allowedServerIds = new Set((snapshot.servers ?? []).map((s) => s.id));
    const tasks = sortGlobalTaskCards(
      (snapshot.tasks ?? []).filter((t) => !mutedSet.has(t.serverId) && isGlobalTaskWithinSyncWindow(t, now)),
    );
    const brains = (snapshot.brains ?? []).filter((b) => !mutedSet.has(b.serverId));
    const servers = snapshot.servers ?? [];
    const nextLatestBrainTexts: Record<string, GlobalTaskBrainTextEvent> = {};
    const nextBrainTextOrder: string[] = [];
    for (const key of this.brainTextOrder) {
      const event = this.state.latestBrainTexts[key];
      if (!event) continue;
      if (!allowedServerIds.has(event.serverId) || mutedSet.has(event.serverId)) continue;
      nextLatestBrainTexts[key] = event;
      nextBrainTextOrder.push(key);
    }
    for (const [key, event] of Object.entries(this.state.latestBrainTexts)) {
      if (nextLatestBrainTexts[key]) continue;
      if (!allowedServerIds.has(event.serverId) || mutedSet.has(event.serverId)) continue;
      nextLatestBrainTexts[key] = event;
      nextBrainTextOrder.push(key);
    }
    this.brainTextOrder = nextBrainTextOrder;
    this.setState({
      loading: false,
      snapshotSeq: this.state.snapshotSeq + 1,
      tasks,
      brains,
      servers,
      stats: snapshot.stats ?? null,
      latestBrainTexts: nextLatestBrainTexts,
      lastSyncedAt: snapshot.ts ?? Date.now(),
    });
  }

  private rememberBrainEventId(eventId: string): void {
    this.seenBrainEventIds.add(eventId);
    if (this.seenBrainEventIds.size > MAX_SEEN_BRAIN_EVENT_IDS) {
      const oldest = this.seenBrainEventIds.values().next().value;
      if (oldest !== undefined) this.seenBrainEventIds.delete(oldest);
    }
  }
}

export const globalTaskModeStore = new GlobalTaskModeStore();

export function clearGlobalTaskModeSessionState(): void {
  globalTaskModeStore.clearSessionState();
}

function isSingleWindowTaskModeShell(): boolean {
  return isNative() || isPcAppDesktop();
}

export function readInitialTaskModeOpen(options?: { isSharedRoute?: boolean }): boolean {
  if (options?.isSharedRoute) return false;
  try {
    if (typeof sessionStorage !== 'undefined') {
      if (sessionStorage.getItem(TASK_MODE_OPEN_STORAGE_KEY) === '1') return true;
      const reloadRaw = sessionStorage.getItem(RELOAD_INTENT_STORAGE_KEY);
      if (reloadRaw) {
        const parsed = JSON.parse(reloadRaw) as { showTaskMode?: unknown } | null;
        if (parsed?.showTaskMode === true) return true;
      }
    }
  } catch { /* ignore restricted or malformed sessionStorage */ }

  if (!isSingleWindowTaskModeShell()) return false;
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(TASK_MODE_OPEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function syncTaskModeOpenPersistence(open: boolean): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      if (open) {
        sessionStorage.setItem(TASK_MODE_OPEN_STORAGE_KEY, '1');
      } else {
        sessionStorage.removeItem(TASK_MODE_OPEN_STORAGE_KEY);
        const reloadRaw = sessionStorage.getItem(RELOAD_INTENT_STORAGE_KEY);
        if (reloadRaw) {
          try {
            const parsed = JSON.parse(reloadRaw) as Record<string, unknown> | null;
            if (parsed && parsed.showTaskMode === true) {
              delete parsed.showTaskMode;
              sessionStorage.setItem(RELOAD_INTENT_STORAGE_KEY, JSON.stringify(parsed));
            }
          } catch { /* ignore malformed reload-intent */ }
        }
      }
    }
  } catch { /* ignore restricted sessionStorage */ }

  if (!open || isSingleWindowTaskModeShell()) {
    try {
      if (typeof localStorage !== 'undefined') {
        if (open) localStorage.setItem(TASK_MODE_OPEN_STORAGE_KEY, '1');
        else localStorage.removeItem(TASK_MODE_OPEN_STORAGE_KEY);
      }
    } catch { /* ignore restricted localStorage */ }
  }
}

export function clearTaskModeOpenPersistence(): void {
  syncTaskModeOpenPersistence(false);
}
