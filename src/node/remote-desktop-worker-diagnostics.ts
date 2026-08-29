import {
  appendFile,
  mkdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { windowsCredentialDir } from './installer.js';

export const REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT = {
  SPAWN_VERIFIED: 'spawn_verified',
  PREPARE_SENT: 'prepare_sent',
  PREPARE_READY: 'prepare_ready',
  PREPARE_TIMEOUT: 'prepare_timeout',
  OFFER_SENT: 'offer_sent',
  ANSWER: 'answer',
  OFFER_TIMEOUT: 'offer_timeout',
  PIPE_ERROR: 'pipe_error',
  PIPE_CLOSE: 'pipe_close',
  PROCESS_EXIT: 'process_exit',
  CRASH_FRAME: 'crash_frame',
  CLEANUP: 'cleanup',
} as const;

export type RemoteDesktopWorkerDiagnosticEventName =
  typeof REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT[
    keyof typeof REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT
  ];

export const REMOTE_DESKTOP_WORKER_DIAGNOSTIC_LOG_FILE =
  'remote-desktop-worker.log' as const;
export const REMOTE_DESKTOP_WORKER_DIAGNOSTIC_MAX_BYTES = 1024 * 1024;
export const REMOTE_DESKTOP_WORKER_DIAGNOSTIC_MAX_FILES = 3;
export const REMOTE_DESKTOP_WORKER_DIAGNOSTIC_RETRY_MS = 60_000;
export const REMOTE_DESKTOP_WORKER_DIAGNOSTIC_QUEUE_CAPACITY = 256;

const CORRELATION_ID_RE = /^[a-f0-9]{24}$/;
const EVENT_NAMES = new Set<unknown>(
  Object.values(REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT),
);
const LAUNCH_MODES = new Set<unknown>(['session', 'consent_only', 'privacy_only']);
const ERROR_CODES = new Set<unknown>([
  'EACCES',
  'ECONNABORTED',
  'ECONNRESET',
  'ENOENT',
  'ENOSPC',
  'EPERM',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'UNKNOWN',
  'WRITE_FAILED',
]);
const SIGNALS = new Set<unknown>([
  'SIGABRT',
  'SIGBREAK',
  'SIGHUP',
  'SIGINT',
  'SIGKILL',
  'SIGTERM',
]);
const CLEANUP_REASONS = new Set<unknown>([
  'authority_removed',
  'controller_cancel',
  'controller_stop',
  'daemon_replaced',
  'watchdog_timeout',
  'worker_failed',
  'worker_terminal',
]);

export interface RemoteDesktopWorkerDiagnosticEvent {
  event: RemoteDesktopWorkerDiagnosticEventName;
  correlationId: string;
  workerGeneration?: number;
  workerPid?: number | null;
  elapsedMs?: number;
  launchMode?: 'session' | 'consent_only' | 'privacy_only';
  errorCode?: string;
  hadError?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  observedBy?: 'pipe_close';
  cleanupReason?: string;
  stdio?: 'ignored';
}

interface RemoteDesktopWorkerDiagnosticRecord
  extends RemoteDesktopWorkerDiagnosticEvent {
  version: 1;
  timestamp: string;
  repeatCount?: number;
}

interface QueuedRecord {
  record: RemoteDesktopWorkerDiagnosticRecord;
  coalescingKey: string;
}

export interface RemoteDesktopWorkerDiagnosticsFileSystem {
  appendFile: typeof appendFile;
  mkdir: typeof mkdir;
  rename: typeof rename;
  rm: typeof rm;
  stat: typeof stat;
}

export interface RemoteDesktopWorkerDiagnosticsOptions {
  logPath?: string;
  maxBytes?: number;
  maxFiles?: number;
  retryMs?: number;
  queueCapacity?: number;
  now?: () => number;
  schedule?: (callback: () => void) => void;
  fileSystem?: Partial<RemoteDesktopWorkerDiagnosticsFileSystem>;
}

export interface RemoteDesktopWorkerDiagnosticsQueueState {
  pending: number;
  dropped: number;
  coalesced: number;
  flushing: boolean;
}

export function remoteDesktopWorkerDiagnosticsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    windowsCredentialDir(env),
    'logs',
    REMOTE_DESKTOP_WORKER_DIAGNOSTIC_LOG_FILE,
  );
}

