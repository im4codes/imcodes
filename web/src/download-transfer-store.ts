export const DOWNLOAD_TRANSFER_STATUS = {
  PREPARING: 'preparing',
  CONNECTING: 'connecting',
  TRANSFERRING: 'transferring',
  FALLING_BACK: 'falling_back',
  HANDED_OFF: 'handed_off',
  READY_TO_SAVE: 'ready_to_save',
  COMPLETED: 'completed',
  CANCELED: 'canceled',
  FAILED: 'failed',
} as const;

export const DOWNLOAD_TRANSFER_ROUTE = {
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
  readonly startedAt: number;
  readonly updatedAt: number;
}

type Listener = () => void;
type ProgressSample = { loadedBytes: number; totalBytes: number | null; now: number };
type RetryHandler = (signal: AbortSignal) => Promise<void>;
type SaveHandler = () => Promise<void>;
type Runtime = {
  controller: AbortController;
  retry: RetryHandler | null;
  save: SaveHandler | null;
  saveInFlight: boolean;
  lastSampleAt: number;
  lastSampleBytes: number;
  speedBps: number;
  lastPublishedAt: number;
  pending: ProgressSample | null;
  timer: ReturnType<typeof setTimeout> | null;
};

const PUBLISH_INTERVAL_MS = 200;
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
  return status === DOWNLOAD_TRANSFER_STATUS.READY_TO_SAVE || isTerminal(status);
}

function clearRuntimeTimer(runtime: Runtime | undefined): void {
  if (!runtime) return;
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = null;
}

function applyProgress(id: string, sample: ProgressSample): void {
  const runtime = runtimeById.get(id);
  if (!runtime) return;
  clearRuntimeTimer(runtime);
  runtime.pending = null;
  const elapsedMs = Math.max(0, sample.now - runtime.lastSampleAt);
  if (sample.loadedBytes < runtime.lastSampleBytes) runtime.speedBps = 0;
  const deltaBytes = Math.max(0, sample.loadedBytes - runtime.lastSampleBytes);
  if (elapsedMs > 0 && deltaBytes > 0) {
    const instantaneous = deltaBytes / (elapsedMs / 1000);
    runtime.speedBps = runtime.speedBps > 0
      ? (runtime.speedBps * 0.7) + (instantaneous * 0.3)
      : instantaneous;
  }
  runtime.lastSampleAt = sample.now;
  runtime.lastSampleBytes = sample.loadedBytes;
  runtime.lastPublishedAt = sample.now;
  updateItem(id, (item) => ({
    ...item,
    status: DOWNLOAD_TRANSFER_STATUS.TRANSFERRING,
    loadedBytes: sample.loadedBytes,
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

export function beginDownloadTransfer(name: string, now = Date.now()): { id: string; signal: AbortSignal } {
  const id = crypto.randomUUID();
  const controller = new AbortController();
  runtimeById.set(id, {
    controller,
    retry: null,
    save: null,
    saveInFlight: false,
    lastSampleAt: now,
    lastSampleBytes: 0,
    speedBps: 0,
    lastPublishedAt: now,
    pending: null,
    timer: null,
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

export function setDownloadTransferRetry(id: string, retry: RetryHandler): void {
  const runtime = runtimeById.get(id);
  if (runtime) runtime.retry = retry;
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
  if (!runtime?.retry || item?.status !== DOWNLOAD_TRANSFER_STATUS.FAILED) return;
  clearRuntimeTimer(runtime);
  runtime.controller = new AbortController();
  runtime.lastSampleAt = now;
  runtime.lastSampleBytes = 0;
  runtime.speedBps = 0;
  runtime.lastPublishedAt = now;
  runtime.pending = null;
  updateItem(id, (current) => ({
    ...current,
    status: DOWNLOAD_TRANSFER_STATUS.PREPARING,
    route: DOWNLOAD_TRANSFER_ROUTE.PENDING,
    loadedBytes: 0,
    speedBps: 0,
    startedAt: now,
    updatedAt: now,
  }));
  try {
    await runtime.retry(runtime.controller.signal);
  } catch {
    const current = snapshot.find((entry) => entry.id === id);
    if (current && !isTerminal(current.status)) failDownloadTransfer(id);
  }
}

export function updateDownloadTransfer(
  id: string,
  route: DownloadTransferRoute,
  status: DownloadTransferStatus,
  now = Date.now(),
): void {
  updateItem(id, (item) => isTerminal(item.status) ? item : { ...item, route, status, updatedAt: now });
}

export function reportDownloadTransferProgress(
  id: string,
  loadedBytes: number,
  totalBytes: number | null,
  now = Date.now(),
): void {
  const runtime = runtimeById.get(id);
  const item = snapshot.find((entry) => entry.id === id);
  if (!runtime || !item || isInactive(item.status)) return;
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
      const latest = runtime.pending;
      if (latest) applyProgress(id, { ...latest, now: Date.now() });
    }, PUBLISH_INTERVAL_MS - Math.max(0, now - runtime.lastPublishedAt));
  }
}

function settleDownloadTransfer(id: string, status: DownloadTransferStatus, route?: DownloadTransferRoute, now = Date.now()): void {
  const runtime = runtimeById.get(id);
  if (runtime?.pending) applyProgress(id, { ...runtime.pending, now });
  clearRuntimeTimer(runtime);
  if (runtime) runtime.save = null;
  updateItem(id, (item) => isTerminal(item.status) ? item : ({
    ...item,
    ...(route ? { route } : {}),
    status,
    speedBps: status === DOWNLOAD_TRANSFER_STATUS.COMPLETED ? item.speedBps : 0,
    updatedAt: now,
  }));
}

export function completeDownloadTransfer(id: string, handedOff = false, now = Date.now()): void {
  settleDownloadTransfer(
    id,
    handedOff ? DOWNLOAD_TRANSFER_STATUS.HANDED_OFF : DOWNLOAD_TRANSFER_STATUS.COMPLETED,
    handedOff ? DOWNLOAD_TRANSFER_ROUTE.BROWSER : undefined,
    now,
  );
}

export function failDownloadTransfer(id: string, canceled = false, now = Date.now()): void {
  settleDownloadTransfer(id, canceled ? DOWNLOAD_TRANSFER_STATUS.CANCELED : DOWNLOAD_TRANSFER_STATUS.FAILED, undefined, now);
}

export function cancelDownloadTransfer(id: string): void {
  const runtime = runtimeById.get(id);
  const item = snapshot.find((entry) => entry.id === id);
  if (!runtime || !item || isInactive(item.status) || runtime.controller.signal.aborted) return;
  runtime.controller.abort();
  failDownloadTransfer(id, true);
}

export function dismissDownloadTransfer(id: string): void {
  const item = snapshot.find((entry) => entry.id === id);
  if (!item || !isInactive(item.status)) return;
  const runtime = runtimeById.get(id);
  if (runtime) clearRuntimeTimer(runtime);
  runtimeById.delete(id);
  publish(snapshot.filter((entry) => entry.id !== id));
}

export function clearFinishedDownloadTransfers(): void {
  const finished = snapshot.filter((item) => isTerminal(item.status));
  if (finished.length === 0) return;
  for (const item of finished) {
    const runtime = runtimeById.get(item.id);
    if (runtime) clearRuntimeTimer(runtime);
    runtimeById.delete(item.id);
  }
  publish(snapshot.filter((item) => !isTerminal(item.status)));
}

export function __resetDownloadTransfersForTests(): void {
  for (const runtime of runtimeById.values()) clearRuntimeTimer(runtime);
  runtimeById.clear();
  snapshot = [];
  listeners.clear();
}
