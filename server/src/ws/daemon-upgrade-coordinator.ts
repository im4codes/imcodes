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

type UpgradeLifecycleState =
  | 'pending_offline'
  | 'pending_publication'
  | 'scheduled'
  | 'sent'
  | 'terminal_blocked'
  | 'superseded';

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
    let current = this.current?.targetVersion === targetVersion ? this.current : null;
    if (this.current && this.current.targetVersion !== targetVersion) {
      const terminalTargetChanged = this.current.status === 'terminal_blocked';
      this.supersedeCurrent(now);
      if (terminalTargetChanged) this.lastAutoSentAt = null;
    }

    if (current?.status === 'terminal_blocked') {
      if (input.source !== 'manual') {
        return {
          ok: true,
          upgradeId: current.upgradeId,
          targetVersion,
          deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.BACKOFF,
          reason: 'terminal_install_failure',
        };
      }
      this.supersedeCurrent(now);
      current = null;
    }

    // A user-issued manual request is authoritative over reconnect-driven
    // auto/replay traffic for the same target. In particular, an offline
    // manual request remains pending while auth is incomplete; the auth
    // version-mismatch probe must not silently demote it back to `auto`.
    const effectiveInput = current?.source === 'manual' && input.source !== 'manual'
      ? { ...input, source: 'manual' as const }
      : input;

    if (current?.status === 'pending_publication') {
      current.source = effectiveInput.source;
      current.updatedAt = now;
      if (!effectiveInput.isDaemonReady()) {
        current.status = 'pending_offline';
        return {
          ok: true,
          upgradeId: current.upgradeId,
          targetVersion,
          deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.PENDING_OFFLINE,
        };
      }
      const publication = this.ensureTargetPublished(current, effectiveInput, now);
      if (publication) return publication;
    } else if (
      current
      && current.status !== 'superseded'
      && (current.status !== 'pending_offline' || !effectiveInput.isDaemonReady())
    ) {
      if (effectiveInput.source === 'auto') {
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
      source: effectiveInput.source,
      status: 'pending_offline' as UpgradeLifecycleState,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      lastSentAt: null,
      timer: null,
      publicationResumeInput: null,
      publicationCallbackRegistered: false,
    };
    state.source = effectiveInput.source;
    state.updatedAt = now;
    this.current = state;

    if (!effectiveInput.isDaemonReady()) {
      state.status = 'pending_offline';
      return {
        ok: true,
        upgradeId: state.upgradeId,
        targetVersion,
        deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.PENDING_OFFLINE,
      };
    }

    if (effectiveInput.source === 'auto') {
      const publication = this.ensureTargetPublished(state, effectiveInput, now);
      if (publication) return publication;
      return this.scheduleAutoSend(state, effectiveInput, now);
    }

    const publication = this.ensureTargetPublished(state, effectiveInput, now);
    if (publication) return publication;
    this.sendNow(state, effectiveInput, now);
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

  /**
   * A legacy controlled node acknowledged an earlier upgrade but its detached
   * task failed before replacing the process, leaving a process-local latch set.
   * The Server is about to restart that exact node generation; keep the same
   * lifecycle pending and let the replacement generation retry immediately.
   */
  prepareRetryAfterDaemonRestart(now = Date.now()): boolean {
    const state = this.current;
    if (!state || state.status !== 'sent') return false;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.status = 'pending_offline';
    state.attempt = 0;
    state.updatedAt = now;
    state.publicationResumeInput = null;
    state.publicationCallbackRegistered = false;
    if (state.source === 'auto') this.lastAutoSentAt = null;
    return true;
  }

  /**
   * Cancel any pending send and keep the failed target terminally blocked.
   * Auto/replay requests for the same target remain blocked; an explicit manual
   * request or a different target version creates a fresh lifecycle.
   */
  blockTargetAfterTerminalFailure(targetVersion: unknown, now = Date.now()): boolean {
    let normalized: string;
    try {
      normalized = normalizeDaemonUpgradeTargetVersion(targetVersion);
    } catch {
      return false;
    }

    if (this.current && this.current.targetVersion !== normalized) {
      this.supersedeCurrent(now);
    }
    const state = this.current ?? {
      upgradeId: randomUUID(),
      targetVersion: normalized,
      source: 'auto' as DaemonUpgradeSource,
      status: 'terminal_blocked' as UpgradeLifecycleState,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      lastSentAt: null,
      timer: null,
      publicationResumeInput: null,
      publicationCallbackRegistered: false,
    };
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.status = 'terminal_blocked';
    state.updatedAt = now;
    state.publicationResumeInput = null;
    state.publicationCallbackRegistered = false;
    this.current = state;
    return true;
  }

  /**
   * A terminal failure belongs to the upgrade command that produced it.
   * If a newer manual lifecycle for the same target has a different id, the
   * old persisted failure was explicitly superseded and must not re-block it.
   */
  isTerminalFailureSupersededByManual(targetVersion: unknown, failureUpgradeId: unknown): boolean {
    let normalized: string;
    try {
      normalized = normalizeDaemonUpgradeTargetVersion(targetVersion);
    } catch {
      return false;
    }
    return Boolean(
      typeof failureUpgradeId === 'string'
      && failureUpgradeId.length > 0
      && this.current?.targetVersion === normalized
      && this.current.source === 'manual'
      && this.current.status !== 'terminal_blocked'
      && this.current.upgradeId !== failureUpgradeId,
    );
  }

  hasManualLifecycleForTarget(targetVersion: unknown): boolean {
    let normalized: string;
    try {
      normalized = normalizeDaemonUpgradeTargetVersion(targetVersion);
    } catch {
      return false;
    }
    return Boolean(
      this.current?.targetVersion === normalized
      && this.current.source === 'manual'
      && this.current.status !== 'terminal_blocked',
    );
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
