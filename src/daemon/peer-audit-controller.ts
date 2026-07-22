import {
  PEER_AUDIT_DEADLINE_MS,
  PEER_AUDIT_PREFLIGHT_ERRORS,
  PEER_AUDIT_TERMINAL_OUTCOMES,
  PEER_AUDIT_TOMBSTONE_CAPACITY,
  PEER_AUDIT_TOMBSTONE_TTL_MS,
  type PeerAuditDispatchReceipt,
  type PeerAuditPhase,
  type PeerAuditRuntimeDisposition,
  type PeerAuditSelectionIntent,
  type PeerAuditTerminalOutcome,
  type PeerAuditTrigger,
  type PeerAuditVerdict,
} from '../../shared/peer-audit.js';

export interface PendingPeerAudit {
  attemptId: string;
  revision: number;
  trigger: PeerAuditTrigger;
  phase: PeerAuditPhase;
  baselineId: string;
  candidateRevision: string;
  targetConfigRevision: string;
  auditedSessionName: string;
  auditedSessionInstanceId: string;
  auditedRuntimeEpoch: string;
  auditorSessionName: string;
  auditorSessionInstanceId: string;
  auditorRuntimeEpoch: string;
  selectionIntent: PeerAuditSelectionIntent;
  startedAt: number;
  deadlineAt: number;
  capabilityHash: string;
  dispatchId?: string;
  messageId?: string;
  queueEpoch?: string;
  disposition?: PeerAuditRuntimeDisposition;
}

export type PeerAuditStartInput = Omit<PendingPeerAudit,
  'revision' | 'phase' | 'startedAt' | 'deadlineAt' | 'dispatchId' | 'messageId' | 'queueEpoch' | 'disposition'>;

export interface AutomaticPeerAuditWaiter {
  waiterId: string;
  generationOrEpoch: number;
  baselineId: string;
  configRevision: string;
  targetRevision: string;
  request: PeerAuditStartInput;
}

export interface PeerAuditTerminalRecord {
  attemptId: string;
  revision: number;
  trigger: PeerAuditTrigger;
  outcome: PeerAuditTerminalOutcome;
  reason?: string;
  verdict?: PeerAuditVerdict;
  findings?: string;
  completedAt: number;
  elapsedMs: number;
  disposition?: PeerAuditRuntimeDisposition;
}

export interface PeerAuditTombstone {
  attemptId: string;
  terminal: PeerAuditTerminalRecord;
  expiresAt: number;
}

export type PeerAuditControllerEffect =
  | { type: 'dispatch'; attemptId: string; effectRevision: number }
  | { type: 'remove_queued_message'; attemptId: string; effectRevision: number; messageId: string; queueEpoch?: string }
  | { type: 'emit_terminal'; attemptId: string; effectRevision: number; terminal: PeerAuditTerminalRecord }
  | { type: 'automatic_slot_available'; attemptId: string; effectRevision: number; waiter: AutomaticPeerAuditWaiter }
  | {
    type: 'automatic_waiter_invalidated';
    attemptId: string;
    effectRevision: number;
    waiter: AutomaticPeerAuditWaiter;
    reason: string;
  };

export type AutomaticPeerAuditWaiterRegistrationResult =
  | { status: 'registered'; waiter: AutomaticPeerAuditWaiter }
  | { status: 'duplicate'; waiter: AutomaticPeerAuditWaiter }
  | { status: 'busy'; waiter?: AutomaticPeerAuditWaiter };

export type PeerAuditRequestResult =
  | { status: 'started'; pending: PendingPeerAudit; effects: PeerAuditControllerEffect[] }
  | { status: 'busy'; error: typeof PEER_AUDIT_PREFLIGHT_ERRORS.PEER_AUDIT_BUSY; pending: PendingPeerAudit; effects: [] }
  | {
    status: 'awaiting_slot';
    registration: 'registered';
    error: typeof PEER_AUDIT_PREFLIGHT_ERRORS.AWAITING_PEER_AUDIT_SLOT;
    pending: PendingPeerAudit;
    waiter: AutomaticPeerAuditWaiter;
    effects: [];
  }
  | { status: 'duplicate'; kind: 'attempt_tombstone'; tombstone: PeerAuditTombstone; effects: [] }
  | {
    status: 'duplicate';
    kind: 'automatic_waiter';
    pending: PendingPeerAudit;
    waiter: AutomaticPeerAuditWaiter;
    effects: [];
  };

export interface PeerAuditTransitionResult {
  status: 'applied' | 'stale' | 'duplicate' | 'invalid' | 'missing';
  pending?: PendingPeerAudit;
  terminal?: PeerAuditTerminalRecord;
  effects: PeerAuditControllerEffect[];
}

