import { FILE_RELAY_MODE, type R2RelayProgress } from '@shared/r2-relay.js';
import {
  canRevealSavedDownload,
  revealSavedDownload,
  type SavedDownloadFileHandle,
} from './download-file-actions.js';

export const DOWNLOAD_TRANSFER_STATUS = {
  PREPARING: 'preparing',
  CONNECTING: 'connecting',
  TRANSFERRING: 'transferring',
  FALLING_BACK: 'falling_back',
  HANDED_OFF: 'handed_off',
  READY_TO_SAVE: 'ready_to_save',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  CANCELED: 'canceled',
  FAILED: 'failed',
} as const;

export const DOWNLOAD_TRANSFER_ROUTE = {
  R2: FILE_RELAY_MODE.R2,
  PENDING: 'pending',
  DIRECT: 'direct',
  HTTP: 'http',
  BROWSER: 'browser',
} as const;

export type DownloadTransferStatus = typeof DOWNLOAD_TRANSFER_STATUS[keyof typeof DOWNLOAD_TRANSFER_STATUS];
export type DownloadTransferRoute = typeof DOWNLOAD_TRANSFER_ROUTE[keyof typeof DOWNLOAD_TRANSFER_ROUTE];

export interface DownloadTransferItem {
  readonly id: string;
  readonly name: string;
  readonly status: DownloadTransferStatus;
  readonly route: DownloadTransferRoute;
  readonly loadedBytes: number;
  readonly totalBytes: number | null;
  readonly speedBps: number;
  readonly etaSeconds?: number | null;
  readonly startedAt: number;
  readonly updatedAt: number;
}

type Listener = () => void;
type ProgressSample = { loadedBytes: number; totalBytes: number | null; now: number };
type RetryHandler = (signal: AbortSignal, resumeFromBytes?: number) => Promise<void>;
type SaveHandler = () => Promise<void>;
type Runtime = {
  controller: AbortController;
  retry: RetryHandler | null;
  pausable: boolean;
  preservePrefixOnRetry: boolean;
  committing: boolean;
  attemptPromise: Promise<void> | null;
  save: SaveHandler | null;
  /** The saved file, once a completed download has one the page can read back. */
  savedFile: SavedDownloadFileHandle | null;
  saveInFlight: boolean;
  lastSampleAt: number;
  lastSampleBytes: number;
  speedBps: number;
  lastPublishedAt: number;
  pending: ProgressSample | null;
  timer: ReturnType<typeof setTimeout> | null;
  stallTimer: ReturnType<typeof setTimeout> | null;
};

const PUBLISH_INTERVAL_MS = 200;
/** A stalled stream must become actionable rather than sitting forever. The
 * transport implementations have their own bounded retries; this watchdog is
 * the final guard for a wedged browser/daemon callback path. */
export const DOWNLOAD_STALL_TIMEOUT_MS = 30_000;
let snapshot: readonly DownloadTransferItem[] = [];
const listeners = new Set<Listener>();
const runtimeById = new Map<string, Runtime>();

function publish(next: readonly DownloadTransferItem[]): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function updateItem(id: string, update: (item: DownloadTransferItem) => DownloadTransferItem): void {
  let changed = false;
  const next = snapshot.map((item) => {
    if (item.id !== id) return item;
    changed = true;
    return update(item);
  });
  if (changed) publish(next);
}

function isTerminal(status: DownloadTransferStatus): boolean {
  return status === DOWNLOAD_TRANSFER_STATUS.HANDED_OFF
    || status === DOWNLOAD_TRANSFER_STATUS.COMPLETED
    || status === DOWNLOAD_TRANSFER_STATUS.CANCELED
    || status === DOWNLOAD_TRANSFER_STATUS.FAILED;
}

function isInactive(status: DownloadTransferStatus): boolean {
  return status === DOWNLOAD_TRANSFER_STATUS.READY_TO_SAVE
    || status === DOWNLOAD_TRANSFER_STATUS.PAUSED
    || isTerminal(status);
}

function clearRuntimeTimer(runtime: Runtime | undefined): void {
  if (!runtime) return;
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = null;
}

