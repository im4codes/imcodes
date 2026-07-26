/**
 * Crash-safe single-record outbox for detached daemon-upgrade failures.
 *
 * The detached npm process can finish while ServerLink is disconnected.
 * A plain `serverLink.send()` drops that control-plane message forever, so
 * persist the latest terminal install failure before attempting delivery and
 * replay it after the next authenticated WebSocket connection.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import {
  DAEMON_UPGRADE_BLOCKED_ACK_DISPOSITION,
  DAEMON_UPGRADE_BLOCK_REASON,
  type DaemonUpgradeBlockedAckDisposition,
} from '../../shared/daemon-upgrade.js';
import logger from '../util/logger.js';

const UPGRADE_BLOCKED_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_FILE = join(homedir(), '.imcodes', 'pending-upgrade-blocked.json');

export interface UpgradeInstallFailedMessage {
  type: typeof DAEMON_MSG.UPGRADE_BLOCKED;
  reason: typeof DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED;
  failureId: string;
  upgradeId?: string;
  fromVersion: string;
  targetVersion: string;
  retryReason: string;
  attempts?: number;
  exitCode: number;
  log: string;
  signal?: string;
  ts: number;
  acknowledgedAt?: number;
}

export type UpgradeBlockedSender = (message: UpgradeInstallFailedMessage) => boolean;

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

export function parseUpgradeInstallFailedMessage(raw: string): UpgradeInstallFailedMessage | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.type !== DAEMON_MSG.UPGRADE_BLOCKED) return null;
    if (value.reason !== DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED) return null;
    const failureId = boundedString(value.failureId, 128);
    const upgradeId = value.upgradeId === undefined ? null : boundedString(value.upgradeId, 128);
    const fromVersion = boundedString(value.fromVersion, 128);
    const targetVersion = boundedString(value.targetVersion, 128);
    const retryReason = boundedString(value.retryReason, 64);
    const log = boundedString(value.log, 4096);
    if (!failureId || (value.upgradeId !== undefined && !upgradeId) || !fromVersion || !targetVersion || !retryReason || !log) return null;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(retryReason)) return null;
    if (!Number.isInteger(value.exitCode) || (value.exitCode as number) < 1 || (value.exitCode as number) > 255) return null;
    if (!Number.isInteger(value.ts) || (value.ts as number) < 1) return null;
    if (value.attempts !== undefined && (!Number.isInteger(value.attempts) || (value.attempts as number) < 1 || (value.attempts as number) > 100)) return null;
    if (value.signal !== undefined && typeof value.signal !== 'string') return null;
    if (value.acknowledgedAt !== undefined && (!Number.isInteger(value.acknowledgedAt) || (value.acknowledgedAt as number) < 1)) return null;
    return {
      type: DAEMON_MSG.UPGRADE_BLOCKED,
      reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED,
      failureId,
      ...(upgradeId ? { upgradeId } : {}),
      fromVersion,
      targetVersion,
      retryReason,
      ...(value.attempts === undefined ? {} : { attempts: value.attempts as number }),
      exitCode: value.exitCode as number,
      log,
      ...(typeof value.signal === 'string' ? { signal: value.signal } : {}),
      ts: value.ts as number,
      ...(value.acknowledgedAt === undefined ? {} : { acknowledgedAt: value.acknowledgedAt as number }),
    };
  } catch {
    return null;
  }
}

export class UpgradeBlockedOutbox {
  private operation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath = DEFAULT_FILE,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Persist before send. A false/throwing sender leaves the record on disk for
   * reconnect replay. A successful WebSocket enqueue does not remove the
   * terminal blocker: it must survive server restarts until this daemon moves
   * off fromVersion or the server explicitly declares the target obsolete.
   */
  report(message: UpgradeInstallFailedMessage, send: UpgradeBlockedSender): Promise<boolean> {
    return this.serialize(async () => {
      await this.persist(message);
      return this.tryDeliver(message, send);
    });
  }

  /** Replay one still-relevant terminal failure after authenticated reconnect. */
  flushOnReconnect(send: UpgradeBlockedSender, currentDaemonVersion: string): Promise<boolean> {
    return this.serialize(async () => {
      const message = await this.load();
      if (!message) return false;
      if (
        message.fromVersion !== currentDaemonVersion
        || this.now() - message.ts > UPGRADE_BLOCKED_OUTBOX_TTL_MS
      ) {
        await this.clear();
        return false;
      }
      return this.tryDeliver(message, send);
    });
  }

  /**
   * Record that the server applied the blocker. Keep accepted blockers on disk
   * so a later server restart can rebuild its in-memory terminal target gate.
   * A changed server target makes the old failure obsolete and safe to clear.
   */
  acknowledge(failureId: string, disposition: DaemonUpgradeBlockedAckDisposition): Promise<boolean> {
    return this.serialize(async () => {
      const message = await this.load();
      if (!message || message.failureId !== failureId) return false;
      if (
        disposition === DAEMON_UPGRADE_BLOCKED_ACK_DISPOSITION.OBSOLETE
        || disposition === DAEMON_UPGRADE_BLOCKED_ACK_DISPOSITION.SUPERSEDED
      ) {
        await this.clear();
        return true;
      }
      if (message.acknowledgedAt === undefined) {
        await this.persist({ ...message, acknowledgedAt: this.now() });
      }
      return true;
    });
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.operation.then(task, task);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(message: UpgradeInstallFailedMessage): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(message)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.filePath);
  }

  private async load(): Promise<UpgradeInstallFailedMessage | null> {
    try {
      const message = parseUpgradeInstallFailedMessage(await readFile(this.filePath, 'utf8'));
      if (message) return message;
      logger.warn({ file: this.filePath }, 'UpgradeBlockedOutbox: discarding invalid record');
      await this.clear();
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async tryDeliver(message: UpgradeInstallFailedMessage, send: UpgradeBlockedSender): Promise<boolean> {
    try {
      return send(message);
    } catch (err) {
      logger.warn({ err, failureId: message.failureId }, 'UpgradeBlockedOutbox: send failed; retaining for reconnect');
      return false;
    }
  }

  private async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

let defaultOutbox: UpgradeBlockedOutbox | null = null;

export function getDefaultUpgradeBlockedOutbox(): UpgradeBlockedOutbox {
  if (!defaultOutbox) defaultOutbox = new UpgradeBlockedOutbox();
  return defaultOutbox;
}

export function __resetDefaultUpgradeBlockedOutboxForTests(): void {
  defaultOutbox = null;
}
