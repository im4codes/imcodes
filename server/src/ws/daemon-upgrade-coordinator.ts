import { randomUUID } from 'node:crypto';
import { DAEMON_COMMAND_TYPES } from '../../../shared/daemon-command-types.js';
import {
  DAEMON_UPGRADE_DELIVERY_STATUS,
  normalizeDaemonUpgradeTargetVersion,
  shouldSendDaemonUpgradeTargetVersion,
  type DaemonUpgradeDeliveryStatus,
} from '../../../shared/daemon-upgrade.js';

const AUTO_UPGRADE_SEND_DELAY_MS = 5_000;
const AUTO_UPGRADE_MIN_INTERVAL_MS = 15 * 60 * 1000;
const AUTO_UPGRADE_MAX_ATTEMPTS = 3;

export type DaemonUpgradeSource = 'auto' | 'manual' | 'replay';

type UpgradeLifecycleState = 'pending_offline' | 'scheduled' | 'sent' | 'superseded';

interface UpgradeState {
  upgradeId: string;
  targetVersion: string;
  source: DaemonUpgradeSource;
  status: UpgradeLifecycleState;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  lastSentAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface RequestDaemonUpgradeInput {
  targetVersion?: unknown;
  source: DaemonUpgradeSource;
  isDaemonReady: () => boolean;
  isStillCurrent?: () => boolean;
  send: (message: Record<string, unknown>) => void;
  now?: number;
}

export interface RequestDaemonUpgradeResult {
  ok: boolean;
  upgradeId?: string;
  targetVersion?: string;
  deliveryStatus: DaemonUpgradeDeliveryStatus;
  nextAttemptAt?: string;
  reason?: string;
}

export class DaemonUpgradeCoordinator {
  private current: UpgradeState | null = null;
  private lastAutoSentAt: number | null = null;

  request(input: RequestDaemonUpgradeInput): RequestDaemonUpgradeResult {
    let targetVersion: string;
    try {
      targetVersion = normalizeDaemonUpgradeTargetVersion(input.targetVersion);
    } catch {
      return {
        ok: false,
        deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.INVALID_TARGET,
        reason: 'invalid_target_version',
      };
    }

    const now = input.now ?? Date.now();
    const current = this.current?.targetVersion === targetVersion ? this.current : null;
    if (this.current && this.current.targetVersion !== targetVersion) {
      this.supersedeCurrent(now);
    }

    if (current && current.status !== 'superseded' && (current.status !== 'pending_offline' || !input.isDaemonReady())) {
      if (input.source === 'auto') {
        const nextAutoAt = this.nextAutoAttemptAt(now);
        if (nextAutoAt > now) {
          return {
            ok: true,
            upgradeId: current.upgradeId,
            targetVersion,
            deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.SUPPRESSED,
            nextAttemptAt: new Date(nextAutoAt).toISOString(),
          };
        }
        if (current.attempt >= AUTO_UPGRADE_MAX_ATTEMPTS) {
          return {
            ok: true,
            upgradeId: current.upgradeId,
            targetVersion,
            deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.BACKOFF,
            reason: 'max_attempts_reached',
          };
        }
      } else {
        return {
          ok: true,
          upgradeId: current.upgradeId,
          targetVersion,
          deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.ALREADY_IN_PROGRESS,
        };
      }
    }

    const state = current ?? {
      upgradeId: randomUUID(),
      targetVersion,
      source: input.source,
      status: 'pending_offline' as UpgradeLifecycleState,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      lastSentAt: null,
      timer: null,
    };
    state.source = input.source;
    state.updatedAt = now;
    this.current = state;

    if (!input.isDaemonReady()) {
      state.status = 'pending_offline';
      return {
        ok: true,
        upgradeId: state.upgradeId,
        targetVersion,
        deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.PENDING_OFFLINE,
      };
    }

    if (input.source === 'auto') {
      return this.scheduleAutoSend(state, input, now);
    }

    this.sendNow(state, input, now);
    return {
      ok: true,
      upgradeId: state.upgradeId,
      targetVersion,
      deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.SENT,
    };
  }