export interface PeerAuditControllerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PeerAuditControllerOptions {
  clock?: PeerAuditControllerClock;
  deadlineMs?: number;
  tombstoneCapacity?: number;
  tombstoneTtlMs?: number;
  onEffects?: (effects: readonly PeerAuditControllerEffect[]) => void;
}

const SYSTEM_CLOCK: PeerAuditControllerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function unrefTimer(handle: unknown): void {
  if (typeof handle === 'object' && handle !== null && 'unref' in handle
    && typeof (handle as { unref?: unknown }).unref === 'function') {
    (handle as { unref(): void }).unref();
  }
}

function cloneAutomaticWaiter(waiter: AutomaticPeerAuditWaiter): AutomaticPeerAuditWaiter {
  return { ...waiter, request: { ...waiter.request } };
}

/** Serialized state machine for exactly one audited session. */
export class PeerAuditController {
  readonly #auditedSessionName: string;
  readonly #clock: PeerAuditControllerClock;
  readonly #deadlineMs: number;
  readonly #tombstoneCapacity: number;
  readonly #tombstoneTtlMs: number;
  readonly #onEffects?: (effects: readonly PeerAuditControllerEffect[]) => void;
  readonly #tombstones = new Map<string, PeerAuditTombstone>();
  #pending?: PendingPeerAudit;
  #deadlineTimer?: unknown;
  #automaticWaiter?: AutomaticPeerAuditWaiter;

  constructor(auditedSessionName: string, options: PeerAuditControllerOptions = {}) {
    this.#auditedSessionName = auditedSessionName;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#deadlineMs = options.deadlineMs ?? PEER_AUDIT_DEADLINE_MS;
    this.#tombstoneCapacity = options.tombstoneCapacity ?? PEER_AUDIT_TOMBSTONE_CAPACITY;
    this.#tombstoneTtlMs = options.tombstoneTtlMs ?? PEER_AUDIT_TOMBSTONE_TTL_MS;
    this.#onEffects = options.onEffects;
  }

  get pending(): PendingPeerAudit | undefined {
    return this.#pending ? { ...this.#pending } : undefined;
  }

  get automaticWaiter(): AutomaticPeerAuditWaiter | undefined {
    return this.#automaticWaiter ? cloneAutomaticWaiter(this.#automaticWaiter) : undefined;
  }

