import { formatLabel } from './format-label.js';
import { getApiKey } from './api.js';
import { pushDurableEventToWatch, syncSnapshotToWatch } from './watch-bridge.js';
import type { TimelineEvent } from '../../src/shared/timeline/types.js';
import { isRunningTimelineEvent, isSdkSubagentTimelineEvent } from './timeline-running.js';
import {
  createTransportQueueReducerState,
  reduceTransportQueueEvent,
  selectFailedQueueEntries,
  selectLiveQueueEntries,
  selectSessionHasLiveQueue,
  type TransportQueueReducerState,
} from '../../shared/transport-queue-reducer.js';
import type {
  QueueEvent,
  QueueProjectionEntry,
  QueueSnapshot,
} from '../../shared/transport-queue-types.js';
import {
  containsLegacyLiveQueueEvidence,
  isTransportQueueEventType,
  isValidTransportQueueWireEvent,
} from '../../shared/transport-queue-wire.js';
import {
  isAuthoritativeCleanIdlePayload,
  normalizeActivityGeneration,
  type ActivityGenerationLike,
} from '../../shared/session-activity-types.js';

export type WatchSnapshotStatus = 'fresh' | 'stale' | 'switching';
export type WatchSessionState = 'working' | 'idle' | 'error' | 'stopped';

export interface WatchServerRow {
  id: string;
  name: string;
  baseUrl: string;
}

export interface WatchQueueEntry {
  clientMessageId: string;
  text: string;
  status: string;
  commandId?: string;
}

export interface WatchQueueReceipt {
  commandId: string;
  status: string;
  reason?: string;
}

export interface WatchSessionRow {
  serverId: string;
  sessionName: string;
  title: string;
  state: WatchSessionState;
  agentBadge: string;
  isSubSession: boolean;
  parentTitle?: string;
  parentSessionName?: string;
  isPinned?: boolean;
  previewText?: string;
  previewUpdatedAt?: number;
  queueEpoch?: string;
  queueAuthorityId?: string;
  transportPendingMessageVersion?: number;
  transportPendingMessageEntries?: WatchQueueEntry[];
  failedMessageEntries?: WatchQueueEntry[];
  transportQueueReceipts?: WatchQueueReceipt[];
  commandReceipts?: WatchQueueReceipt[];
}

export interface WatchApplicationContext {
  v: 1;
  snapshotStatus: WatchSnapshotStatus;
  generatedAt: number;
  currentServerId: string | null;
  servers: WatchServerRow[];
  sessions: WatchSessionRow[];
  apiKey: string | null;
}

export type WatchDurableEvent =
  | { type: 'session.idle'; session: string; serverId?: string | null; title?: string; message?: string; agentType?: string; label?: string; parentLabel?: string }
  | { type: 'session.notification'; session: string; serverId?: string | null; title: string; message: string; agentType?: string; label?: string; parentLabel?: string }
  | { type: 'ask.question'; session: string; serverId?: string | null; title: string; message: string; agentType?: string; label?: string; parentLabel?: string }
  | { type: 'session.error'; project: string; message: string };

export interface WatchProjectionStoreDeps {
  debounceMs?: number;
  now?: () => number;
  syncSnapshot?: (context: WatchApplicationContext) => Promise<void> | void;
  pushDurableEvent?: (event: WatchDurableEvent) => Promise<void> | void;
}

export interface WatchSessionInput {
  name: string;
  project: string;
  role: string;
  agentType?: string;
  sessionType?: string;
  state: string;
  label?: string | null;
  parentSession?: string | null;
  queueEpoch?: string | null;
  queueAuthorityId?: string | null;
  transportPendingMessageVersion?: number | null;
  pendingMessageEntries?: unknown;
  transportPendingMessageEntries?: unknown;
  failedMessageEntries?: unknown;
}

export interface WatchSubSessionInput {
  sessionName: string;
  sessionType: string;
  state?: string;
  label?: string | null;
  parentSession?: string | null;
  queueEpoch?: string | null;
  queueAuthorityId?: string | null;
  transportPendingMessageVersion?: number | null;
  pendingMessageEntries?: unknown;
  transportPendingMessageEntries?: unknown;
  failedMessageEntries?: unknown;
}

type WatchSessionLike = {
  label?: string | null;
  project?: string;
  role?: string;
  sessionName?: string;
};

