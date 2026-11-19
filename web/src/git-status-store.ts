/**
 * git-status-store — shared cache for `fs.git_status_response` across the
 * web UI. Any consumer that wants git-changed files or the changes count
 * for a given (ws, repoPath) pair subscribes here. Requests are deduped by
 * a 5-second TTL and an in-flight guard, so multiple FileBrowser instances
 * and badge counters pointing at the same repo fire a single underlying
 * `ws.fsGitStatus` call.
 *
 * Consumers today:
 *   - FileBrowser.tsx — populates the "Changes" list view
 *   - app.tsx — main session 📁 badge count
 *   - SubSessionWindow.tsx — per sub-session 📁 badge count rooted at sub.cwd
 *
 * Wiring: when `requestSharedChanges` is first called for a given WsClient,
 * a single `ws.onMessage` bridge is registered that routes every
 * `fs.git_status_response` into `settleSharedChangesRequest`. The bridge is
 * idempotent — safe to request concurrently from many consumers.
 */
import { useEffect, useState } from 'preact/hooks';
import type { WsClient, ServerMessage } from './ws-client.js';

export type ChangeFile = { path: string; code: string; additions?: number; deletions?: number };
export type SharedChangesMeta = { totalCount: number; truncated: boolean };
export type SharedChangesListener = (files: ChangeFile[]) => void;
export type SharedChangesMetaListener = (meta: SharedChangesMeta) => void;
export type SharedChangesRequestStatus = 'idle' | 'refreshing' | 'success' | 'error';
export type SharedChangesStatusListener = (status: SharedChangesRequestStatus) => void;

interface SharedChangesEntry {
  repoPath: string;
  files: ChangeFile[];
  totalCount: number;
  truncated: boolean;
  updatedAt: number;
  /** Timestamp of the most recent full (non-summaryOnly) file list settlement. */
  fullFilesUpdatedAt: number;
  /** Timestamp of the most recent summary or full settlement (for badge TTL). */
  summaryUpdatedAt: number;
  inFlightRequestId: string | null;
  inFlightSummaryOnly: boolean;
  /** Wall-clock timestamp when `inFlightRequestId` was set — used to detect
   *  stuck requests whose response never arrived (WS drop, daemon restart,
   *  serverLink.send throw, etc.). Without this, a dropped response would
   *  leave `inFlightRequestId` pinned forever and every subsequent refresh
   *  would silently take the "queued & return" branch. */
  inFlightStartedAt: number;
  queued: boolean;
  queuedNeedsFull: boolean;
  listeners: Set<SharedChangesListener>;
  metaListeners: Set<SharedChangesMetaListener>;
  status: SharedChangesRequestStatus;
  statusListeners: Set<SharedChangesStatusListener>;
  ws: WsClient | null;
  sessionName?: string;
}

export const SHARED_CHANGES_TTL_MS = 5_000;
/** If no response comes back for this long, treat the in-flight request as
 *  lost and fire a new one instead of queuing behind it forever. */
export const SHARED_CHANGES_INFLIGHT_TIMEOUT_MS = 15_000;

const sharedChangesByKey = new Map<string, SharedChangesEntry>();
const sharedChangesRequestMeta = new Map<string, { key: string; summaryOnly: boolean }>();
const checkoutRefreshGenerationByKey = new Map<string, number>();
const wsIds = new WeakMap<WsClient, number>();
const wsBridges = new WeakMap<WsClient, () => void>();
let nextWsId = 1;

/** Test-only reset. WeakMaps can't be cleared, but they're GC'd with the ws. */
export function __resetSharedChangesForTests(): void {
  sharedChangesByKey.clear();
  sharedChangesRequestMeta.clear();
  checkoutRefreshGenerationByKey.clear();
  nextWsId = 1;
}

function getWsId(ws: WsClient): number {
  let id = wsIds.get(ws);
  if (!id) {
    id = nextWsId++;
    wsIds.set(ws, id);
  }
  return id;
}

export function getSharedChangesKey(ws: WsClient, repoPath: string): string {
  return `${getWsId(ws)}::${repoPath}`;
}

function getEntry(key: string): SharedChangesEntry {
  let entry = sharedChangesByKey.get(key);
  if (!entry) {
    entry = {
      repoPath: '',
      files: [],
      totalCount: 0,
      truncated: false,
      updatedAt: 0,
      fullFilesUpdatedAt: 0,
      summaryUpdatedAt: 0,
      inFlightRequestId: null,
      inFlightSummaryOnly: false,
      inFlightStartedAt: 0,
      queued: false,
      queuedNeedsFull: false,
      listeners: new Set(),
      metaListeners: new Set(),
      status: 'idle',
      statusListeners: new Set(),
      ws: null,
    };
    sharedChangesByKey.set(key, entry);
  }
  return entry;
}