  request(input: PeerAuditStartInput, waiter?: Omit<AutomaticPeerAuditWaiter, 'request'>): PeerAuditRequestResult {
    if (input.auditedSessionName !== this.#auditedSessionName) {
      throw new Error(`peer-audit controller ${this.#auditedSessionName} cannot own ${input.auditedSessionName}`);
    }
    this.#pruneTombstones(this.#clock.now());
    const prior = this.#tombstones.get(input.attemptId);
    if (prior) return { status: 'duplicate', kind: 'attempt_tombstone', tombstone: prior, effects: [] };
    if (this.#pending) {
      if (input.trigger === 'automatic' && this.#pending.trigger === 'quick' && waiter) {
        const registration = this.registerAutomaticWaiter(input, waiter);
        if (registration.status === 'registered') {
          return {
            status: 'awaiting_slot',
            registration: 'registered',
            error: PEER_AUDIT_PREFLIGHT_ERRORS.AWAITING_PEER_AUDIT_SLOT,
            pending: { ...this.#pending },
            waiter: registration.waiter,
            effects: [],
          };
        }
        if (registration.status === 'duplicate') {
          return {
            status: 'duplicate',
            kind: 'automatic_waiter',
            pending: { ...this.#pending },
            waiter: registration.waiter,
            effects: [],
          };
        }
      }
      return {
        status: 'busy',
        error: PEER_AUDIT_PREFLIGHT_ERRORS.PEER_AUDIT_BUSY,
        pending: { ...this.#pending },
        effects: [],
      };
    }

    const startedAt = this.#clock.now();
    const pending: PendingPeerAudit = {
      ...input,
      revision: 1,
      phase: 'preparing',
      startedAt,
      deadlineAt: startedAt + this.#deadlineMs,
    };
    this.#pending = pending;
    this.#scheduleDeadline(pending);
    const effects: PeerAuditControllerEffect[] = [{
      type: 'dispatch',
      attemptId: pending.attemptId,
      effectRevision: pending.revision,
    }];
    this.#emitEffects(effects);
    return { status: 'started', pending: { ...pending }, effects };
  }

  /** Registers exactly one deferred automatic request behind an active Quick audit. */
  registerAutomaticWaiter(
    input: PeerAuditStartInput,
    waiter: Omit<AutomaticPeerAuditWaiter, 'request'>,
  ): AutomaticPeerAuditWaiterRegistrationResult {
    if (input.auditedSessionName !== this.#auditedSessionName) {
      throw new Error(`peer-audit controller ${this.#auditedSessionName} cannot own ${input.auditedSessionName}`);
    }
    if (!this.#pending || this.#pending.trigger !== 'quick' || input.trigger !== 'automatic') {
      return {
        status: 'busy',
        ...(this.#automaticWaiter ? { waiter: cloneAutomaticWaiter(this.#automaticWaiter) } : {}),
      };
    }
    if (this.#automaticWaiter) {
      return this.#automaticWaiter.waiterId === waiter.waiterId
        ? { status: 'duplicate', waiter: cloneAutomaticWaiter(this.#automaticWaiter) }
        : { status: 'busy', waiter: cloneAutomaticWaiter(this.#automaticWaiter) };
    }
    const registered = { ...waiter, request: { ...input } };
    this.#automaticWaiter = registered;
    return { status: 'registered', waiter: cloneAutomaticWaiter(registered) };
  }

  #scheduleDeadline(pending: PendingPeerAudit): void {
    if (this.#deadlineTimer !== undefined) this.#clock.clearTimeout(this.#deadlineTimer);
    const handle = this.#clock.setTimeout(() => {
      const now = Math.max(this.#clock.now(), pending.deadlineAt);
      this.timeout({ attemptId: pending.attemptId, occurredAt: now });
    }, Math.max(0, pending.deadlineAt - this.#clock.now()));
    this.#deadlineTimer = handle;
    unrefTimer(handle);
  }

  dispatchResolved(input: {
    attemptId: string;
    effectRevision: number;
    receipt: PeerAuditDispatchReceipt;
  }): PeerAuditTransitionResult {
    const checked = this.#checkEffect(input.attemptId, input.effectRevision);
    if (checked) return checked;
    const pending = this.#pending!;
    if (input.receipt.targetSessionInstanceId !== pending.auditorSessionInstanceId
      || input.receipt.targetRuntimeEpoch !== pending.auditorRuntimeEpoch) {
      return this.#finish(PEER_AUDIT_TERMINAL_OUTCOMES.TARGET_UNAVAILABLE, 'target_identity_changed');
    }
    this.#pending = {
      ...pending,
      revision: pending.revision + 1,
      phase: input.receipt.disposition,
      disposition: input.receipt.disposition,
      dispatchId: input.receipt.dispatchId,
      messageId: input.receipt.messageId,
      ...(input.receipt.queueEpoch ? { queueEpoch: input.receipt.queueEpoch } : {}),
    };
    return { status: 'applied', pending: { ...this.#pending }, effects: [] };
  }

  dispatchFailed(input: {
    attemptId: string;
    effectRevision: number;
    reason: string;
    outcome?: Extract<PeerAuditTerminalOutcome, 'target_unavailable' | 'invalid_configuration'>;
  }): PeerAuditTransitionResult {
    const checked = this.#checkEffect(input.attemptId, input.effectRevision);
    if (checked) return checked;
    return this.#finish(input.outcome ?? PEER_AUDIT_TERMINAL_OUTCOMES.TARGET_UNAVAILABLE, input.reason);
  }

  markWaitingReply(input: { attemptId: string; effectRevision: number }): PeerAuditTransitionResult {
    const checked = this.#checkEffect(input.attemptId, input.effectRevision);
    if (checked) return checked;
    const pending = this.#pending!;
    this.#pending = { ...pending, revision: pending.revision + 1, phase: 'waiting_reply' };
    return { status: 'applied', pending: { ...this.#pending }, effects: [] };
  }

  queueDelivered(input: {
    attemptId: string;
    effectRevision: number;
    targetSessionInstanceId: string;
    targetRuntimeEpoch: string;
  }): PeerAuditTransitionResult {
    const checked = this.#checkEffect(input.attemptId, input.effectRevision);
    if (checked) return checked;
    const pending = this.#pending!;
    if (pending.phase !== 'queued') return { status: 'invalid', pending: { ...pending }, effects: [] };
    if (input.targetSessionInstanceId !== pending.auditorSessionInstanceId
      || input.targetRuntimeEpoch !== pending.auditorRuntimeEpoch) {
      return this.#finish(PEER_AUDIT_TERMINAL_OUTCOMES.TARGET_UNAVAILABLE, 'queued_target_identity_changed');
    }
    this.#pending = { ...pending, revision: pending.revision + 1, phase: 'waiting_reply' };
    return { status: 'applied', pending: { ...this.#pending }, effects: [] };
  }

  replyAccepted(input: {
    attemptId: string;
    attemptRevision: number;
    receivedAt: number;
    verdict: PeerAuditVerdict;
    findings: string;
  }): PeerAuditTransitionResult {
    const checked = this.#checkEffect(input.attemptId, input.attemptRevision);
    if (checked) return checked;
    const pending = this.#pending!;
    if (input.receivedAt >= pending.deadlineAt) {
      return this.#finish(PEER_AUDIT_TERMINAL_OUTCOMES.TIMEOUT, 'deadline_expired', pending.deadlineAt);
    }
    return this.#finish(
      input.verdict === 'PASS' ? PEER_AUDIT_TERMINAL_OUTCOMES.PASS : PEER_AUDIT_TERMINAL_OUTCOMES.REWORK,
      undefined,
      input.receivedAt,
      input.verdict,
      input.findings,
    );
  }

  invalidReply(input: { attemptId: string }): PeerAuditTransitionResult {
    this.#pruneTombstones(this.#clock.now());
    if (this.#pending?.attemptId === input.attemptId) {
      return { status: 'invalid', pending: { ...this.#pending }, effects: [] };
    }
    if (this.#tombstones.has(input.attemptId)) return { status: 'duplicate', effects: [] };
    return { status: 'missing', effects: [] };
  }

  timeout(input: { attemptId: string; occurredAt?: number }): PeerAuditTransitionResult {
    const now = input.occurredAt ?? this.#clock.now();
    this.#pruneTombstones(now);
    if (!this.#pending) return this.#terminalAbsence(input.attemptId);
    if (this.#pending.attemptId !== input.attemptId) return { status: 'stale', pending: { ...this.#pending }, effects: [] };
    if (now < this.#pending.deadlineAt) return { status: 'invalid', pending: { ...this.#pending }, effects: [] };
    return this.#finish(PEER_AUDIT_TERMINAL_OUTCOMES.TIMEOUT, 'deadline_expired', this.#pending.deadlineAt);
  }

  cancel(input: { attemptId: string; reason?: string; completedAt?: number }): PeerAuditTransitionResult {
    this.#pruneTombstones(input.completedAt ?? this.#clock.now());
    if (!this.#pending) return this.#terminalAbsence(input.attemptId);
    if (this.#pending.attemptId !== input.attemptId) return { status: 'stale', pending: { ...this.#pending }, effects: [] };
    return this.#finish(PEER_AUDIT_TERMINAL_OUTCOMES.CANCELLED, input.reason ?? 'cancelled', input.completedAt);
  }

  baselineInvalidated(reason = 'baseline_invalidated'): PeerAuditTransitionResult {
    return this.#cancelActive(reason);
  }

  targetInvalidated(reason = 'target_invalidated'): PeerAuditTransitionResult {
    if (!this.#pending) return { status: 'missing', effects: [] };
    return this.#finish(PEER_AUDIT_TERMINAL_OUTCOMES.TARGET_UNAVAILABLE, reason);
  }

  configurationInvalidated(reason = 'configuration_invalidated'): PeerAuditTransitionResult {
    if (!this.#pending) return { status: 'missing', effects: [] };
    return this.#finish(PEER_AUDIT_TERMINAL_OUTCOMES.INVALID_CONFIGURATION, reason);
  }

  modeChanged(input: { automaticRunnable: boolean }): PeerAuditTransitionResult {
    if (!this.#pending) return { status: 'missing', effects: [] };
    if (this.#pending.trigger === 'quick') {
      if (!input.automaticRunnable && this.#automaticWaiter) {
        return this.invalidateAutomaticWaiter('automatic_mode_unrunnable');
      }
      return { status: 'applied', pending: { ...this.#pending }, effects: [] };
    }
    if (input.automaticRunnable) {
      return { status: 'applied', pending: { ...this.#pending }, effects: [] };
    }
    return this.#finish(PEER_AUDIT_TERMINAL_OUTCOMES.INVALID_CONFIGURATION, 'automatic_mode_unrunnable');
  }

  invalidateAutomaticWaiter(reason: string): PeerAuditTransitionResult {
    const waiter = this.#automaticWaiter;
    if (!waiter) {
      return this.#pending
        ? { status: 'missing', pending: { ...this.#pending }, effects: [] }
        : { status: 'missing', effects: [] };
    }
    const pending = this.#pending;
    this.#automaticWaiter = undefined;
    if (!pending) return { status: 'applied', effects: [] };
    const effects: PeerAuditControllerEffect[] = [{
      type: 'automatic_waiter_invalidated',
      attemptId: pending.attemptId,
      effectRevision: pending.revision,
      waiter,
      reason,
    }];
    this.#emitEffects(effects);
    return { status: 'applied', pending: { ...pending }, effects };
  }

  shutdown(): PeerAuditTransitionResult {
    this.#automaticWaiter = undefined;
    return this.#cancelActive('shutdown');
  }

  #cancelActive(reason: string): PeerAuditTransitionResult {
    if (!this.#pending) return { status: 'missing', effects: [] };
    return this.#finish(PEER_AUDIT_TERMINAL_OUTCOMES.CANCELLED, reason);
  }

  #checkEffect(attemptId: string, effectRevision: number): PeerAuditTransitionResult | undefined {
    this.#pruneTombstones(this.#clock.now());
    if (!this.#pending) return this.#terminalAbsence(attemptId);
    if (this.#pending.attemptId !== attemptId || this.#pending.revision !== effectRevision) {
      return { status: 'stale', pending: { ...this.#pending }, effects: [] };
    }
    return undefined;
  }

  #terminalAbsence(attemptId: string): PeerAuditTransitionResult {
    return this.#tombstones.has(attemptId)
      ? { status: 'duplicate', effects: [] }
      : { status: 'missing', effects: [] };
  }

  #finish(
    outcome: PeerAuditTerminalOutcome,
    reason?: string,
    completedAt = this.#clock.now(),
    verdict?: PeerAuditVerdict,
    findings?: string,
  ): PeerAuditTransitionResult {
    const pending = this.#pending;
    if (!pending) return { status: 'missing', effects: [] };
    const terminalRevision = pending.revision + 1;
    const terminal: PeerAuditTerminalRecord = {
      attemptId: pending.attemptId,
      revision: terminalRevision,
      trigger: pending.trigger,
      outcome,
      ...(reason ? { reason } : {}),
      ...(verdict ? { verdict } : {}),
      ...(findings ? { findings } : {}),
      completedAt,
      elapsedMs: Math.max(0, completedAt - pending.startedAt),
      ...(pending.disposition ? { disposition: pending.disposition } : {}),
    };
    if (this.#deadlineTimer !== undefined) {
      this.#clock.clearTimeout(this.#deadlineTimer);
      this.#deadlineTimer = undefined;
    }
    this.#pending = undefined;
    this.#addTombstone(terminal);
    const effects: PeerAuditControllerEffect[] = [];
    if (pending.phase === 'queued' && pending.messageId) {
      effects.push({
        type: 'remove_queued_message',
        attemptId: pending.attemptId,
        effectRevision: terminalRevision,
        messageId: pending.messageId,
        ...(pending.queueEpoch ? { queueEpoch: pending.queueEpoch } : {}),
      });
    }
    effects.push({
      type: 'emit_terminal',
      attemptId: pending.attemptId,
      effectRevision: terminalRevision,
      terminal,
    });
    if (pending.trigger === 'quick' && this.#automaticWaiter) {
      const waiter = this.#automaticWaiter;
      this.#automaticWaiter = undefined;
      effects.push({
        type: 'automatic_slot_available',
        attemptId: pending.attemptId,
        effectRevision: terminalRevision,
        waiter,
      });
    }
    this.#emitEffects(effects);
    return { status: 'applied', terminal, effects };
  }

  #emitEffects(effects: readonly PeerAuditControllerEffect[]): void {
    if (effects.length > 0) this.#onEffects?.(effects);
  }

  #addTombstone(terminal: PeerAuditTerminalRecord): void {
    this.#pruneTombstones(terminal.completedAt);
    this.#tombstones.set(terminal.attemptId, {
      attemptId: terminal.attemptId,
      terminal,
      expiresAt: terminal.completedAt + this.#tombstoneTtlMs,
    });
    while (this.#tombstones.size > this.#tombstoneCapacity) {
      const oldest = this.#tombstones.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#tombstones.delete(oldest);
    }
  }

  #pruneTombstones(now: number): void {
    for (const [attemptId, tombstone] of this.#tombstones) {
      if (tombstone.expiresAt <= now) this.#tombstones.delete(attemptId);
    }
  }

  getTombstone(attemptId: string): PeerAuditTombstone | undefined {
    this.#pruneTombstones(this.#clock.now());
    const tombstone = this.#tombstones.get(attemptId);
    return tombstone ? { ...tombstone, terminal: { ...tombstone.terminal } } : undefined;
  }

  get tombstoneCount(): number {
    this.#pruneTombstones(this.#clock.now());
    return this.#tombstones.size;
  }
}