const DEFAULT_DEBOUNCE_MS = 1000;
const SNAPSHOT_RETRY_MS = 5_000;
const PREVIEW_MIN_LENGTH = 10;
const PREVIEW_MAX_LENGTH = 120;
const PREVIEW_SCAN_CHAR_LIMIT = 4_096;
const NOISE_PREFIXES = [
  'let me',
  'let’s',
  "let's",
  'i’ll',
  "i'll",
  'i am',
  "i'm",
  'i will',
  'sure',
  'okay',
  'ok',
  'alright',
  'here is',
  'here’s',
  'here’s what',
  'here’s the',
  'i can',
  'i’ll check',
  'checking',
];

const BADGE_MAP: Record<string, string> = {
  'claude-code': 'cc',
  'claude-code-sdk': 'cc',
  'codex': 'cx',
  'codex-sdk': 'cx',
  'copilot-sdk': 'co',
  'cursor-headless': 'cu',
  'opencode': 'oc',
  'openclaw': 'oc',
  'qwen': 'qw',
  'gemini': 'gm',
  'gemini-sdk': 'gm',
  'grok-sdk': 'gr',
  'kimi-sdk': 'km',
  'shell': 'sh',
  'script': 'sc',
};

const STATE_PRIORITY: Record<WatchSessionState, number> = {
  working: 0,
  idle: 1,
  error: 2,
  stopped: 3,
};

function normalizeState(state: string): WatchSessionState {
  const lower = state.toLowerCase();
  if (lower === 'working' || lower === 'running' || lower === 'queued' || lower === 'busy') return 'working';
  // `started` is a neutral lifecycle notification (session/runtime launched),
  // not a terminal stop and not turn activity. Mapping it to `stopped` makes
  // watch/list projections flap while the main UI still has historical
  // timeline content; keep it idle until a real running/queued event arrives.
  if (lower === 'idle' || lower === 'waiting' || lower === 'started') return 'idle';
  if (lower === 'error' || lower === 'failed') return 'error';
  return 'stopped';
}

function readToolActivityKey(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null;
  for (const key of ['toolCallId', 'toolUseId', 'callId', 'id']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return `${key}:${value.trim()}`;
  }
  return null;
}

function badgeForType(agentType?: string | null): string {
  if (!agentType) return '??';
  const badge = BADGE_MAP[agentType];
  if (badge) return badge;
  const compact = agentType.replace(/[^a-z0-9]/gi, '').slice(0, 2).toLowerCase();
  return compact || '??';
}

function deriveTitle(session: WatchSessionLike): string {
  if (session.label) return formatLabel(session.label);
  if (session.role === 'brain') return session.project ?? session.sessionName ?? 'session';
  if (session.role) {
    const workerMatch = session.role.match(/^w(\d+)$/i);
    if (workerMatch) return `W${workerMatch[1]}`;
  }
  if (session.sessionName) {
    const short = session.sessionName.replace(/^deck_sub_/, '');
    return short || session.sessionName;
  }
  return session.project ?? 'session';
}

function isSubSessionName(name: string, parentSession?: string | null): boolean {
  return Boolean(parentSession) || name.startsWith('deck_sub_');
}

function normalizePreviewText(text: string): string {
  let out = '';
  let pendingSpace = false;
  let sawText = false;
  const scanLength = Math.min(text.length, PREVIEW_SCAN_CHAR_LIMIT);
  for (let i = 0; i < scanLength; i += 1) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (sawText) pendingSpace = true;
      continue;
    }
    if (pendingSpace && out.length > 0) {
      out += ' ';
      pendingSpace = false;
    }
    out += ch;
    sawText = true;
    if (out.length >= PREVIEW_MAX_LENGTH + 40) break;
  }
  return out.trim();
}