function cleanupEntryIfUnused(key: string, entry: SharedChangesEntry): void {
  if (
    entry.listeners.size === 0
    && entry.metaListeners.size === 0
    && entry.statusListeners.size === 0
    && !entry.inFlightRequestId
  ) {
    sharedChangesByKey.delete(key);
  }
}

/** Drop a stuck in-flight request so a fresh one can replace it. Safe to call
 *  even if nothing is in flight. The matching entry in `sharedChangesRequestMeta`
 *  is also removed, so a late-arriving response with the abandoned id becomes
 *  a no-op in `settleSharedChangesRequest`. */
function abandonInFlight(entry: SharedChangesEntry): void {
  if (!entry.inFlightRequestId) return;
  sharedChangesRequestMeta.delete(entry.inFlightRequestId);
  entry.inFlightRequestId = null;
  entry.inFlightSummaryOnly = false;
  entry.inFlightStartedAt = 0;
}

function isWebSocketNotConnectedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'WebSocket not connected';
}

export function subscribeSharedChanges(key: string, listener: SharedChangesListener): () => void {
  const entry = getEntry(key);
  entry.listeners.add(listener);
  if (entry.fullFilesUpdatedAt > 0) listener(entry.files);
  return () => {
    const current = sharedChangesByKey.get(key);
    if (!current) return;
    current.listeners.delete(listener);
    cleanupEntryIfUnused(key, current);
  };
}

export function subscribeSharedChangesMeta(key: string, listener: SharedChangesMetaListener): () => void {
  const entry = getEntry(key);
  entry.metaListeners.add(listener);
  if (entry.summaryUpdatedAt > 0 || entry.fullFilesUpdatedAt > 0) {
    listener({ totalCount: entry.totalCount, truncated: entry.truncated });
  }
  return () => {
    const current = sharedChangesByKey.get(key);
    if (!current) return;
    current.metaListeners.delete(listener);
    cleanupEntryIfUnused(key, current);
  };
}

/** Subscribe to real request settlement so controls can show useful feedback.
 * A newly mounted listener only receives an existing in-flight state; settled
 * success/error states belong to the interaction that observed them and must
 * not flash again when another FileBrowser opens later. */
export function subscribeSharedChangesStatus(key: string, listener: SharedChangesStatusListener): () => void {
  const entry = getEntry(key);
  entry.statusListeners.add(listener);
  if (entry.status === 'refreshing') listener(entry.status);
  return () => {
    const current = sharedChangesByKey.get(key);
    if (!current) return;
    current.statusListeners.delete(listener);
    cleanupEntryIfUnused(key, current);
  };
}

function publishStatus(key: string, status: SharedChangesRequestStatus): void {
  const entry = getEntry(key);
  entry.status = status;
  for (const listener of entry.statusListeners) listener(status);
}

function publishMeta(key: string, meta: SharedChangesMeta): void {
  const entry = getEntry(key);
  entry.totalCount = meta.totalCount;
  entry.truncated = meta.truncated;
  for (const listener of entry.metaListeners) listener(meta);
}

function publish(key: string, files: ChangeFile[], meta?: SharedChangesMeta): void {
  const entry = getEntry(key);
  const now = Date.now();
  entry.files = files;
  entry.updatedAt = now;
  entry.fullFilesUpdatedAt = now;
  entry.summaryUpdatedAt = now;
  for (const listener of entry.listeners) listener(files);
  publishMeta(key, meta ?? { totalCount: files.length, truncated: false });
}

