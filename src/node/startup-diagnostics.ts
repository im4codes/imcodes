import {
  appendFile,
  mkdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, join, win32, posix } from 'node:path';
import { homedir } from 'node:os';
import { redactObject, type Redactable } from '../../shared/logging/redact.js';
import { windowsCredentialDir } from './installer.js';

/**
 * Pure observability. This module records what happened during a controlled
 * node's (or daemon's) startup/connect/authenticate/health-lease window; it
 * makes NO decisions about upgrade, rollback, or terminal fencing. Nothing
 * here reads or writes upgrade-transaction state.
 *
 * A real Windows upgrade on 6321982267 (office debug machine) failed
 * `restart_health` (rolled back) with zero persisted evidence of what
 * happened inside the 120s window: the scheduled task ran the exe with
 * stdout/stderr not redirected anywhere, and `last-upgrade-result.json`
 * only records the FINAL rolled_back outcome. This file exists to answer
 * "what did the new process actually observe before it gave up" the next
 * time this happens.
 */

export const STARTUP_DIAGNOSTICS_LOG_FILE = 'startup-diagnostics.log' as const;
export const STARTUP_DIAGNOSTICS_MAX_BYTES = 2 * 1024 * 1024;
export const STARTUP_DIAGNOSTICS_MAX_FILES = 3;
export const STARTUP_DIAGNOSTICS_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
export const STARTUP_DIAGNOSTICS_RETRY_MS = 30_000;
export const STARTUP_DIAGNOSTICS_QUEUE_CAPACITY = 512;
/** Matches the real incident: the server's authenticated-health gate. */
export const STARTUP_DIAGNOSTICS_HEALTH_LEASE_TIMEOUT_MS = 120_000;

export const STARTUP_DIAGNOSTIC_EVENT = {
  PROCESS_START: 'process_start',
  WS_CONNECT_ATTEMPT: 'ws_connect_attempt',
  WS_CONNECT_ESTABLISHED: 'ws_connect_established',
  WS_CONNECT_FAILED: 'ws_connect_failed',
  AUTH_SENT: 'auth_sent',
  AUTH_ACK: 'auth_ack',
  HEALTH_LEASE_PUBLISHED: 'health_lease_published',
  HEALTH_LEASE_TIMEOUT: 'health_lease_timeout',
} as const;

export type StartupDiagnosticEventType =
  typeof STARTUP_DIAGNOSTIC_EVENT[keyof typeof STARTUP_DIAGNOSTIC_EVENT];

/**
 * Steps that "we got this far, then something else happened" can be reported
 * against when a health-lease timeout fires. Deliberately excludes the
 * timeout event itself and PROCESS_START (every timeout implies process_start
 * already happened, so naming it back would add nothing).
 */
export type StartupDiagnosticStep = Exclude<
  StartupDiagnosticEventType,
  typeof STARTUP_DIAGNOSTIC_EVENT.HEALTH_LEASE_TIMEOUT | typeof STARTUP_DIAGNOSTIC_EVENT.PROCESS_START
> | 'none';

/**
 * Caller-supplied fields for one event. Kept as free-form `Record<string,
 * unknown>` rather than a narrow per-event union: callers are the ONLY
 * source of truth for what happened, and every value is redacted before it
 * ever reaches disk (see `redactObject`, reusing the exact
 * `/_token$/i` / `/_key$/i` / `/_secret$/i` convention `server/src/util/
 * logger.ts` already enforces). Never pass a raw auth frame, credential
 * object, or full URL with embedded query-string secrets here — construct a
 * minimal safe object instead; redaction is defense-in-depth, not the
 * primary safeguard.
 */
export type StartupDiagnosticFields = Record<string, unknown>;

interface StartupDiagnosticRecord {
  version: 1;
  timestamp: string;
  type: StartupDiagnosticEventType;
  [key: string]: unknown;
}

interface QueuedRecord {
  record: StartupDiagnosticRecord;
}

export interface StartupDiagnosticsFileSystem {
  appendFile: typeof appendFile;
  mkdir: typeof mkdir;
  rename: typeof rename;
  rm: typeof rm;
  stat: typeof stat;
}

