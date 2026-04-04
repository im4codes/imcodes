import { formatLabel } from './format-label.js';
import { getApiKey } from './api.js';
import { pushDurableEventToWatch, syncSnapshotToWatch } from './watch-bridge.js';
import type { TimelineEvent } from '../../src/shared/timeline/types.js';

export type WatchSnapshotStatus = 'fresh' | 'stale' | 'switching';
export type WatchSessionState = 'working' | 'idle' | 'error' | 'stopped';

export interface WatchServerRow {
  id: string;
  name: string;
  baseUrl: string;
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
}

export interface WatchSubSessionInput {
  sessionName: string;
  sessionType: string;
  state?: string;
  label?: string | null;
  parentSession?: string | null;
}

type WatchSessionLike = {
  label?: string | null;
  project?: string;
  role?: string;
  sessionName?: string;
};

const DEFAULT_DEBOUNCE_MS = 1000;
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
  'codex': 'cx',
  'opencode': 'oc',
  'openclaw': 'oc',
  'qwen': 'qw',
  'gemini': 'gm',
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
  if (lower === 'working' || lower === 'running' || lower === 'busy') return 'working';
  if (lower === 'idle' || lower === 'waiting') return 'idle';
  if (lower === 'error' || lower === 'failed') return 'error';
  return 'stopped';
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

function extractPreviewText(text: string): string | null {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 10) return null;
  const lower = trimmed.toLowerCase();
  if (NOISE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return null;
  return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
}

function cloneServerRows(servers: WatchServerRow[]): WatchServerRow[] {
  return servers.map((server) => ({ ...server }));
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
  private previewBySession = new Map<string, { previewText: string; previewUpdatedAt: number }>();
  private apiKeyOverride: string | null | undefined = undefined;

  private lastComparableSnapshot = '';
  private pendingComparableSnapshot: string | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;

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
      this.previewBySession.clear();
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
    const nextState = normalizeState(state);
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
    this.previewBySession.delete(sessionName);
    this.maybePush();
    return true;
  }

  trackAssistantText(sessionName: string, text: string): boolean {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    if (trimmed.length < 10) {
      this.assistantTextBySession.delete(sessionName);
      return false;
    }
    this.assistantTextBySession.set(sessionName, trimmed);

    // Update previewText in real-time (debounce will coalesce rapid updates)
    const row = this.sessionsByName.get(sessionName);
    if (row) {
      const preview = extractPreviewText(trimmed);
      if (preview && preview !== row.previewText) {
        const ts = this.now();
        this.previewBySession.set(sessionName, { previewText: preview, previewUpdatedAt: ts });
        this.sessionsByName.set(sessionName, { ...row, previewText: preview, previewUpdatedAt: ts });
        this.maybePush();
      }
    }
    return true;
  }

  onSessionIdle(sessionName: string, timestamp = this.now()): boolean {
    const row = this.sessionsByName.get(sessionName);
    if (!row) return false;

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
    if (event.type !== 'assistant.text') return false;
    const text = typeof event.payload.text === 'string' ? event.payload.text : '';
    return this.trackAssistantText(event.sessionId, text);
  }

  async pushDurableEvent(event: WatchDurableEvent): Promise<void> {
    await this.pushDurableEventFn(event);
  }

  maybePush(immediate = false): void {
    const snapshot = this.getSnapshot();
    const comparable = buildComparableSnapshot(snapshot);

    if (comparable === this.lastComparableSnapshot) {
      if (this.pushTimer) {
        clearTimeout(this.pushTimer);
        this.pushTimer = null;
        this.pendingComparableSnapshot = null;
      }
      return;
    }

    this.pendingComparableSnapshot = comparable;
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }

    if (immediate) {
      void this.flushSnapshot(comparable, snapshot);
      return;
    }

    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.flushSnapshot(this.pendingComparableSnapshot ?? comparable, this.getSnapshot());
    }, this.debounceMs);
  }

  private async flushSnapshot(comparable: string, snapshot: WatchApplicationContext): Promise<void> {
    if (comparable === this.lastComparableSnapshot) return;
    const emittedAt = this.now();
    const payload: WatchApplicationContext = {
      ...snapshot,
      generatedAt: emittedAt,
      apiKey: this.resolveApiKey(),
      servers: cloneServerRows(this.servers),
      sessions: this.buildSessions(),
    };
    try {
      await this.syncSnapshotFn(payload);
      this.generatedAt = emittedAt;
      this.lastComparableSnapshot = comparable;
      this.pendingComparableSnapshot = null;
    } catch {
      // Best-effort snapshot delivery. Leave lastComparableSnapshot unchanged so
      // a later state change can retry.
    }
  }

  private upsertServer(server: WatchServerRow): void {
    const next = new Map(this.servers.map((row) => [row.id, row] as const));
    next.set(server.id, { ...server });
    this.servers = [...next.values()];
  }

  private buildSessionRow(serverId: string, raw: WatchSessionInput): WatchSessionRow {
    const row: WatchSessionRow = {
      serverId,
      sessionName: raw.name,
      title: deriveTitle(raw),
      state: normalizeState(raw.state),
      agentBadge: badgeForType(raw.agentType ?? raw.sessionType),
      isSubSession: isSubSessionName(raw.name, raw.parentSession),
    };
    const preview = this.previewBySession.get(row.sessionName);
    if (preview) {
      row.previewText = preview.previewText;
      row.previewUpdatedAt = preview.previewUpdatedAt;
    }
    return row;
  }

  private buildSubSessionRow(serverId: string, session: WatchSubSessionInput): WatchSessionRow {
    const row: WatchSessionRow = {
      serverId,
      sessionName: session.sessionName,
      title: deriveTitle(session),
      state: normalizeState(session.state ?? 'working'),
      agentBadge: badgeForType(session.sessionType),
      isSubSession: true,
    };
    const preview = this.previewBySession.get(row.sessionName);
    if (preview) {
      row.previewText = preview.previewText;
      row.previewUpdatedAt = preview.previewUpdatedAt;
    }
    return row;
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