function clearStallTimer(runtime: Runtime | undefined): void {
  if (!runtime) return;
  if (runtime.stallTimer) clearTimeout(runtime.stallTimer);
  runtime.stallTimer = null;
}

function armStallTimer(id: string, now: number): void {
  const runtime = runtimeById.get(id);
  if (!runtime || runtime.committing) return;
  clearStallTimer(runtime);
  runtime.stallTimer = setTimeout(() => {
    runtime.stallTimer = null;
    if (runtime.committing) return;
    const item = snapshot.find((entry) => entry.id === id);
    if (!item || item.status !== DOWNLOAD_TRANSFER_STATUS.TRANSFERRING) return;
    // Abort the wedged attempt, retain the durable prefix, and expose the
    // normal bounded retry path. The next explicit retry passes the preserved
    // offset to the transport; it never starts from byte zero.
    runtime.controller.abort();
    failDownloadTransfer(id, false, Date.now());
  }, Math.max(1, DOWNLOAD_STALL_TIMEOUT_MS - Math.max(0, Date.now() - now)));
}

function applyProgress(id: string, sample: ProgressSample): void {
  const runtime = runtimeById.get(id);
  if (!runtime) return;
  clearRuntimeTimer(runtime);
  runtime.pending = null;
  const current = snapshot.find((item) => item.id === id);
  const loadedBytes = Math.max(sample.loadedBytes, current?.loadedBytes ?? 0);
  const elapsedMs = Math.max(0, sample.now - runtime.lastSampleAt);
  if (loadedBytes < runtime.lastSampleBytes) runtime.speedBps = 0;
  const deltaBytes = Math.max(0, loadedBytes - runtime.lastSampleBytes);
  if (elapsedMs > 0 && deltaBytes > 0) {
    const instantaneous = deltaBytes / (elapsedMs / 1000);
    runtime.speedBps = runtime.speedBps > 0
      ? (runtime.speedBps * 0.7) + (instantaneous * 0.3)
      : instantaneous;
  }
  runtime.lastSampleAt = sample.now;
  runtime.lastSampleBytes = loadedBytes;
  runtime.lastPublishedAt = sample.now;
  armStallTimer(id, sample.now);
  updateItem(id, (item) => ({
    ...item,
    status: DOWNLOAD_TRANSFER_STATUS.TRANSFERRING,
    loadedBytes,
    totalBytes: sample.totalBytes,
    speedBps: runtime.speedBps,
    updatedAt: sample.now,
  }));
}

export function getDownloadTransfers(): readonly DownloadTransferItem[] {
  return snapshot;
}