export interface StartupDiagnosticsOptions {
  logPath?: string;
  maxBytes?: number;
  maxFiles?: number;
  maxAgeMs?: number;
  retryMs?: number;
  queueCapacity?: number;
  now?: () => number;
  schedule?: (callback: () => void) => void;
  fileSystem?: Partial<StartupDiagnosticsFileSystem>;
}

/**
 * `~/.imcodes/` on macOS/Linux (matching the full daemon's own state
 * directory), `%ProgramData%\imcodes-node\` on Windows (a controlled node
 * runs as SYSTEM with no meaningful per-user home directory, and this is the
 * exact directory operators already know to check — it already holds
 * `credential.json`, `install-journal.json`, and `last-upgrade-result.json`).
 */
export function startupDiagnosticsDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return platform === 'win32' ? windowsCredentialDir(env) : join(homedir(), '.imcodes');
}

export function startupDiagnosticsLogPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // `startupDiagnosticsDir` is platform-PARAMETER-driven (a Linux CI runner
  // can still compute the Windows path for tests/tooling), so joining must
  // use the matching path flavor rather than the host OS's `join`, which
  // would silently mix `\`-separated Windows dirs with `/`-separated joins.
  const pathModule = platform === 'win32' ? win32 : posix;
  return pathModule.join(startupDiagnosticsDir(platform, env), STARTUP_DIAGNOSTICS_LOG_FILE);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Bounded, best-effort JSONL diagnostics. `record()` only validates,
 * redacts, and enqueues; all filesystem work runs later on a single
 * asynchronous drain and is never awaited by the connect/auth path it is
 * observing. A filesystem failure drops the pending batch and opens a retry
 * circuit — this module must never itself become a reason startup is slow or
 * crashes, and it never recursively logs its own failures.
 */