function safeInteger(value: unknown, minimum = 0): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= minimum
    ? value
    : undefined;
}

function safeNullableInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  return safeInteger(value, -0x80000000);
}

function boundedRecord(
  input: RemoteDesktopWorkerDiagnosticEvent,
  now: number,
): RemoteDesktopWorkerDiagnosticRecord | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (!EVENT_NAMES.has(input.event)
    || typeof input.event !== 'string'
    || typeof input.correlationId !== 'string'
    || !CORRELATION_ID_RE.test(input.correlationId)) return null;
  const workerGeneration = safeInteger(input.workerGeneration);
  const workerPid = input.workerPid === null
    ? null
    : safeInteger(input.workerPid, 1);
  const elapsedMs = safeInteger(input.elapsedMs);
  const exitCode = safeNullableInteger(input.exitCode);
  const signal = input.signal === null
    ? null
    : typeof input.signal === 'string' && SIGNALS.has(input.signal)
      ? input.signal
      : undefined;
  const errorCode = typeof input.errorCode === 'string'
    && ERROR_CODES.has(input.errorCode)
    ? input.errorCode
    : undefined;
  const cleanupReason = typeof input.cleanupReason === 'string'
    && CLEANUP_REASONS.has(input.cleanupReason)
    ? input.cleanupReason
    : undefined;
  const launchMode = LAUNCH_MODES.has(input.launchMode)
    && typeof input.launchMode === 'string'
    ? input.launchMode as RemoteDesktopWorkerDiagnosticEvent['launchMode']
    : undefined;
  const hadError = typeof input.hadError === 'boolean' ? input.hadError : undefined;
  const observedBy = input.observedBy === 'pipe_close' ? input.observedBy : undefined;
  const stdio = input.stdio === 'ignored' ? input.stdio : undefined;
  return {
    version: 1,
    timestamp: new Date(now).toISOString(),
    event: input.event as RemoteDesktopWorkerDiagnosticEventName,
    correlationId: input.correlationId,
    ...(workerGeneration === undefined ? {} : { workerGeneration }),
    ...(workerPid === undefined ? {} : { workerPid }),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(launchMode === undefined ? {} : { launchMode }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(hadError === undefined ? {} : { hadError }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    ...(observedBy === undefined ? {} : { observedBy }),
    ...(cleanupReason === undefined ? {} : { cleanupReason }),
    ...(stdio === undefined ? {} : { stdio }),
  };
}

function coalescingKey(record: RemoteDesktopWorkerDiagnosticRecord): string {
  const { timestamp: _timestamp, repeatCount: _repeatCount, ...stable } = record;
  return JSON.stringify(stable);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Bounded, best-effort JSONL evidence for the LocalSystem worker host.
 *
 * `write()` only validates and enqueues. All filesystem/EDR work runs later on
 * a single asynchronous drain and is never awaited by socket/protocol paths.
 * The queue coalesces adjacent exact sanitized records, then drops newest at a
 * fixed capacity. Filesystem failure drops the pending batch and opens a retry
 * circuit; diagnostics never recursively log their own failures.
 */
export class RemoteDesktopWorkerDiagnostics {
  private readonly logPath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly retryMs: number;
  private readonly queueCapacity: number;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void) => void;
  private readonly fileSystem: RemoteDesktopWorkerDiagnosticsFileSystem;
  private readonly queue: QueuedRecord[] = [];
  private retryAt = 0;
  private scheduled = false;
  private flushing = false;
  private directoryReady = false;
  private currentBytes: number | null = null;
  private dropped = 0;
  private coalesced = 0;

  constructor(options: RemoteDesktopWorkerDiagnosticsOptions = {}) {
    this.logPath = options.logPath ?? remoteDesktopWorkerDiagnosticsPath();
    this.maxBytes = Math.max(1024, options.maxBytes
      ?? REMOTE_DESKTOP_WORKER_DIAGNOSTIC_MAX_BYTES);
    this.maxFiles = Math.max(1, options.maxFiles
      ?? REMOTE_DESKTOP_WORKER_DIAGNOSTIC_MAX_FILES);
    this.retryMs = Math.max(1, options.retryMs
      ?? REMOTE_DESKTOP_WORKER_DIAGNOSTIC_RETRY_MS);
    this.queueCapacity = Math.max(1, options.queueCapacity
      ?? REMOTE_DESKTOP_WORKER_DIAGNOSTIC_QUEUE_CAPACITY);
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback) => setImmediate(callback));
    this.fileSystem = {
      appendFile: options.fileSystem?.appendFile ?? appendFile,
      mkdir: options.fileSystem?.mkdir ?? mkdir,
      rename: options.fileSystem?.rename ?? rename,
      rm: options.fileSystem?.rm ?? rm,
      stat: options.fileSystem?.stat ?? stat,
    };
  }

  write(input: RemoteDesktopWorkerDiagnosticEvent): void {
    const now = this.now();
    if (now < this.retryAt) {
      this.dropped++;
      return;
    }
    const record = boundedRecord(input, now);
    if (!record) return;
    const key = coalescingKey(record);
    const last = this.queue.at(-1);
    if (last?.coalescingKey === key) {
      last.record = {
        ...record,
        repeatCount: Math.min((last.record.repeatCount ?? 1) + 1, 65_535),
      };
      this.coalesced++;
      return;
    }
    if (this.queue.length >= this.queueCapacity) {
      this.dropped++;
      return;
    }
    this.queue.push({ record, coalescingKey: key });
    this.scheduleDrain();
  }

  queueState(): RemoteDesktopWorkerDiagnosticsQueueState {
    return {
      pending: this.queue.length,
      dropped: this.dropped,
      coalesced: this.coalesced,
      flushing: this.flushing || this.scheduled,
    };
  }

  /** Test/shutdown observation seam; production signaling never calls this. */
  async drain(): Promise<void> {
    while (this.scheduled || this.flushing) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private scheduleDrain(): void {
    if (this.scheduled || this.flushing) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const now = this.now();
        if (now < this.retryAt) {
          this.dropped += this.queue.length;
          this.queue.length = 0;
          break;
        }
        const queued = this.queue.shift()!;
        const line = `${JSON.stringify(queued.record)}\n`;
        const bytes = Buffer.byteLength(line, 'utf8');
        if (bytes > this.maxBytes) {
          this.dropped++;
          continue;
        }
        await this.prepareFile(bytes);
        await this.fileSystem.appendFile(this.logPath, line, {
          encoding: 'utf8',
          flag: 'a',
        });
        this.currentBytes = (this.currentBytes ?? 0) + bytes;
        this.retryAt = 0;
      }
    } catch {
      this.retryAt = this.now() + this.retryMs;
      this.dropped += this.queue.length;
      this.queue.length = 0;
      this.directoryReady = false;
      this.currentBytes = null;
    } finally {
      this.flushing = false;
      if (this.queue.length > 0 && this.now() >= this.retryAt) this.scheduleDrain();
    }
  }

  private async prepareFile(nextBytes: number): Promise<void> {
    if (!this.directoryReady) {
      await this.fileSystem.mkdir(dirname(this.logPath), { recursive: true });
      this.directoryReady = true;
    }
    if (this.currentBytes === null) {
      try {
        this.currentBytes = (await this.fileSystem.stat(this.logPath)).size;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        this.currentBytes = 0;
      }
    }
    if (this.currentBytes + nextBytes <= this.maxBytes) return;
    await this.rotate();
    this.currentBytes = 0;
  }

  private async rotate(): Promise<void> {
    if (this.maxFiles === 1) {
      await this.fileSystem.rm(this.logPath, { force: true });
      return;
    }
    await this.fileSystem.rm(`${this.logPath}.${this.maxFiles - 1}`, { force: true });
    for (let index = this.maxFiles - 2; index >= 1; index--) {
      try {
        await this.fileSystem.rename(
          `${this.logPath}.${index}`,
          `${this.logPath}.${index + 1}`,
        );
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    try {
      await this.fileSystem.rename(this.logPath, `${this.logPath}.1`);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}
