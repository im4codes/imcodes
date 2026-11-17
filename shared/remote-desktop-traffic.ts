import { hasExactRemoteDesktopKeys, isRemoteDesktopId, isRemoteDesktopRecord } from './remote-desktop-contract-primitives.js';

/** Endpoint WebRTC transport bytes (media, retransmissions and data channels),
 * not IP/TURN billing bytes. Never sum RTP/candidate/data-channel stats too. */
export const REMOTE_DESKTOP_TRAFFIC = {
  WORKER_MESSAGE: 'remote_desktop.traffic',
  HISTORY_LIMIT: 200,
  STORE_FILE: 'remote-desktop-traffic.json',
} as const;

export interface RemoteDesktopTraffic {
  bytesSent: number;
  bytesReceived: number;
}
/** Local authenticated worker telemetry, never a signaling-server message. */
export interface RemoteDesktopWorkerTraffic extends RemoteDesktopTraffic {
  type: typeof REMOTE_DESKTOP_TRAFFIC.WORKER_MESSAGE;
  requestId: string;
  sessionId: string;
  capability: string;
  transportId: string;
}
export function isRemoteDesktopWorkerTraffic(value: unknown): value is RemoteDesktopWorkerTraffic {
  return isRemoteDesktopRecord(value)
    && hasExactRemoteDesktopKeys(value, [
      'type', 'requestId', 'sessionId', 'capability', 'transportId', 'bytesSent', 'bytesReceived',
    ])
    && value.type === REMOTE_DESKTOP_TRAFFIC.WORKER_MESSAGE
    && isRemoteDesktopId(value.requestId) && isRemoteDesktopId(value.sessionId)
    && isRemoteDesktopId(value.capability)
    && typeof value.transportId === 'string' && value.transportId.length > 0 && value.transportId.length <= 256
    && isRemoteDesktopTraffic(value);
}

export interface RemoteDesktopTrafficRecord extends RemoteDesktopTraffic {
  id: string;
  label: string;
  connectedAt: number;
  endedAt?: number;
  measured: boolean;
}
export interface RemoteDesktopTrafficHistory {
  total: RemoteDesktopTraffic;
  connections: readonly RemoteDesktopTrafficRecord[];
  persistenceError?: boolean;
}
export function isTrafficCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function isRemoteDesktopTraffic(value: unknown): value is RemoteDesktopTraffic {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return isTrafficCounter(raw.bytesSent) && isTrafficCounter(raw.bytesReceived);
}
export function addTrafficBytes(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}
/** Monotonic total per transport ID. Duplicate reports do not count twice;
 * counter reset or peer replacement starts a fresh counter segment. */
export class RemoteDesktopTrafficCounter {
  private counters = new Map<string, RemoteDesktopTraffic & { timestamp?: number }>();
  readonly total: RemoteDesktopTraffic = { bytesSent: 0, bytesReceived: 0 };
  observe(id: string, value: RemoteDesktopTraffic, timestamp?: number): void {
    if (!isRemoteDesktopTraffic(value)) return;
    const previous = this.counters.get(id);
    const sampledAt = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : undefined;
    if (sampledAt !== undefined && previous?.timestamp !== undefined && sampledAt <= previous.timestamp) return;
    for (const key of ['bytesSent', 'bytesReceived'] as const) {
      const delta = previous && value[key] >= previous[key] ? value[key] - previous[key] : value[key];
      this.total[key] = addTrafficBytes(this.total[key], delta);
    }
    this.counters.set(id, { ...value, timestamp: sampledAt });
  }
  /** Peer generation changed; retain accumulated bytes, retire old IDs. */
  nextPeer(): void { this.counters.clear(); }
}
export function formatRemoteDesktopBytes(bytes: number): string {
  if (!isTrafficCounter(bytes)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const index = bytes === 0 ? 0 : Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
