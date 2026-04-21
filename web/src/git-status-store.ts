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
export type SharedChangesListener = (files: ChangeFile[]) => void;

interface SharedChangesEntry {
  repoPath: string;
  files: ChangeFile[];
  updatedAt: number;
  inFlightRequestId: string | null;
  queued: boolean;
  listeners: Set<SharedChangesListener>;
  ws: WsClient | null;
}

export const SHARED_CHANGES_TTL_MS = 5_000;

const sharedChangesByKey = new Map<string, SharedChangesEntry>();
const sharedChangesRequestKey = new Map<string, string>();
const wsIds = new WeakMap<WsClient, number>();
const wsBridges = new WeakMap<WsClient, () => void>();
let nextWsId = 1;

/** Test-only reset. WeakMaps can't be cleared, but they're GC'd with the ws. */
export function __resetSharedChangesForTests(): void {
  sharedChangesByKey.clear();
  sharedChangesRequestKey.clear();
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
    entry = { repoPath: '', files: [], updatedAt: 0, inFlightRequestId: null, queued: false, listeners: new Set(), ws: null };
    sharedChangesByKey.set(key, entry);
  }
  return entry;
}

export function subscribeSharedChanges(key: string, listener: SharedChangesListener): () => void {
  const entry = getEntry(key);
  entry.listeners.add(listener);
  if (entry.updatedAt > 0) listener(entry.files);
  return () => {
    const current = sharedChangesByKey.get(key);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0 && !current.inFlightRequestId) {
      sharedChangesByKey.delete(key);
    }
  };
}

function publish(key: string, files: ChangeFile[]): void {
  const entry = getEntry(key);
  entry.files = files;
  entry.updatedAt = Date.now();
  for (const listener of entry.listeners) listener(files);
}

export function requestSharedChanges(ws: WsClient, repoPath: string, force = false): void {
  const key = getSharedChangesKey(ws, repoPath);
  const entry = getEntry(key);
  entry.ws = ws;
  entry.repoPath = repoPath;
  ensureWsBridge(ws);
  const fresh = entry.updatedAt > 0 && (Date.now() - entry.updatedAt) < SHARED_CHANGES_TTL_MS;
  if (!force && fresh) {
    publish(key, entry.files);
    return;
  }
  if (entry.inFlightRequestId) {
    entry.queued = true;
    return;
  }
  const requestId = ws.fsGitStatus(repoPath, { includeStats: true });
  entry.inFlightRequestId = requestId;
  sharedChangesRequestKey.set(requestId, key);
}

export function settleSharedChangesRequest(requestId: string, files: ChangeFile[] | null): boolean {
  const key = sharedChangesRequestKey.get(requestId);
  if (!key) return false;
  sharedChangesRequestKey.delete(requestId);
  const entry = sharedChangesByKey.get(key);
  if (!entry) return true;
  entry.inFlightRequestId = null;
  if (files) publish(key, files);
  if (entry.queued && entry.ws) {
    entry.queued = false;
    requestSharedChanges(entry.ws, entry.repoPath, true);
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
    if (msg.type !== 'fs.git_status_response') return;
    const requestId = (msg as { requestId?: string }).requestId;
    if (!requestId) return;
    const files = msg.status === 'ok' ? ((msg.files as ChangeFile[] | undefined) ?? null) : null;
    settleSharedChangesRequest(requestId, files);
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