function extractPreviewText(text: string): string | null {
  const trimmed = normalizePreviewText(text);
  if (trimmed.length < PREVIEW_MIN_LENGTH) return null;
  const lower = trimmed.toLowerCase();
  if (NOISE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return null;
  return trimmed.length > PREVIEW_MAX_LENGTH ? trimmed.slice(0, PREVIEW_MAX_LENGTH) : trimmed;
}

function cloneServerRows(servers: WatchServerRow[]): WatchServerRow[] {
  return servers.map((server) => ({ ...server }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readQueueVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toQueueProjectionEntries(value: unknown, status: QueueProjectionEntry['status']): QueueProjectionEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const clientMessageId = typeof entry.clientMessageId === 'string' ? entry.clientMessageId.trim() : '';
    const text = typeof entry.text === 'string' ? entry.text : '';
    if (!clientMessageId || !text) return [];
    return [{
      clientMessageId,
      text,
      status,
      placement: entry.placement === 'front' ? 'front' : 'normal',
      ordinal: typeof entry.ordinal === 'number' && Number.isFinite(entry.ordinal) ? entry.ordinal : index,
      createdAt: typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
      updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
      ...(typeof entry.commandId === 'string' && entry.commandId.trim() ? { commandId: entry.commandId.trim() } : {}),
    } satisfies QueueProjectionEntry];
  });
}

function queueEventFromRecord(sessionName: string, value: Record<string, unknown>, source: string): QueueEvent | null {
  const queueEpoch = typeof value.queueEpoch === 'string' ? value.queueEpoch : '';
  const queueAuthorityId = typeof value.queueAuthorityId === 'string' ? value.queueAuthorityId : '';
  const pendingMessageVersion = readQueueVersion(value.transportPendingMessageVersion ?? value.pendingMessageVersion);
  if (!queueEpoch || !queueAuthorityId || pendingMessageVersion === undefined) return null;
  const pendingEntriesValue = Object.prototype.hasOwnProperty.call(value, 'pendingMessageEntries')
    ? value.pendingMessageEntries
    : value.transportPendingMessageEntries;
  const snapshot: QueueSnapshot = {
    type: 'transport.queue.snapshot',
    sessionName,
    queueEpoch,
    queueAuthorityId,
    pendingMessageVersion,
    pendingMessageEntries: toQueueProjectionEntries(pendingEntriesValue, 'queued'),
    failedMessageEntries: toQueueProjectionEntries(value.failedMessageEntries, 'failed'),
    source,
    ...(typeof value.resetReason === 'string' ? { resetReason: value.resetReason as QueueSnapshot['resetReason'] } : {}),
    ...(typeof value.dropReason === 'string' ? { dropReason: value.dropReason as QueueSnapshot['dropReason'] } : {}),
    ...(typeof value.activityGeneration === 'string' || typeof value.activityGeneration === 'number'
      ? { activityGeneration: value.activityGeneration }
      : {}),
  };
  return isValidTransportQueueWireEvent(snapshot) ? snapshot : null;
}

function queueEventFromTimelineEvent(event: TimelineEvent): QueueEvent | null {
  if (!isRecord(event.payload)) return null;
  if (isTransportQueueEventType(event.type)) {
    const candidate = {
      ...event.payload,
      type: event.type,
      sessionName: typeof event.payload.sessionName === 'string' ? event.payload.sessionName : event.sessionId,
    };
    return isValidTransportQueueWireEvent(candidate) ? candidate : null;
  }
  if (event.type !== 'session.state') return null;
  return queueEventFromRecord(event.sessionId, event.payload, 'watch-session-state');
}

function watchEntriesFromQueue(entries: QueueProjectionEntry[]): WatchQueueEntry[] {
  return entries.map((entry) => ({
    clientMessageId: entry.clientMessageId,
    text: entry.text,
    status: entry.status,
    ...(entry.commandId ? { commandId: entry.commandId } : {}),
  }));
}

function watchReceiptsFromQueue(state: TransportQueueReducerState): WatchQueueReceipt[] | undefined {
  const receipts = Object.values(state.receipts)
    .map((receipt) => ({
      commandId: receipt.commandId,
      status: receipt.status,
      ...(receipt.reason ? { reason: receipt.reason } : {}),
    }))
    .sort((a, b) => a.commandId.localeCompare(b.commandId));
  return receipts.length > 0 ? receipts : undefined;
}

function withoutQueueFields(row: WatchSessionRow): WatchSessionRow {
  const next = { ...row };
  delete next.queueEpoch;
  delete next.queueAuthorityId;
  delete next.transportPendingMessageVersion;
  delete next.transportPendingMessageEntries;
  delete next.failedMessageEntries;
  delete next.transportQueueReceipts;
  delete next.commandReceipts;
  return next;
}

function buildComparableSnapshot(snapshot: WatchApplicationContext): string {
  return JSON.stringify({
    v: snapshot.v,
    snapshotStatus: snapshot.snapshotStatus,
    currentServerId: snapshot.currentServerId,
    servers: snapshot.servers,
    sessions: snapshot.sessions,
    apiKey: snapshot.apiKey,
  });
}

export class WatchProjectionStore {
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly syncSnapshotFn: (context: WatchApplicationContext) => Promise<void> | void;
  private readonly pushDurableEventFn: (event: WatchDurableEvent) => Promise<void> | void;

  private snapshotStatus: WatchSnapshotStatus = 'stale';
  private generatedAt = 0;
  private currentServerId: string | null = null;
  private servers: WatchServerRow[] = [];
  private sessionsByName = new Map<string, WatchSessionRow>();
  private parentSessionByName = new Map<string, string | null>();
  private assistantTextBySession = new Map<string, string>();
  private openToolCountBySession = new Map<string, number>();
  private openToolKeysBySession = new Map<string, Set<string>>();
  private activityGenerationBySession = new Map<string, string>();
  private previewBySession = new Map<string, { previewText: string; previewUpdatedAt: number }>();
  private baseStateBySession = new Map<string, WatchSessionState>();
  private queueStateBySession = new Map<string, TransportQueueReducerState>();
  private queueWorkingBySession = new Set<string>();
  private commandReceiptsBySession = new Map<string, Map<string, WatchQueueReceipt>>();
  private apiKeyOverride: string | null | undefined = undefined;

  private lastComparableSnapshot = '';
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private dirtyVersion = 0;
  private flushInFlight = false;

  constructor(deps: WatchProjectionStoreDeps = {}) {
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.now = deps.now ?? Date.now;
    this.syncSnapshotFn = deps.syncSnapshot ?? syncSnapshotToWatch;
    this.pushDurableEventFn = deps.pushDurableEvent ?? pushDurableEventToWatch;
  }

  getSnapshot(): WatchApplicationContext {
    return {
      v: 1,
      snapshotStatus: this.snapshotStatus,
      generatedAt: this.generatedAt,
      currentServerId: this.currentServerId,
      servers: cloneServerRows(this.servers),
      sessions: this.buildSessions(),
      apiKey: this.resolveApiKey(),
    };
  }

  setApiKey(apiKey: string | null): void {
    this.apiKeyOverride = apiKey;
    this.maybePush();
  }

  setServers(servers: WatchServerRow[]): void {
    const dedup = new Map<string, WatchServerRow>();
    for (const server of servers) {
      dedup.set(server.id, { ...server });
    }
    this.servers = [...dedup.values()];
    this.maybePush();
  }

  setCurrentServerId(serverId: string | null): void {
    if (this.currentServerId === serverId) return;
    this.currentServerId = serverId;
    this.maybePush();
  }

  setSnapshotStatus(status: WatchSnapshotStatus): void {
    if (this.snapshotStatus === status && status !== 'switching') return;
    this.snapshotStatus = status;
    if (status === 'switching') {
      this.sessionsByName.clear();
      this.parentSessionByName.clear();
      this.assistantTextBySession.clear();
      this.openToolCountBySession.clear();
      this.openToolKeysBySession.clear();
      this.activityGenerationBySession.clear();
      this.previewBySession.clear();
      this.baseStateBySession.clear();
      this.queueStateBySession.clear();
      this.queueWorkingBySession.clear();
      this.commandReceiptsBySession.clear();
      this.generatedAt = 0;
      this.maybePush(true);
      return;
    }
    this.maybePush();
  }

  beginServerSwitch(serverId: string): void {
    this.currentServerId = serverId;
    this.setSnapshotStatus('switching');
  }

  updateFromSessionList(server: WatchServerRow, sessions: WatchSessionInput[]): void {
    this.updateFromSessionListWithSubs(server, sessions, []);
  }

  updateFromSessionListWithSubs(server: WatchServerRow, sessions: WatchSessionInput[], subs: WatchSubSessionInput[]): void {
    this.upsertServer(server);
    this.currentServerId = server.id;

    const nextSessions = new Map<string, WatchSessionRow>();
    const nextParents = new Map<string, string | null>();

    // Main sessions from session_list
    for (const raw of sessions) {
      this.applyQueueEventFromRecord(raw.name, raw as unknown as Record<string, unknown>, 'watch-session-list');
      const row = this.buildSessionRow(server.id, raw);
      nextParents.set(row.sessionName, raw.parentSession ?? null);
      const preview = this.previewBySession.get(row.sessionName);
      if (preview && row.previewText === undefined) {
        row.previewText = preview.previewText;
        row.previewUpdatedAt = preview.previewUpdatedAt;
      }
      nextSessions.set(row.sessionName, row);
    }

    // Sub-sessions from app state (daemon filters them from session_list)
    for (const sub of subs) {
      this.applyQueueEventFromRecord(sub.sessionName, sub as unknown as Record<string, unknown>, 'watch-subsession-list');
      const row = this.buildSubSessionRow(server.id, sub);
      nextParents.set(row.sessionName, sub.parentSession ?? null);
      const preview = this.previewBySession.get(row.sessionName);
      if (preview && row.previewText === undefined) {
        row.previewText = preview.previewText;
        row.previewUpdatedAt = preview.previewUpdatedAt;
      }
      nextSessions.set(row.sessionName, row);
    }

    this.sessionsByName = nextSessions;
    this.parentSessionByName = nextParents;
    this.resolveParentTitles();
    this.pruneCaches(nextSessions);
    this.snapshotStatus = 'fresh';
    this.maybePush(this.generatedAt === 0);
  }

  updateSessionState(sessionName: string, state: string): boolean {
    const row = this.sessionsByName.get(sessionName);
    if (!row) return false;
    const baseState = normalizeState(state);
    this.baseStateBySession.set(sessionName, baseState);
    const nextState = this.effectiveStateForSession(sessionName, baseState);
    if (row.state === nextState) return false;
    this.sessionsByName.set(sessionName, { ...row, state: nextState });
    this.maybePush();
    return true;
  }

  addSubSession(session: WatchSubSessionInput, serverId = this.currentServerId): boolean {
    if (!serverId) return false;
    const row = this.buildSubSessionRow(serverId, session);
    const prev = this.sessionsByName.get(row.sessionName);
    this.sessionsByName.set(row.sessionName, prev ? { ...prev, ...row } : row);
    this.parentSessionByName.set(row.sessionName, session.parentSession ?? null);
    this.resolveParentTitles(row.sessionName);
    this.maybePush();
    return true;
  }

  removeSubSession(sessionName: string): boolean {
    const removed = this.sessionsByName.delete(sessionName);
    if (!removed) return false;
    this.parentSessionByName.delete(sessionName);
    this.assistantTextBySession.delete(sessionName);
    this.openToolCountBySession.delete(sessionName);
    this.openToolKeysBySession.delete(sessionName);
    this.activityGenerationBySession.delete(sessionName);
    this.previewBySession.delete(sessionName);
    this.maybePush();
    return true;
  }

  trackAssistantText(sessionName: string, text: string): boolean {
    const preview = extractPreviewText(text);
    if (!preview) {
      this.assistantTextBySession.delete(sessionName);
      return false;
    }
    this.assistantTextBySession.set(sessionName, text);

    const row = this.sessionsByName.get(sessionName);
    if (row && preview !== row.previewText) {
      const ts = this.now();
      this.previewBySession.set(sessionName, { previewText: preview, previewUpdatedAt: ts });
      this.sessionsByName.set(sessionName, { ...row, previewText: preview, previewUpdatedAt: ts });
      this.maybePush();
    }
    return true;
  }

  onSessionIdle(sessionName: string, timestamp = this.now()): boolean {
    const row = this.sessionsByName.get(sessionName);
    if (!row) return false;
    this.openToolCountBySession.delete(sessionName);
    if ((this.openToolKeysBySession.get(sessionName)?.size ?? 0) > 0) {
      if (row.state !== 'working') {
        this.sessionsByName.set(sessionName, { ...row, state: 'working' });
        this.maybePush();
        return true;
      }
      return false;
    }

    const cachedText = this.assistantTextBySession.get(sessionName);
    const derivedPreview = cachedText ? extractPreviewText(cachedText) : null;
    const nextRow: WatchSessionRow = { ...row, state: 'idle' };

    if (derivedPreview) {
      const preview = { previewText: derivedPreview, previewUpdatedAt: timestamp };
      this.previewBySession.set(sessionName, preview);
      nextRow.previewText = derivedPreview;
      nextRow.previewUpdatedAt = timestamp;
    }

    this.sessionsByName.set(sessionName, nextRow);
    this.maybePush();
    return true;
  }

  handleTimelineEvent(event: TimelineEvent): boolean {
    let changed = false;
    const queueEvent = queueEventFromTimelineEvent(event);
    if (queueEvent) {
      changed = this.applyQueueEvent(queueEvent) || changed;
    } else if (isRecord(event.payload) && isTransportQueueEventType(event.type) && containsLegacyLiveQueueEvidence(event.payload)) {
      changed = false || changed;
    }
    if (event.type === 'command.ack') {
      changed = this.trackCommandReceipt(event) || changed;
    }
    if (event.type === 'tool.call') {
      if (isSdkSubagentTimelineEvent(event)) return changed;
      const key = readToolActivityKey(event.payload);
      if (key) {
        const keys = this.openToolKeysBySession.get(event.sessionId) ?? new Set<string>();
        keys.add(key);
        this.openToolKeysBySession.set(event.sessionId, keys);
      } else {
        this.openToolCountBySession.set(event.sessionId, (this.openToolCountBySession.get(event.sessionId) ?? 0) + 1);
      }
    } else if (event.type === 'tool.result') {
      if (isSdkSubagentTimelineEvent(event)) return changed;
      const key = readToolActivityKey(event.payload);
      if (key) {
        const keys = this.openToolKeysBySession.get(event.sessionId);
        if (keys?.delete(key) && keys.size === 0) this.openToolKeysBySession.delete(event.sessionId);
      } else {
        const next = Math.max(0, (this.openToolCountBySession.get(event.sessionId) ?? 0) - 1);
        if (next === 0) this.openToolCountBySession.delete(event.sessionId);
        else this.openToolCountBySession.set(event.sessionId, next);
      }
    } else if (event.type === 'session.state') {
      const eventGeneration = normalizeActivityGeneration(event.payload?.activityGeneration as ActivityGenerationLike);
      const state = String(event.payload?.state ?? '');
      if (state !== 'idle' && eventGeneration) this.activityGenerationBySession.set(event.sessionId, eventGeneration);
      if (state === 'idle') {
        const expectedGeneration = this.activityGenerationBySession.get(event.sessionId);
        if (isAuthoritativeCleanIdlePayload(event.payload, expectedGeneration)
          || isAuthoritativeCleanIdlePayload(event.payload)) {
          this.openToolCountBySession.delete(event.sessionId);
          this.openToolKeysBySession.delete(event.sessionId);
          if (eventGeneration) this.activityGenerationBySession.set(event.sessionId, eventGeneration);
        } else {
          this.openToolCountBySession.delete(event.sessionId);
        }
      }
      if (state) {
        changed = this.updateSessionState(event.sessionId, state) || changed;
      }
    }
    if (isRunningTimelineEvent(event)) {
      changed = this.updateSessionState(event.sessionId, 'working') || changed;
    }
    if (event.type !== 'assistant.text') return changed;
    const text = typeof event.payload.text === 'string' ? event.payload.text : '';
    if (event.payload.streaming === true) {
      if (text) this.assistantTextBySession.set(event.sessionId, text);
      return changed;
    }
    return this.trackAssistantText(event.sessionId, text) || changed;
  }

  async pushDurableEvent(event: WatchDurableEvent): Promise<void> {
    await this.pushDurableEventFn(event);
  }

  maybePush(immediate = false): void {
    this.dirty = true;
    this.dirtyVersion += 1;
    if (immediate) {
      this.clearPushTimer();
      void this.flushDirtySnapshot();
      return;
    }
    this.schedulePushTimer(true);
  }

  private clearPushTimer(): void {
    if (!this.pushTimer) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = null;
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private schedulePushTimer(reset = false): void {
    if (this.flushInFlight) return;
    if (this.pushTimer) {
      if (!reset) return;
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.flushDirtySnapshot();
    }, this.debounceMs);
  }

  private scheduleRetryTimer(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushDirtySnapshot();
    }, SNAPSHOT_RETRY_MS);
  }

  private async flushDirtySnapshot(): Promise<void> {
    if (!this.dirty) return;
    if (this.flushInFlight) {
      this.schedulePushTimer();
      return;
    }
    this.flushInFlight = true;
    const flushVersion = this.dirtyVersion;
    const snapshot = this.getSnapshot();
    const comparable = buildComparableSnapshot(snapshot);

    if (comparable === this.lastComparableSnapshot) {
      if (this.dirtyVersion === flushVersion) this.dirty = false;
      this.flushInFlight = false;
      return;
    }

    try {
      await this.flushSnapshot(comparable, snapshot);
      if (this.dirtyVersion === flushVersion) this.dirty = false;
      this.clearRetryTimer();
    } catch {
      this.dirty = true;
      this.scheduleRetryTimer();
    } finally {
      this.flushInFlight = false;
      if (this.dirty && this.dirtyVersion !== flushVersion) this.schedulePushTimer();
    }
  }

  private async flushSnapshot(comparable: string, snapshot: WatchApplicationContext): Promise<void> {
    if (comparable === this.lastComparableSnapshot) return;
    const emittedAt = this.now();
    const payload: WatchApplicationContext = {
      ...snapshot,
      generatedAt: emittedAt,
      apiKey: this.resolveApiKey(),
    };
    await this.syncSnapshotFn(payload);
    this.generatedAt = emittedAt;
    this.lastComparableSnapshot = comparable;
  }

  private upsertServer(server: WatchServerRow): void {
    const next = new Map(this.servers.map((row) => [row.id, row] as const));
    next.set(server.id, { ...server });
    this.servers = [...next.values()];
  }

  private buildSessionRow(serverId: string, raw: WatchSessionInput): WatchSessionRow {
    const baseState = normalizeState(raw.state);
    this.baseStateBySession.set(raw.name, baseState);
    const row: WatchSessionRow = {
      serverId,
      sessionName: raw.name,
      title: deriveTitle(raw),
      state: this.effectiveStateForSession(raw.name, baseState),
      agentBadge: badgeForType(raw.agentType ?? raw.sessionType),
      isSubSession: isSubSessionName(raw.name, raw.parentSession),
    };
    const preview = this.previewBySession.get(row.sessionName);
    if (preview) {
      row.previewText = preview.previewText;
      row.previewUpdatedAt = preview.previewUpdatedAt;
    }
    return this.withQueueProjection(row);
  }

  private buildSubSessionRow(serverId: string, session: WatchSubSessionInput): WatchSessionRow {
    const baseState = normalizeState(session.state ?? 'working');
    this.baseStateBySession.set(session.sessionName, baseState);
    const row: WatchSessionRow = {
      serverId,
      sessionName: session.sessionName,
      title: deriveTitle(session),
      state: this.effectiveStateForSession(session.sessionName, baseState),
      agentBadge: badgeForType(session.sessionType),
      isSubSession: true,
    };
    const preview = this.previewBySession.get(row.sessionName);
    if (preview) {
      row.previewText = preview.previewText;
      row.previewUpdatedAt = preview.previewUpdatedAt;
    }
    return this.withQueueProjection(row);
  }

  private buildSessions(): WatchSessionRow[] {
    const readPrefList = (key: string): string[] => {
      try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) as unknown : null;
        const list = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === 'object' && Array.isArray((parsed as { v?: unknown }).v)
            ? (parsed as { v: unknown[] }).v
            : [];
        return list.filter((item): item is string => typeof item === 'string' && item.length > 0);
      } catch {
        return [];
      }
    };

    const tabOrder = readPrefList('rcc_sync_tab_order');
    const pinnedSet = new Set(readPrefList('rcc_sync_tab_pinned'));
    const orderIndex = new Map(tabOrder.map((name, index) => [name, index]));

    return [...this.sessionsByName.values()]
      .map((row) => ({ ...row, isPinned: pinnedSet.has(row.sessionName) || undefined }))
      .sort((a, b) => {
        const pinDiff = (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0);
        if (pinDiff !== 0) return pinDiff;

        const aOrder = orderIndex.get(a.sessionName);
        const bOrder = orderIndex.get(b.sessionName);
        if (aOrder != null && bOrder != null) return aOrder - bOrder;
        if (aOrder != null) return -1;
        if (bOrder != null) return 1;

        const priorityDiff = STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state];
        if (priorityDiff !== 0) return priorityDiff;
        const titleDiff = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
        if (titleDiff !== 0) return titleDiff;
        return a.sessionName.localeCompare(b.sessionName, undefined, { sensitivity: 'base' });
      });
  }

  private pruneCaches(nextSessions: Map<string, WatchSessionRow>): void {
    for (const key of [...this.assistantTextBySession.keys()]) {
      if (!nextSessions.has(key)) this.assistantTextBySession.delete(key);
    }
    for (const key of [...this.previewBySession.keys()]) {
      if (!nextSessions.has(key)) this.previewBySession.delete(key);
    }
    for (const key of [...this.baseStateBySession.keys()]) {
      if (!nextSessions.has(key)) this.baseStateBySession.delete(key);
    }
    for (const key of [...this.queueStateBySession.keys()]) {
      if (!nextSessions.has(key)) this.queueStateBySession.delete(key);
    }
    for (const key of [...this.queueWorkingBySession]) {
      if (!nextSessions.has(key)) this.queueWorkingBySession.delete(key);
    }
    for (const key of [...this.commandReceiptsBySession.keys()]) {
      if (!nextSessions.has(key)) this.commandReceiptsBySession.delete(key);
    }
  }

  private trackCommandReceipt(event: TimelineEvent): boolean {
    if (!isRecord(event.payload)) return false;
    const commandId = typeof event.payload.commandId === 'string' ? event.payload.commandId.trim() : '';
    const status = typeof event.payload.status === 'string' ? event.payload.status.trim() : '';
    if (!commandId || !status) return false;
    const receipt: WatchQueueReceipt = {
      commandId,
      status,
      ...(typeof event.payload.error === 'string' && event.payload.error.trim() ? { reason: event.payload.error.trim() } : {}),
    };
    const receipts = this.commandReceiptsBySession.get(event.sessionId) ?? new Map<string, WatchQueueReceipt>();
    receipts.set(commandId, receipt);
    this.commandReceiptsBySession.set(event.sessionId, receipts);
    return this.updateRowQueueProjection(event.sessionId);
  }

  private applyQueueEventFromRecord(sessionName: string, value: Record<string, unknown>, source: string): boolean {
    const event = queueEventFromRecord(sessionName, value, source);
    return event ? this.applyQueueEvent(event) : false;
  }

  private applyQueueEvent(event: QueueEvent): boolean {
    const sessionName = event.sessionName;
    const previous = this.queueStateBySession.get(sessionName) ?? createTransportQueueReducerState(sessionName);
    const next = reduceTransportQueueEvent(previous, event);
    const accepted = next.degradedEvidence.length === previous.degradedEvidence.length;
    if (!accepted) {
      this.queueStateBySession.set(sessionName, next);
      return false;
    }
    this.queueStateBySession.set(sessionName, next);
    return this.updateRowQueueProjection(sessionName);
  }

  private hasOpenToolWork(sessionName: string): boolean {
    return (this.openToolCountBySession.get(sessionName) ?? 0) > 0
      || (this.openToolKeysBySession.get(sessionName)?.size ?? 0) > 0;
  }

  private effectiveStateForSession(sessionName: string, baseState: WatchSessionState): WatchSessionState {
    const queueState = this.queueStateBySession.get(sessionName);
    if (queueState && selectSessionHasLiveQueue(queueState)) return 'working';
    if (this.hasOpenToolWork(sessionName)) return 'working';
    return baseState;
  }

  private withQueueProjection(row: WatchSessionRow): WatchSessionRow {
    const queueState = this.queueStateBySession.get(row.sessionName);
    const commandReceipts = this.commandReceiptsBySession.get(row.sessionName);
    const queueReceipts = queueState ? watchReceiptsFromQueue(queueState) : undefined;
    const baseRow: WatchSessionRow = {
      ...withoutQueueFields(row),
      ...(commandReceipts && commandReceipts.size > 0
        ? { commandReceipts: [...commandReceipts.values()].sort((a, b) => a.commandId.localeCompare(b.commandId)) }
        : {}),
      ...(queueReceipts ? { transportQueueReceipts: queueReceipts } : {}),
    };
    if (!queueState?.queueEpoch || !queueState.queueAuthorityId || queueState.pendingMessageVersion === undefined) return baseRow;
    const liveEntries = watchEntriesFromQueue(selectLiveQueueEntries(queueState));
    const failedEntries = watchEntriesFromQueue(selectFailedQueueEntries(queueState));
    if (liveEntries.length > 0) this.queueWorkingBySession.add(row.sessionName);
    else this.queueWorkingBySession.delete(row.sessionName);
    return {
      ...baseRow,
      state: this.effectiveStateForSession(row.sessionName, row.state),
      queueEpoch: queueState.queueEpoch,
      queueAuthorityId: queueState.queueAuthorityId,
      transportPendingMessageVersion: queueState.pendingMessageVersion,
      transportPendingMessageEntries: liveEntries,
      failedMessageEntries: failedEntries,
    };
  }

  private updateRowQueueProjection(sessionName: string): boolean {
    const row = this.sessionsByName.get(sessionName);
    if (!row) return false;
    const baseState = this.baseStateBySession.get(sessionName) ?? row.state;
    const nextRow = this.withQueueProjection({ ...row, state: this.effectiveStateForSession(sessionName, baseState) });
    if (JSON.stringify(row) === JSON.stringify(nextRow)) return false;
    this.sessionsByName.set(sessionName, nextRow);
    this.maybePush();
    return true;
  }

  private resolveApiKey(): string | null {
    if (this.apiKeyOverride !== undefined) return this.apiKeyOverride;
    return getApiKey();
  }

  private resolveParentTitles(changedSessionName?: string): void {
    const resolveOne = (sessionName: string): void => {
      const row = this.sessionsByName.get(sessionName);
      if (!row || !row.isSubSession) return;
      const parentSessionName = this.parentSessionByName.get(sessionName);
      const parentTitle = parentSessionName ? this.sessionsByName.get(parentSessionName)?.title : undefined;
      const nextRow = parentTitle
        ? (row.parentTitle === parentTitle && row.parentSessionName === parentSessionName ? row : { ...row, parentTitle, parentSessionName: parentSessionName ?? undefined })
        : row.parentTitle === undefined
          ? row
          : (() => {
              const { parentTitle: _parentTitle, ...rest } = row;
              return rest as WatchSessionRow;
            })();
      if (nextRow !== row) this.sessionsByName.set(sessionName, nextRow);
    };

    if (changedSessionName) {
      resolveOne(changedSessionName);
      const changedRow = this.sessionsByName.get(changedSessionName);
      if (changedRow && !changedRow.isSubSession) {
        for (const [name, parent] of this.parentSessionByName.entries()) {
          if (parent === changedSessionName) resolveOne(name);
        }
      }
      return;
    }

    for (const sessionName of this.sessionsByName.keys()) {
      resolveOne(sessionName);
    }
  }
}

export function createWatchProjectionStore(deps: WatchProjectionStoreDeps = {}): WatchProjectionStore {
  return new WatchProjectionStore(deps);
}

export const watchProjectionStore = new WatchProjectionStore();
