import { randomUUID } from 'node:crypto';
import { DAEMON_COMMAND_TYPES } from '../../../shared/daemon-command-types.js';
import {
  DAEMON_UPGRADE_DELIVERY_STATUS,
  normalizeDaemonUpgradeTargetVersion,
  shouldSendDaemonUpgradeTargetVersion,
  type DaemonUpgradeDeliveryStatus,
} from '../../../shared/daemon-upgrade.js';
import {
  daemonUpgradePublicationGate,
  type DaemonUpgradePublicationGate,
} from './daemon-upgrade-publication-gate.js';

const AUTO_UPGRADE_SEND_DELAY_MS = 5_000;
const AUTO_UPGRADE_MIN_INTERVAL_MS = 15 * 60 * 1000;
const AUTO_UPGRADE_MAX_ATTEMPTS = 3;

export type DaemonUpgradeSource = 'auto' | 'manual' | 'replay';

type UpgradeLifecycleState = 'pending_offline' | 'pending_publication' | 'scheduled' | 'sent' | 'superseded';

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
  publicationResumeInput: RequestDaemonUpgradeInput | null;
  publicationCallbackRegistered: boolean;
}

export interface RequestDaemonUpgradeInput {
  targetVersion?: unknown;
  source: DaemonUpgradeSource;
  /** Controlled nodes consume image-embedded native artifacts, not npm. */
  skipPublicationGate?: boolean;
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

export interface RetryAutoDaemonUpgradeAfterBlockedInput extends Omit<RequestDaemonUpgradeInput, 'targetVersion' | 'source'> {
  retryDelayMs: number;
}

export class DaemonUpgradeCoordinator {
  private current: UpgradeState | null = null;
  private lastAutoSentAt: number | null = null;

  constructor(private readonly publicationGate: DaemonUpgradePublicationGate = daemonUpgradePublicationGate) {}

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

    if (current?.status === 'pending_publication') {
      current.source = input.source;
      current.updatedAt = now;
      if (!input.isDaemonReady()) {
        current.status = 'pending_offline';
        return {
          ok: true,
          upgradeId: current.upgradeId,
          targetVersion,
          deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.PENDING_OFFLINE,
        };
      }
      const publication = this.ensureTargetPublished(current, input, now);
      if (publication) return publication;
    } else if (current && current.status !== 'superseded' && (current.status !== 'pending_offline' || !input.isDaemonReady())) {
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
      publicationResumeInput: null,
      publicationCallbackRegistered: false,
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
      const publication = this.ensureTargetPublished(state, input, now);
      if (publication) return publication;
      return this.scheduleAutoSend(state, input, now);
    }

    const publication = this.ensureTargetPublished(state, input, now);
    if (publication) return publication;
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
    if (!state || (state.status !== 'pending_offline' && state.status !== 'pending_publication')) return null;
    if (!input.isDaemonReady()) {
      return {
        ok: true,
        upgradeId: state.upgradeId,
        targetVersion: state.targetVersion,
        deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.PENDING_OFFLINE,
      };
    }
    const requestInput = { ...input, targetVersion: state.targetVersion, source: state.source };
    const now = Date.now();
    const publication = this.ensureTargetPublished(state, requestInput, now);
    if (publication) return publication;
    if (state.source === 'auto') {
      return this.scheduleAutoSend(state, requestInput, now);
    }
    this.sendNow(state, requestInput, now);
    return {
      ok: true,
      upgradeId: state.upgradeId,
      targetVersion: state.targetVersion,
      deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.SENT,
    };
  }

  retryAutoAfterBlocked(input: RetryAutoDaemonUpgradeAfterBlockedInput): RequestDaemonUpgradeResult | null {
    const state = this.current;
    if (!state || state.source !== 'auto' || state.status !== 'sent') return null;

    const retryDelayMs = Math.max(0, Math.floor(input.retryDelayMs));
    const now = input.now ?? Date.now();
    if (state.timer) clearTimeout(state.timer);
    state.status = 'scheduled';
    state.updatedAt = now;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (this.current !== state || !input.isDaemonReady() || input.isStillCurrent?.() === false) return;
      this.sendNow(state, { ...input, targetVersion: state.targetVersion, source: 'auto' }, Date.now());
    }, retryDelayMs);

    return {
      ok: true,
      upgradeId: state.upgradeId,
      targetVersion: state.targetVersion,
      deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.SENT,
      nextAttemptAt: new Date(now + retryDelayMs).toISOString(),
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

  private ensureTargetPublished(
    state: UpgradeState,
    input: RequestDaemonUpgradeInput,
    now: number,
  ): RequestDaemonUpgradeResult | null {
    if (input.skipPublicationGate) {
      state.publicationResumeInput = null;
      state.publicationCallbackRegistered = false;
      return null;
    }
    state.publicationResumeInput = input;
    const publication = this.publicationGate.ensurePublished(
      state.targetVersion,
      state.publicationCallbackRegistered
        ? undefined
        : () => {
          state.publicationCallbackRegistered = false;
          const resumeInput = state.publicationResumeInput;
          state.publicationResumeInput = null;
          if (resumeInput) this.resumeAfterPublication(state, resumeInput);
        },
    );
    if (publication.status === 'available') {
      state.publicationResumeInput = null;
      state.publicationCallbackRegistered = false;
      return null;
    }
    state.publicationCallbackRegistered = true;
    state.status = 'pending_publication';
    state.updatedAt = now;
    return {
      ok: true,
      upgradeId: state.upgradeId,
      targetVersion: state.targetVersion,
      deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.PENDING_PUBLICATION,
      ...(publication.nextProbeAt ? { nextAttemptAt: publication.nextProbeAt } : {}),
      ...(publication.reason ? { reason: publication.reason } : {}),
    };
  }

  private resumeAfterPublication(state: UpgradeState, input: RequestDaemonUpgradeInput): void {
    if (this.current !== state || state.status !== 'pending_publication') return;
    if (!input.isDaemonReady() || input.isStillCurrent?.() === false) return;
    const now = Date.now();
    if (state.source === 'auto') {
      this.scheduleAutoSend(state, input, now);
      return;
    }
    this.sendNow(state, input, now);
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