export function subscribeDownloadTransfers(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function isCurrentDownloadSignal(id: string, signal?: AbortSignal): boolean {
  if (!signal) return true;
  return runtimeById.get(id)?.controller.signal === signal;
}

export function trackDownloadTransferAttempt<T>(
  id: string,
  signal: AbortSignal,
  promise: Promise<T>,
): Promise<T> {
  const runtime = runtimeById.get(id);
  if (runtime && runtime.controller.signal === signal) {
    const settled = promise.then(() => undefined, () => undefined);
    runtime.attemptPromise = settled;
    void settled.finally(() => {
      const current = runtimeById.get(id);
      if (current && current.attemptPromise === settled) {
        current.attemptPromise = null;
      }
    });
  }
  return promise;
}

export function beginDownloadTransfer(name: string, now = Date.now()): { id: string; signal: AbortSignal } {
  const id = crypto.randomUUID();
  const controller = new AbortController();
  runtimeById.set(id, {
    controller,
    retry: null,
    pausable: true,
    preservePrefixOnRetry: true,
    committing: false,
    attemptPromise: null,
    save: null,
    savedFile: null,
    saveInFlight: false,
    lastSampleAt: now,
    lastSampleBytes: 0,
    speedBps: 0,
    lastPublishedAt: now,
    pending: null,
    timer: null,
    stallTimer: null,
  });
  publish([{
    id,
    name,
    status: DOWNLOAD_TRANSFER_STATUS.PREPARING,
    route: DOWNLOAD_TRANSFER_ROUTE.PENDING,
    loadedBytes: 0,
    totalBytes: null,
    speedBps: 0,
    startedAt: now,
    updatedAt: now,
  }, ...snapshot]);
  return { id, signal: controller.signal };
}

export function setDownloadTransferRetry(
  id: string,
  retry: RetryHandler,
  options?: { pausable?: boolean; preservePrefixOnRetry?: boolean },
): void {
  const runtime = runtimeById.get(id);
  if (!runtime) return;
  runtime.retry = retry;
  runtime.preservePrefixOnRetry = options?.preservePrefixOnRetry ?? options?.pausable ?? true;
  if (options?.pausable !== undefined && runtime.pausable !== options.pausable) {
    runtime.pausable = options.pausable;
    publish([...snapshot]);
  }
}

export function setDownloadTransferSave(id: string, save: SaveHandler, now = Date.now()): void {
  const runtime = runtimeById.get(id);
  if (!runtime) return;
  clearRuntimeTimer(runtime);
  runtime.save = save;
  runtime.saveInFlight = false;
  updateItem(id, (item) => isTerminal(item.status) ? item : ({
    ...item,
    status: DOWNLOAD_TRANSFER_STATUS.READY_TO_SAVE,
    speedBps: 0,
    updatedAt: now,
  }));
}

export function canSaveDownloadTransfer(id: string): boolean {
  const runtime = runtimeById.get(id);
  const item = snapshot.find((entry) => entry.id === id);
  return !!runtime?.save && !runtime.saveInFlight && item?.status === DOWNLOAD_TRANSFER_STATUS.READY_TO_SAVE;
}

export async function saveDownloadTransfer(id: string, now = Date.now()): Promise<void> {
  const runtime = runtimeById.get(id);
  const item = snapshot.find((entry) => entry.id === id);
  if (!runtime?.save || runtime.saveInFlight || item?.status !== DOWNLOAD_TRANSFER_STATUS.READY_TO_SAVE) return;
  runtime.saveInFlight = true;
  try {
    await runtime.save();
    runtime.save = null;
    runtime.saveInFlight = false;
    completeDownloadTransfer(id, false, now);
  } catch {
    // The file is already downloaded. A dismissed/blocked share sheet is not
    // a transfer failure; retain the payload so another explicit tap can retry.
    runtime.saveInFlight = false;
    updateItem(id, (current) => ({ ...current, status: DOWNLOAD_TRANSFER_STATUS.READY_TO_SAVE, updatedAt: Date.now() }));
  }
}

export function canRetryDownloadTransfer(id: string): boolean {
  const runtime = runtimeById.get(id);
  const item = snapshot.find((entry) => entry.id === id);
  return !!runtime?.retry && item?.status === DOWNLOAD_TRANSFER_STATUS.FAILED;
}

export async function retryDownloadTransfer(id: string, now = Date.now()): Promise<void> {
  const runtime = runtimeById.get(id);
  const item = snapshot.find((entry) => entry.id === id);
  if (!runtime?.retry || (item?.status !== DOWNLOAD_TRANSFER_STATUS.FAILED
    && item?.status !== DOWNLOAD_TRANSFER_STATUS.PAUSED)) return;
  const prevAttempt = runtime.attemptPromise;
  const preservePrefix = runtime.preservePrefixOnRetry;
  const resumeOffset = preservePrefix ? item.loadedBytes : 0;
  clearRuntimeTimer(runtime);
  clearStallTimer(runtime);
  runtime.committing = false;
  runtime.savedFile = null;
  runtime.controller = new AbortController();
  const attemptSignal = runtime.controller.signal;
  runtime.lastSampleAt = now;
  // Restart-from-zero retries clear stale byte counters before the fresh attempt;
  // resumable paths preserve the durable prefix as the progress floor.
  runtime.lastSampleBytes = resumeOffset;
  runtime.speedBps = 0;
  runtime.lastPublishedAt = preservePrefix ? now : 0;
  runtime.pending = null;
  updateItem(id, (current) => ({
    ...current,
    status: DOWNLOAD_TRANSFER_STATUS.PREPARING,
    route: DOWNLOAD_TRANSFER_ROUTE.PENDING,
    loadedBytes: resumeOffset,
    totalBytes: preservePrefix ? current.totalBytes : null,
    speedBps: 0,
    etaSeconds: null,
    startedAt: item.startedAt,
    updatedAt: now,
  }));
  if (prevAttempt) {
    await prevAttempt;
    if (attemptSignal.aborted || !isCurrentDownloadSignal(id, attemptSignal)) return;
  }
  const latestItem = snapshot.find((entry) => entry.id === id);
  const latestRuntime = runtimeById.get(id);
  if (!latestRuntime?.retry || !latestItem || !isCurrentDownloadSignal(id, attemptSignal)) return;
  try {
    await trackDownloadTransferAttempt(
      id,
      attemptSignal,
      latestRuntime.retry(attemptSignal, resumeOffset),
    );
  } catch {
    if (!isCurrentDownloadSignal(id, attemptSignal)) return;
    const current = snapshot.find((entry) => entry.id === id);
    if (current && !isTerminal(current.status) && current.status !== DOWNLOAD_TRANSFER_STATUS.PAUSED) {
      failDownloadTransfer(id, false, Date.now(), attemptSignal);
    }
  }
}

export function updateDownloadTransfer(
  id: string,
  route: DownloadTransferRoute,
  status: DownloadTransferStatus,
  now = Date.now(),
  signal?: AbortSignal,
): void {
  if (!isCurrentDownloadSignal(id, signal)) return;
  const runtime = runtimeById.get(id);
  if (runtime?.committing) return;
  updateItem(id, (item) => {
    if (isTerminal(item.status) || item.status === DOWNLOAD_TRANSFER_STATUS.PAUSED) return item;
    if (item.route === DOWNLOAD_TRANSFER_ROUTE.R2 && route !== DOWNLOAD_TRANSFER_ROUTE.R2) {
      if (runtime) {
        clearRuntimeTimer(runtime); runtime.pending = null;
        runtime.lastSampleAt = now; runtime.lastSampleBytes = 0; runtime.speedBps = 0; runtime.lastPublishedAt = 0;
      }
      return { ...item, route, status, loadedBytes: 0, totalBytes: null, speedBps: 0, etaSeconds: null, updatedAt: now };
    }
    return { ...item, route, status, updatedAt: now };
  });
}

export function reportDownloadTransferProgress(
  id: string,
  loadedBytes: number,
  totalBytes: number | null,
  now = Date.now(),
  signal?: AbortSignal,
): void {
  const runtime = runtimeById.get(id);
  const item = snapshot.find((entry) => entry.id === id);
  if (!runtime || !item || isInactive(item.status) || runtime.committing || !isCurrentDownloadSignal(id, signal)) return;
  const activeSignal = signal ?? runtime.controller.signal;
  const sample = {
    loadedBytes: Math.max(0, loadedBytes),
    totalBytes: totalBytes === null ? null : Math.max(0, totalBytes),
    now,
  };
  const final = sample.totalBytes !== null && sample.loadedBytes >= sample.totalBytes;
  if (final || now - runtime.lastPublishedAt >= PUBLISH_INTERVAL_MS) {
    applyProgress(id, sample);
    return;
  }
  runtime.pending = sample;
  if (!runtime.timer) {
    runtime.timer = setTimeout(() => {
      const currentRuntime = runtimeById.get(id);
      const currentItem = snapshot.find((entry) => entry.id === id);
      if (!currentRuntime || !currentItem || isInactive(currentItem.status)
        || currentRuntime.committing || !isCurrentDownloadSignal(id, activeSignal)) {
        return;
      }
      const latest = currentRuntime.pending;
      if (latest) applyProgress(id, { ...latest, now: Date.now() });
    }, PUBLISH_INTERVAL_MS - Math.max(0, now - runtime.lastPublishedAt));
  }
}

export function canPauseDownloadTransfer(id: string): boolean {
  const runtime = runtimeById.get(id);
  const item = snapshot.find((entry) => entry.id === id);
  return !!runtime?.retry && runtime.pausable && !runtime.committing && !!item && !isInactive(item.status)
    && item.status !== DOWNLOAD_TRANSFER_STATUS.PAUSED;
}

export function canCancelDownloadTransfer(id: string): boolean {
  const runtime = runtimeById.get(id);
  const item = snapshot.find((entry) => entry.id === id);
  return !!runtime && !!item && !runtime.committing
    && item.status !== DOWNLOAD_TRANSFER_STATUS.READY_TO_SAVE
    && !isTerminal(item.status)
    && (!runtime.controller.signal.aborted || item.status === DOWNLOAD_TRANSFER_STATUS.PAUSED);
}

/**
 * Lock out pause, cancel, and the stall watchdog immediately before committing
 * the destination writer (`writer.close()`), preventing irreversible disk commits
 * from flipping to `canceled` or `failed`.
 */
export function beginDownloadCommit(id: string, signal?: AbortSignal): boolean {
  const runtime = runtimeById.get(id);
  const item = snapshot.find((entry) => entry.id === id);
  if (!runtime || !item || isTerminal(item.status) || item.status === DOWNLOAD_TRANSFER_STATUS.PAUSED) {
    return false;
  }
  if (!isCurrentDownloadSignal(id, signal) || signal?.aborted || runtime.controller.signal.aborted) {
    return false;
  }
  if (runtime.pending) applyProgress(id, { ...runtime.pending, now: Date.now() });
  clearRuntimeTimer(runtime);
  clearStallTimer(runtime);
  runtime.pending = null;
  runtime.committing = true;
  publish([...snapshot]);
  return true;
}

/** Restore cancel/retry eligibility if `writer.close()` throws before settling. */
export function abortDownloadCommit(id: string, signal?: AbortSignal): void {
  const runtime = runtimeById.get(id);
  if (!runtime || !runtime.committing || !isCurrentDownloadSignal(id, signal)) return;
  runtime.committing = false;
  publish([...snapshot]);
}

export function canResumeDownloadTransfer(id: string): boolean {
  const item = snapshot.find((entry) => entry.id === id);
  return !!item && item.status === DOWNLOAD_TRANSFER_STATUS.PAUSED;
}

/** Lets the initiating promise distinguish a user pause from cancellation. */
export function isDownloadTransferPaused(id: string): boolean {
  return snapshot.find((entry) => entry.id === id)?.status === DOWNLOAD_TRANSFER_STATUS.PAUSED;
}

export function pauseDownloadTransfer(id: string, now = Date.now()): void {
  const runtime = runtimeById.get(id);
  const item = snapshot.find((entry) => entry.id === id);
  if (!runtime || !item || !canPauseDownloadTransfer(id)) return;
  runtime.controller.abort();
  clearRuntimeTimer(runtime);
  clearStallTimer(runtime);
  updateItem(id, (current) => ({
    ...current,
    status: DOWNLOAD_TRANSFER_STATUS.PAUSED,
    speedBps: 0,
    updatedAt: now,
  }));
}

export async function resumeDownloadTransfer(id: string, now = Date.now()): Promise<void> {
  if (!canResumeDownloadTransfer(id)) return;
  await retryDownloadTransfer(id, now);
}

function settleDownloadTransfer(
  id: string,
  status: DownloadTransferStatus,
  route?: DownloadTransferRoute,
  now = Date.now(),
  signal?: AbortSignal,
  forceCancelPaused = false,
): void {
  if (!isCurrentDownloadSignal(id, signal)) return;
  const runtime = runtimeById.get(id);
  if (runtime?.pending) applyProgress(id, { ...runtime.pending, now });
  clearRuntimeTimer(runtime);
  clearStallTimer(runtime);
  if (runtime) {
    runtime.committing = false;
    runtime.save = null;
    if (status !== DOWNLOAD_TRANSFER_STATUS.COMPLETED) runtime.savedFile = null;
  }
  updateItem(id, (item) => (isTerminal(item.status) || (!forceCancelPaused && item.status === DOWNLOAD_TRANSFER_STATUS.PAUSED)) ? item : ({
    ...item,
    ...(route ? { route } : {}),
    status,
    speedBps: status === DOWNLOAD_TRANSFER_STATUS.COMPLETED ? item.speedBps : 0,
    updatedAt: now,
  }));
}

export function completeDownloadTransfer(id: string, handedOff = false, now = Date.now(), signal?: AbortSignal): void {
  settleDownloadTransfer(
    id,
    handedOff ? DOWNLOAD_TRANSFER_STATUS.HANDED_OFF : DOWNLOAD_TRANSFER_STATUS.COMPLETED,
    handedOff ? DOWNLOAD_TRANSFER_ROUTE.BROWSER : undefined,
    now,
    signal,
  );
}

/**
 * Attach the file a completed download was saved to, so its row can offer
 * "Show in folder". Only a handle the page can read back is kept; anything
 * else leaves the row without the button.
 */
export function setDownloadTransferSavedFile(id: string, handle: SavedDownloadFileHandle | null): void {
  const runtime = runtimeById.get(id);
  const item = snapshot.find((entry) => entry.id === id);
  if (!runtime || item?.status !== DOWNLOAD_TRANSFER_STATUS.COMPLETED) return;
  runtime.savedFile = handle;
  // Republish so an already-rendered row picks up its new button.
  publish([...snapshot]);
}

export function canRevealDownloadTransfer(id: string): boolean {
  const item = snapshot.find((entry) => entry.id === id);
  const handle = runtimeById.get(id)?.savedFile;
  return !!handle
    && item?.status === DOWNLOAD_TRANSFER_STATUS.COMPLETED
    && canRevealSavedDownload(handle);
}

/** Call synchronously from the click: the file dialog needs the user's gesture. */
export function revealDownloadTransfer(id: string): boolean {
  const handle = runtimeById.get(id)?.savedFile;
  return canRevealDownloadTransfer(id) && !!handle && revealSavedDownload(handle);
}

export function failDownloadTransfer(id: string, canceled = false, now = Date.now(), signal?: AbortSignal): void {
  settleDownloadTransfer(id, canceled ? DOWNLOAD_TRANSFER_STATUS.CANCELED : DOWNLOAD_TRANSFER_STATUS.FAILED, undefined, now, signal, false);
}

export function cancelDownloadTransfer(id: string): void {
  const runtime = runtimeById.get(id);
  const item = snapshot.find((entry) => entry.id === id);
  if (!runtime || !item || !canCancelDownloadTransfer(id)) return;
  const activeSignal = runtime.controller.signal;
  runtime.controller.abort();
  settleDownloadTransfer(id, DOWNLOAD_TRANSFER_STATUS.CANCELED, undefined, Date.now(), activeSignal, true);
}

export function dismissDownloadTransfer(id: string): void {
  const item = snapshot.find((entry) => entry.id === id);
  if (!item || !isInactive(item.status)) return;
  const runtime = runtimeById.get(id);
  if (runtime) {
    clearRuntimeTimer(runtime);
    clearStallTimer(runtime);
  }
  runtimeById.delete(id);
  publish(snapshot.filter((entry) => entry.id !== id));
}

export function clearFinishedDownloadTransfers(): void {
  const finished = snapshot.filter((item) => isTerminal(item.status));
  if (finished.length === 0) return;
  for (const item of finished) {
    const runtime = runtimeById.get(item.id);
    if (runtime) {
      clearRuntimeTimer(runtime);
      clearStallTimer(runtime);
    }
    runtimeById.delete(item.id);
  }
  publish(snapshot.filter((item) => !isTerminal(item.status)));
}

export function __resetDownloadTransfersForTests(): void {
  for (const runtime of runtimeById.values()) {
    clearRuntimeTimer(runtime);
    clearStallTimer(runtime);
  }
  runtimeById.clear();
  snapshot = [];
  listeners.clear();
}

/** Preparation bytes belong to the daemon → R2 PUT, not the user's download. */
export function reportR2Preparation(id: string, progress: R2RelayProgress, signal?: AbortSignal): void {
  const runtime = runtimeById.get(id);
  const item = snapshot.find((entry) => entry.id === id);
  if (!runtime || runtime.committing || !isCurrentDownloadSignal(id, signal)
    || runtime.controller.signal.aborted || !item || isInactive(item.status)) return;
  updateItem(id, (current) => ({ ...current, route: DOWNLOAD_TRANSFER_ROUTE.R2,
    status: DOWNLOAD_TRANSFER_STATUS.PREPARING, loadedBytes: progress.loadedBytes,
    totalBytes: progress.totalBytes, speedBps: progress.speedBps, etaSeconds: progress.etaSeconds, updatedAt: Date.now() }));
}