  flushPending(input: Omit<RequestDaemonUpgradeInput, 'targetVersion' | 'source'>): RequestDaemonUpgradeResult | null {
    const state = this.current;
    if (!state || state.status !== 'pending_offline') return null;
    if (!input.isDaemonReady()) {
      return {
        ok: true,
        upgradeId: state.upgradeId,
        targetVersion: state.targetVersion,
        deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.PENDING_OFFLINE,
      };
    }
    if (state.source === 'auto') {
      return this.scheduleAutoSend(state, { ...input, targetVersion: state.targetVersion, source: state.source }, Date.now());
    }
    this.sendNow(state, { ...input, targetVersion: state.targetVersion, source: state.source }, Date.now());
    return {
      ok: true,
      upgradeId: state.upgradeId,
      targetVersion: state.targetVersion,
      deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.SENT,
    };
  }

  clearIfTargetVersionMatches(targetVersion: string | null | undefined): void {
    let normalized: string | null = null;
    try {
      normalized = targetVersion ? normalizeDaemonUpgradeTargetVersion(targetVersion) : null;
    } catch {
      return;
    }
    if (normalized && this.current?.targetVersion === normalized) {
      this.clearCurrent();
    }
  }

  parseQueuedUpgrade(raw: string): string | null {
    try {
      const parsed = JSON.parse(raw) as { type?: unknown; targetVersion?: unknown };
      if (parsed.type !== DAEMON_COMMAND_TYPES.DAEMON_UPGRADE) return null;
      return normalizeDaemonUpgradeTargetVersion(parsed.targetVersion);
    } catch {
      return null;
    }
  }

  private scheduleAutoSend(state: UpgradeState, input: RequestDaemonUpgradeInput, now: number): RequestDaemonUpgradeResult {
    const nextAutoAt = this.nextAutoAttemptAt(now);
    if (nextAutoAt > now) {
      return {
        ok: true,
        upgradeId: state.upgradeId,
        targetVersion: state.targetVersion,
        deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.SUPPRESSED,
        nextAttemptAt: new Date(nextAutoAt).toISOString(),
      };
    }
    if (state.attempt >= AUTO_UPGRADE_MAX_ATTEMPTS) {
      return {
        ok: true,
        upgradeId: state.upgradeId,
        targetVersion: state.targetVersion,
        deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.BACKOFF,
        reason: 'max_attempts_reached',
      };
    }
    if (state.timer) clearTimeout(state.timer);
    state.status = 'scheduled';
    state.attempt += 1;
    state.updatedAt = now;
    this.lastAutoSentAt = now;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (this.current !== state || !input.isDaemonReady() || input.isStillCurrent?.() === false) return;
      this.sendNow(state, input, Date.now());
    }, AUTO_UPGRADE_SEND_DELAY_MS);
    return {
      ok: true,
      upgradeId: state.upgradeId,
      targetVersion: state.targetVersion,
      deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.SENT,
    };
  }

  private sendNow(state: UpgradeState, input: RequestDaemonUpgradeInput, now: number): void {
    state.status = 'sent';
    state.lastSentAt = now;
    state.updatedAt = now;
    input.send(this.buildUpgradeMessage(state));
  }

  private buildUpgradeMessage(state: UpgradeState): Record<string, unknown> {
    return {
      type: DAEMON_COMMAND_TYPES.DAEMON_UPGRADE,
      upgradeId: state.upgradeId,
      ...(shouldSendDaemonUpgradeTargetVersion(state.targetVersion) ? { targetVersion: state.targetVersion } : {}),
    };
  }

  private nextAutoAttemptAt(now: number): number {
    return this.lastAutoSentAt == null ? now : this.lastAutoSentAt + AUTO_UPGRADE_MIN_INTERVAL_MS;
  }

  private supersedeCurrent(now: number): void {
    if (!this.current) return;
    if (this.current.timer) clearTimeout(this.current.timer);
    this.current.status = 'superseded';
    this.current.updatedAt = now;
    this.current = null;
  }

  private clearCurrent(): void {
    if (this.current?.timer) clearTimeout(this.current.timer);
    this.current = null;
    this.lastAutoSentAt = null;
  }
}