export class StartupDiagnosticsLog {
  private readonly logPath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly maxAgeMs: number;
  private readonly retryMs: number;
  private readonly queueCapacity: number;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void) => void;
  private readonly fileSystem: StartupDiagnosticsFileSystem;
  private readonly queue: QueuedRecord[] = [];
  private retryAt = 0;
  private scheduled = false;
  private flushing = false;
  private directoryReady = false;
  private currentBytes: number | null = null;
  private currentMtimeMs: number | null = null;
  private dropped = 0;

  private healthLeasePublished = false;
  private lastStep: StartupDiagnosticStep = 'none';
  private healthLeaseTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: StartupDiagnosticsOptions = {}) {
    this.logPath = options.logPath ?? startupDiagnosticsLogPath();
    this.maxBytes = Math.max(1024, options.maxBytes ?? STARTUP_DIAGNOSTICS_MAX_BYTES);
    this.maxFiles = Math.max(1, options.maxFiles ?? STARTUP_DIAGNOSTICS_MAX_FILES);
    this.maxAgeMs = Math.max(0, options.maxAgeMs ?? STARTUP_DIAGNOSTICS_MAX_AGE_MS);
    this.retryMs = Math.max(1, options.retryMs ?? STARTUP_DIAGNOSTICS_RETRY_MS);
    this.queueCapacity = Math.max(1, options.queueCapacity ?? STARTUP_DIAGNOSTICS_QUEUE_CAPACITY);
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

  /** Record one structured event. Redacted before it is ever queued. */
  record(type: StartupDiagnosticEventType, fields: StartupDiagnosticFields = {}): void {
    const now = this.now();
    if (type !== STARTUP_DIAGNOSTIC_EVENT.HEALTH_LEASE_TIMEOUT) {
      this.lastStep = type as StartupDiagnosticStep;
    }
    if (type === STARTUP_DIAGNOSTIC_EVENT.HEALTH_LEASE_PUBLISHED) {
      this.healthLeasePublished = true;
      this.clearHealthLeaseTimeout();
    }
    const safeFields = redactObject(fields as Redactable);
    const record: StartupDiagnosticRecord = {
      version: 1,
      timestamp: new Date(now).toISOString(),
      type,
      ...safeFields,
    };
    this.enqueue(record);
  }

  /**
   * Arm the 120s "no authenticated health lease yet" watchdog. Safe to call
   * repeatedly (e.g. once per connect attempt) — always clears any previous
   * timer first and no-ops once the lease has already been published.
   */
  armHealthLeaseTimeout(timeoutMs: number = STARTUP_DIAGNOSTICS_HEALTH_LEASE_TIMEOUT_MS): void {
    this.clearHealthLeaseTimeout();
    if (this.healthLeasePublished) return;
    const timer = setTimeout(() => {
      this.healthLeaseTimeoutTimer = null;
      if (this.healthLeasePublished) return;
      this.record(STARTUP_DIAGNOSTIC_EVENT.HEALTH_LEASE_TIMEOUT, {
        lastStep: this.lastStep,
        timeoutMs,
      });
    }, timeoutMs);
    timer.unref?.();
    this.healthLeaseTimeoutTimer = timer;
  }

  clearHealthLeaseTimeout(): void {
    if (this.healthLeaseTimeoutTimer) {
      clearTimeout(this.healthLeaseTimeoutTimer);
      this.healthLeaseTimeoutTimer = null;
    }
  }

  queueDepthForTests(): number {
    return this.queue.length;
  }

  droppedForTests(): number {
    return this.dropped;
  }

  /** Test/shutdown observation seam; production signaling never calls this. */
  async drain(): Promise<void> {
    while (this.scheduled || this.flushing) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private enqueue(record: StartupDiagnosticRecord): void {
    const now = this.now();
    if (now < this.retryAt) {
      this.dropped++;
      return;
    }
    if (this.queue.length >= this.queueCapacity) {
      this.dropped++;
      return;
    }
    this.queue.push({ record });
    this.scheduleDrain();
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
        await this.prepareFile(bytes, now);
        await this.fileSystem.appendFile(this.logPath, line, { encoding: 'utf8', flag: 'a' });
        this.currentBytes = (this.currentBytes ?? 0) + bytes;
        this.currentMtimeMs = now;
        this.retryAt = 0;
      }
    } catch {
      this.retryAt = this.now() + this.retryMs;
      // +1: the record already `shift()`-ed out of `queue` for the attempt
      // that just failed is not counted by `queue.length` any more, but it
      // is genuinely dropped too.
      this.dropped += this.queue.length + 1;
      this.queue.length = 0;
      this.directoryReady = false;
      this.currentBytes = null;
      this.currentMtimeMs = null;
    } finally {
      this.flushing = false;
      if (this.queue.length > 0 && this.now() >= this.retryAt) this.scheduleDrain();
    }
  }

  private async prepareFile(nextBytes: number, now: number): Promise<void> {
    if (!this.directoryReady) {
      await this.fileSystem.mkdir(dirname(this.logPath), { recursive: true });
      this.directoryReady = true;
    }
    if (this.currentBytes === null || this.currentMtimeMs === null) {
      try {
        const info = await this.fileSystem.stat(this.logPath);
        this.currentBytes = info.size;
        this.currentMtimeMs = info.mtimeMs;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        this.currentBytes = 0;
        this.currentMtimeMs = now;
      }
    }
    const tooBig = this.currentBytes + nextBytes > this.maxBytes;
    const tooOld = this.maxAgeMs > 0 && now - this.currentMtimeMs >= this.maxAgeMs;
    if (!tooBig && !tooOld) return;
    await this.rotate();
    this.currentBytes = 0;
    this.currentMtimeMs = now;
  }

  private async rotate(): Promise<void> {
    if (this.maxFiles === 1) {
      await this.fileSystem.rm(this.logPath, { force: true });
      return;
    }
    await this.fileSystem.rm(`${this.logPath}.${this.maxFiles - 1}`, { force: true });
    for (let index = this.maxFiles - 2; index >= 1; index--) {
      try {
        await this.fileSystem.rename(`${this.logPath}.${index}`, `${this.logPath}.${index + 1}`);
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

let defaultLog: StartupDiagnosticsLog | undefined;

/** Process-wide singleton; every caller in one process shares one queue/file. */
export function getStartupDiagnosticsLog(): StartupDiagnosticsLog {
  defaultLog ??= new StartupDiagnosticsLog();
  return defaultLog;
}

export function __setStartupDiagnosticsLogForTests(log: StartupDiagnosticsLog | undefined): void {
  defaultLog = log;
}