function requestSharedChangesInternal(
  ws: WsClient,
  repoPath: string,
  force: boolean,
  sessionName: string | undefined,
  preferSummaryOnly: boolean,
): void {
  const key = getSharedChangesKey(ws, repoPath);
  const entry = getEntry(key);
  entry.ws = ws;
  entry.repoPath = repoPath;
  if (sessionName !== undefined) entry.sessionName = sessionName;
  ensureWsBridge(ws);

  // If any full-list consumer (e.g. FileBrowser) is subscribed, upgrade summary polls to full list.
  const wantsFullList = !preferSummaryOnly || entry.listeners.size > 0;
  const summaryOnly = !wantsFullList;
  const now = Date.now();
  const latestMetaAt = Math.max(entry.fullFilesUpdatedAt, entry.summaryUpdatedAt);
  const fresh = wantsFullList
    ? (entry.fullFilesUpdatedAt > 0 && (now - entry.fullFilesUpdatedAt) < SHARED_CHANGES_TTL_MS)
    : (latestMetaAt > 0 && (now - latestMetaAt) < SHARED_CHANGES_TTL_MS);

  if (!force && fresh) {
    if (wantsFullList) {
      publish(key, entry.files, { totalCount: entry.totalCount, truncated: entry.truncated });
    } else {
      publishMeta(key, { totalCount: entry.totalCount, truncated: entry.truncated });
    }
    return;
  }
  // Sweep stuck in-flight requests so a dropped response can't pin the entry
  // in "queued" mode forever. `force` is user-initiated (refresh button) and
  // always wins over a pending request; a full-list consumer also supersedes an
  // in-flight `summaryOnly` request immediately so FileBrowser doesn't wait.
  if (entry.inFlightRequestId) {
    const stale = entry.inFlightStartedAt > 0
      && (now - entry.inFlightStartedAt) > SHARED_CHANGES_INFLIGHT_TIMEOUT_MS;
    if (force || stale || (wantsFullList && entry.inFlightSummaryOnly)) {
      abandonInFlight(entry);
    } else {
      entry.queued = true;
      if (wantsFullList) entry.queuedNeedsFull = true;
      return;
    }
  }
  if (ws.connected === false) {
    entry.queued = true;
    if (wantsFullList) entry.queuedNeedsFull = true;
    return;
  }
  let requestId: string;
  try {
    requestId = ws.fsGitStatus(
      repoPath,
      summaryOnly
        ? (entry.sessionName ? { summaryOnly: true, sessionName: entry.sessionName } : { summaryOnly: true })
        : (entry.sessionName ? { includeStats: true, sessionName: entry.sessionName } : { includeStats: true }),
    );
  } catch (error) {
    entry.queued = false;
    entry.queuedNeedsFull = false;
    publishStatus(key, 'error');
    if (!isWebSocketNotConnectedError(error)) throw error;
    return;
  }
  entry.inFlightRequestId = requestId;
  entry.inFlightSummaryOnly = summaryOnly;
  entry.inFlightStartedAt = Date.now();
  entry.queued = false;
  entry.queuedNeedsFull = false;
  sharedChangesRequestMeta.set(requestId, { key, summaryOnly });
  publishStatus(key, 'refreshing');
}

export function requestSharedChanges(ws: WsClient, repoPath: string, force = false, sessionName?: string): void {
  requestSharedChangesInternal(ws, repoPath, force, sessionName, false);
}

/** Lightweight count-only refresh used by folder badges when no list consumer is active. */
export function requestSharedChangesCount(ws: WsClient, repoPath: string, force = false, sessionName?: string): void {
  requestSharedChangesInternal(ws, repoPath, force, sessionName, true);
}

export function forceRefreshSharedChangesForCheckout(
  ws: WsClient,
  repoPath: string,
  repoGeneration?: number,
  sessionName?: string,
): void {
  const key = getSharedChangesKey(ws, repoPath);
  if (typeof repoGeneration === 'number' && Number.isFinite(repoGeneration)) {
    if (checkoutRefreshGenerationByKey.get(key) === repoGeneration) return;
    checkoutRefreshGenerationByKey.set(key, repoGeneration);
  }
  requestSharedChanges(ws, repoPath, true, sessionName);
}

export function settleSharedChangesRequest(
  requestId: string,
  files: ChangeFile[] | null,
  meta?: { totalCount?: number; truncated?: boolean },
): boolean {
  const requestMeta = sharedChangesRequestMeta.get(requestId);
  if (!requestMeta) return false;
  sharedChangesRequestMeta.delete(requestId);
  const { key, summaryOnly } = requestMeta;
  const entry = sharedChangesByKey.get(key);
  if (!entry) return true;
  // Only clear in-flight tracking when this response matches the current
  // request. A force-refresh may have already kicked off a newer request
  // with a different id; in that case we still publish the fresh data (no
  // reason to discard perfectly good data) but must NOT null out the newer
  // request's in-flight state.
  if (entry.inFlightRequestId === requestId) {
    entry.inFlightRequestId = null;
    entry.inFlightSummaryOnly = false;
    entry.inFlightStartedAt = 0;
  }
  if (files) {
    const resolvedTotalCount = typeof meta?.totalCount === 'number' && Number.isFinite(meta.totalCount)
      ? meta.totalCount
      : files.length;
    const resolvedTruncated = typeof meta?.truncated === 'boolean' ? meta.truncated : false;
    if (summaryOnly) {
      // Summary-only responses carry `files: []` by design; never overwrite
      // `entry.files` or `fullFilesUpdatedAt` so FileBrowser list consumers
      // never see a summary response as a full file list.
      entry.summaryUpdatedAt = Date.now();
      publishMeta(key, { totalCount: resolvedTotalCount, truncated: resolvedTruncated });
    } else {
      publish(key, files, { totalCount: resolvedTotalCount, truncated: resolvedTruncated });
    }
    publishStatus(key, 'success');
  } else {
    publishStatus(key, 'error');
  }
  if (entry.queued && entry.ws && !entry.inFlightRequestId) {
    const needsFull = entry.queuedNeedsFull || entry.listeners.size > 0;
    entry.queued = false;
    entry.queuedNeedsFull = false;
    requestSharedChangesInternal(entry.ws, entry.repoPath, true, entry.sessionName, !needsFull);
  }
  return true;
}

