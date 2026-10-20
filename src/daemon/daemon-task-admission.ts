import { randomUUID } from 'node:crypto';
import { freemem } from 'node:os';
import { TASK_ADMISSION, type TaskAdmission } from '../../shared/session-resource-lifecycle.js';
import { evaluateDaemonTaskAdmission } from './memory-mcp-resource-guard.js';

export interface DaemonTaskAdmissionOptions {
  daemonMaxRssBytes: number;
  sessionMaxBytes: number;
  systemMinFreeBytes: number;
  reservationBytes: number;
  reservationTtlMs: number;
  memoryUsage?: () => { rss: number };
  systemFreeBytes?: () => number;
  now?: () => number;
}

export interface DaemonTaskAdmissionResult {
  action: TaskAdmission;
  token?: string;
  retryAfterMs?: number;
}

interface Reservation {
  token: string;
  sessionName: string;
  bytes: number;
  expiresAt: number;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid_${name}`);
  return value;
}

export class DaemonTaskAdmissionController {
  private readonly reservations = new Map<string, Reservation>();
  private readonly options: Required<DaemonTaskAdmissionOptions>;

  constructor(options: DaemonTaskAdmissionOptions) {
    this.options = {
      daemonMaxRssBytes: positive(options.daemonMaxRssBytes, 'daemon_max_rss_bytes'),
      sessionMaxBytes: positive(options.sessionMaxBytes, 'session_max_bytes'),
      systemMinFreeBytes: positive(options.systemMinFreeBytes, 'system_min_free_bytes'),
      reservationBytes: positive(options.reservationBytes, 'reservation_bytes'),
      reservationTtlMs: positive(options.reservationTtlMs, 'reservation_ttl_ms'),
      memoryUsage: options.memoryUsage ?? process.memoryUsage,
      systemFreeBytes: options.systemFreeBytes ?? freemem,
      now: options.now ?? Date.now,
    };
  }

  private reapExpired(): void {
    const now = this.options.now();
    for (const [token, reservation] of this.reservations) {
      if (reservation.expiresAt < now) this.reservations.delete(token);
    }
  }

  acquire(sessionName: string, requestedBytes = 0, sessionCurrentBytes = 0): DaemonTaskAdmissionResult {
    this.reapExpired();
    if (!sessionName.trim() || !Number.isFinite(requestedBytes) || requestedBytes < 0
      || !Number.isFinite(sessionCurrentBytes) || sessionCurrentBytes < 0) {
      return { action: TASK_ADMISSION.REJECT };
    }
    const bytes = Math.max(this.options.reservationBytes, requestedBytes);
    const allReserved = [...this.reservations.values()].reduce((sum, reservation) => sum + reservation.bytes, 0);
    const sessionReserved = [...this.reservations.values()]
      .filter((reservation) => reservation.sessionName === sessionName)
      .reduce((sum, reservation) => sum + reservation.bytes, 0);
    const action = evaluateDaemonTaskAdmission({
      daemonRssBytes: this.options.memoryUsage().rss + allReserved + bytes,
      daemonMaxRssBytes: this.options.daemonMaxRssBytes,
      sessionReservedBytes: sessionCurrentBytes + sessionReserved + bytes,
      sessionMaxBytes: this.options.sessionMaxBytes,
      systemFreeBytes: this.options.systemFreeBytes() - bytes,
      systemMinFreeBytes: this.options.systemMinFreeBytes,
    });
    if (action !== TASK_ADMISSION.ACCEPT) {
      return { action, ...(action === TASK_ADMISSION.QUEUE ? { retryAfterMs: 250 } : {}) };
    }
    const token = randomUUID();
    this.reservations.set(token, {
      token,
      sessionName,
      bytes,
      expiresAt: this.options.now() + this.options.reservationTtlMs,
    });
    return { action, token };
  }

  release(sessionName: string, token: string): boolean {
    this.reapExpired();
    const reservation = this.reservations.get(token);
    if (!reservation || reservation.sessionName !== sessionName) return false;
    this.reservations.delete(token);
    return true;
  }
}

function envBytes(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

let defaultController: DaemonTaskAdmissionController | null = null;

export function getDaemonTaskAdmissionController(): DaemonTaskAdmissionController {
  defaultController ??= new DaemonTaskAdmissionController({
    daemonMaxRssBytes: envBytes('IMCODES_DAEMON_MAX_RSS_BYTES', 2 * 1024 * 1024 * 1024),
    sessionMaxBytes: envBytes('IMCODES_SESSION_MAX_RESERVED_BYTES', 512 * 1024 * 1024),
    systemMinFreeBytes: envBytes('IMCODES_SYSTEM_MIN_FREE_BYTES', 512 * 1024 * 1024),
    reservationBytes: envBytes('IMCODES_TASK_MEMORY_RESERVATION_BYTES', 64 * 1024 * 1024),
    reservationTtlMs: envBytes('IMCODES_TASK_MEMORY_RESERVATION_TTL_MS', 5 * 60_000),
  });
  return defaultController;
}
