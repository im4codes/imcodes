/** Opt-in, object-store-only file relay. Never change the default direct route. */
export const FILE_RELAY_MODE = { DIRECT: 'direct', R2: 'r2_relay' } as const;
export type FileRelayMode = typeof FILE_RELAY_MODE[keyof typeof FILE_RELAY_MODE];
export const R2_RELAY_CAPABILITY = 'file.r2_relay.v1' as const;
export const R2_RELAY_MSG = {
  DOWNLOAD: 'file.r2_download', PROGRESS: 'file.r2_progress', DONE: 'file.r2_done',
} as const;
export const R2_RELAY_PHASE = { PREPARING: 'preparing', READY: 'ready', ERROR: 'error' } as const;
export const R2_RELAY_LIMITS = {
  URL_TTL_SECONDS: 900, OBJECT_TTL_MS: 12 * 60 * 60 * 1000,
  SWEEP_INTERVAL_MS: 60_000, PROGRESS_INTERVAL_MS: 200, PREFIX: 'staging/',
} as const;
export const R2_RELAY_ERROR = {
  FAILED: 'r2_relay_failed', INVALID: 'r2_relay_invalid', EXPIRED: 'r2_relay_expired',
} as const;
export const R2_RELAY_API = { ROOT: 'r2-relay', UPLOADS: 'uploads', DOWNLOADS: 'downloads' } as const;
export const R2_RELAY_PREFERENCE_KEY = 'imcodes.file-relay-mode';
export interface R2RelayConfig {
  accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string;
}
export interface R2RelayProgress {
  phase: typeof R2_RELAY_PHASE.PREPARING;
  loadedBytes: number; totalBytes: number; speedBps: number; etaSeconds: number | null;
}
export interface R2RelayReady { phase: typeof R2_RELAY_PHASE.READY; url: string; }
/** EWMA updated no more often than the producer's publishing interval. */
export function createR2Progress(totalBytes: number, startedAt = Date.now()) {
  let lastAt = startedAt; let lastBytes = 0; let speedBps = 0;
  return (bytes: number, now = Date.now()): R2RelayProgress => {
    const loadedBytes = Math.min(totalBytes, Math.max(lastBytes, bytes));
    const elapsed = now - lastAt;
    if (elapsed > 0) {
      const instant = (loadedBytes - lastBytes) * 1000 / elapsed;
      speedBps = speedBps > 0 ? speedBps * 0.7 + instant * 0.3 : instant;
      lastAt = now; lastBytes = loadedBytes;
    }
    return { phase: R2_RELAY_PHASE.PREPARING, loadedBytes, totalBytes, speedBps,
      etaSeconds: loadedBytes >= totalBytes ? 0 : speedBps > 0 ? Math.ceil((totalBytes - loadedBytes) / speedBps) : null };
  };
}
export interface R2RelayDownloadRequest {
  type: typeof R2_RELAY_MSG.DOWNLOAD; downloadId: string; attachmentId: string; uploadUrl: string;
  /** Object PUTs are whole-object transfers; direct HTTP resume keeps its old protocol. */
  offset?: never;
}
export interface R2RelayProgressMessage extends R2RelayProgress {
  type: typeof R2_RELAY_MSG.PROGRESS; downloadId: string;
}
export interface R2RelayDownloadDone {
  type: typeof R2_RELAY_MSG.DONE; downloadId: string; filename: string; mime?: string; size: number;
}