/** Idempotent per-ws bridge: routes every `fs.git_status_response` into the
 *  shared cache. Called by `requestSharedChanges`, so consumers that only
 *  subscribe (never request) won't trigger it — but those consumers also
 *  don't need routing (no pending requestId to match). */
function ensureWsBridge(ws: WsClient): void {
  if (wsBridges.has(ws)) return;
  const unsub = ws.onMessage((msg: ServerMessage) => {
    if (msg.type === 'session.event' && (msg as { event?: string }).event === 'connected') {
      for (const entry of sharedChangesByKey.values()) {
        if (entry.ws === ws && entry.queued && !entry.inFlightRequestId && entry.repoPath) {
          const needsFull = entry.queuedNeedsFull || entry.listeners.size > 0;
          entry.queued = false;
          entry.queuedNeedsFull = false;
          requestSharedChangesInternal(ws, entry.repoPath, false, entry.sessionName, !needsFull);
        }
      }
      return;
    }
    if (msg.type !== 'fs.git_status_response') return;
    const response = msg as {
      requestId?: string;
      status?: string;
      files?: ChangeFile[];
      totalCount?: number;
      truncated?: boolean;
    };
    const requestId = response.requestId;
    if (!requestId) return;
    const files = response.status === 'ok' ? (response.files ?? null) : null;
    settleSharedChangesRequest(requestId, files, {
      totalCount: response.totalCount,
      truncated: response.truncated,
    });
  });
  wsBridges.set(ws, unsub);
}

/** React hook: subscribe to shared git-changes for `(ws, repoPath)`.
 *  - Fires `requestSharedChanges` on mount and when inputs change.
 *  - Polls at `pollMs` interval (default 30s). Polls dedupe via the 5s TTL.
 *  - Returns the latest file list (empty if ws or repoPath is missing). */
export function useSharedGitChanges(
  ws: WsClient | null,
  repoPath: string | null | undefined,
  opts: { pollMs?: number } = {},
): ChangeFile[] {
  const { pollMs = 30_000 } = opts;
  const [files, setFiles] = useState<ChangeFile[]>([]);

  useEffect(() => {
    if (!ws || !repoPath) {
      setFiles([]);
      return;
    }
    const key = getSharedChangesKey(ws, repoPath);
    const unsub = subscribeSharedChanges(key, (next) => setFiles(next));
    requestSharedChanges(ws, repoPath);
    const timer = pollMs > 0 ? setInterval(() => requestSharedChanges(ws, repoPath), pollMs) : null;
    return () => {
      unsub();
      if (timer) clearInterval(timer);
    };
  }, [ws, repoPath, pollMs]);

  return files;
}

/** Lightweight React hook for badge counters: uses `summaryOnly` when no list consumer is mounted, while still displaying exact `totalCount`. */
export function useSharedGitChangesCount(
  ws: WsClient | null,
  repoPath: string | null | undefined,
  opts: { pollMs?: number } = {},
): number {
  const { pollMs = 30_000 } = opts;
  const [totalCount, setTotalCount] = useState(0);

  useEffect(() => {
    if (!ws || !repoPath) {
      setTotalCount(0);
      return;
    }
    const key = getSharedChangesKey(ws, repoPath);
    const unsub = subscribeSharedChangesMeta(key, (meta) => setTotalCount(meta.totalCount));
    requestSharedChangesCount(ws, repoPath);
    const timer = pollMs > 0 ? setInterval(() => requestSharedChangesCount(ws, repoPath), pollMs) : null;
    return () => {
      unsub();
      if (timer) clearInterval(timer);
    };
  }, [ws, repoPath, pollMs]);

  return totalCount;
}
