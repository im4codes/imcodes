/**
 * Management-privacy barrier on the controlled node.
 *
 * The owner is about to type a password into a shell on this machine while
 * remote viewers are watching it. Between BEGIN and a proven END, no real
 * desktop pixel may reach any route. Everything here is therefore ordered so
 * that the *shield* is established before anything is acknowledged, and the
 * shield is only lifted after cleanup AND a fresh post-secret frame are both
 * proven -- never on a timer, never on a reconnect, never on a cached frame.
 *
 * Frames ride the already-authenticated node channel. There is deliberately no
 * second credential or nonce: a privacy barrier that needed its own secret
 * would add another thing to steal, and the node channel is already the
 * authority boundary for everything else this process does.
 */
import {
  REMOTE_DESKTOP_PRIVACY_MSG,
  REMOTE_DESKTOP_PRIVACY_LIMITS,
  validateRemoteDesktopPrivacyMessage,
  type RemoteDesktopPrivacyAck,
  type RemoteDesktopPrivacyBegin,
  type RemoteDesktopPrivacyEnd,
  type RemoteDesktopRouteGeneration,
} from '../../shared/remote-desktop-access.js';
import {
  hasExactRemoteDesktopKeys,
  isRemoteDesktopId,
} from '../../shared/remote-desktop-contract-primitives.js';

/** Worker-bound frames. Separate from the session Signal union, like consent. */
export const WORKER_PRIVACY_FRAME = {
  SHIELD: 'worker.privacy.shield',
  SHIELDED: 'worker.privacy.shielded',
  RELEASE: 'worker.privacy.release',
  RELEASED: 'worker.privacy.released',
} as const;

/**
 * What the worker reports once the shield is up. `routes` is the complete set
 * the worker is actually feeding, captured AFTER the switch: a route that
 * appeared during the switch must be in it or the ack is incomplete.
 */
export interface WorkerPrivacyShieldedFrame {
  type: typeof WORKER_PRIVACY_FRAME.SHIELDED;
  epochId: string;
  /** Exact privacy revision that produced this route snapshot. */
  revision: number;
  workerGeneration: number;
  inputReleased: boolean;
  routes: readonly RemoteDesktopRouteGeneration[];
}

export interface WorkerPrivacyReleasedFrame {
  type: typeof WORKER_PRIVACY_FRAME.RELEASED;
  epochId: string;
  /** Worker asserts the secret-bearing surface was torn down first. */
  secretCleanupComplete: boolean;
  /** Generation of a frame captured strictly AFTER cleanup. */
  freshFrameWorkerGeneration: number;
}

export type WorkerPrivacyInboundFrame =
  | WorkerPrivacyShieldedFrame
  | WorkerPrivacyReleasedFrame;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRouteList(value: unknown): value is RemoteDesktopRouteGeneration[] {
  if (!Array.isArray(value)
    || value.length > REMOTE_DESKTOP_PRIVACY_LIMITS.MAX_ACK_ROUTES) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)
      || !hasExactRemoteDesktopKeys(entry, ['routeId', 'routeGeneration'])
      || !isRemoteDesktopId(entry.routeId)
      || typeof entry.routeGeneration !== 'number'
      || !Number.isSafeInteger(entry.routeGeneration) || entry.routeGeneration < 0) return false;
    if (seen.has(entry.routeId)) return false;
    seen.add(entry.routeId);
  }
  return true;
}

function sameRouteSet(
  expected: readonly RemoteDesktopRouteGeneration[],
  actual: readonly RemoteDesktopRouteGeneration[],
): boolean {
  if (expected.length !== actual.length) return false;
  const generations = new Map(actual.map((route) => [route.routeId, route.routeGeneration]));
  return expected.every((route) => generations.get(route.routeId) === route.routeGeneration);
}

export function parseWorkerPrivacyFrame(value: unknown): WorkerPrivacyInboundFrame | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === WORKER_PRIVACY_FRAME.SHIELDED) {
    if (!hasExactRemoteDesktopKeys(value, [
      'type', 'epochId', 'revision', 'workerGeneration', 'inputReleased', 'routes',
    ])
      || !isRemoteDesktopId(value.epochId)
      || typeof value.revision !== 'number'
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || typeof value.workerGeneration !== 'number'
      || !Number.isSafeInteger(value.workerGeneration) || value.workerGeneration < 0
      || typeof value.inputReleased !== 'boolean'
      || !isRouteList(value.routes)) return null;
    return {
      type: WORKER_PRIVACY_FRAME.SHIELDED,
      epochId: value.epochId,
      revision: value.revision,
      workerGeneration: value.workerGeneration,
      inputReleased: value.inputReleased,
      routes: value.routes,
    };
  }
  if (value.type === WORKER_PRIVACY_FRAME.RELEASED) {
    if (!hasExactRemoteDesktopKeys(value, [
      'type', 'epochId', 'secretCleanupComplete', 'freshFrameWorkerGeneration',
    ])
      || !isRemoteDesktopId(value.epochId)
      || typeof value.secretCleanupComplete !== 'boolean'
      || typeof value.freshFrameWorkerGeneration !== 'number'
      || !Number.isSafeInteger(value.freshFrameWorkerGeneration)
      || value.freshFrameWorkerGeneration < 0) return null;
    return {
      type: WORKER_PRIVACY_FRAME.RELEASED,
      epochId: value.epochId,
      secretCleanupComplete: value.secretCleanupComplete,
      freshFrameWorkerGeneration: value.freshFrameWorkerGeneration,
    };
  }
  return null;
}

export interface PrivacyTransport {
  send(frame: Record<string, unknown>): Promise<boolean> | boolean;
  subscribe(handler: (frame: WorkerPrivacyInboundFrame) => void): () => void;
}

export type RemoteDesktopPrivacyRecoveryReason =
  | 'daemon_generation_changed'
  | 'daemon_disconnected'
  | 'release_send_failed'
  | 'release_unconfirmed'
  | 'secret_cleanup_failed'
  | 'fresh_frame_stale';

export interface PrivacyBarrierDeps {
  transport: PrivacyTransport;
  hostId: () => string;
  daemonGeneration: () => number;
  now?: () => number;
  workerAckTimeoutMs?: number;
  /**
   * Route churn can complete after the initial BEGIN response. Every later
   * complete Worker snapshot is forwarded so the Server can compare it with
   * its authoritative durable route snapshot; Node never guesses that set.
   */
  onShieldedUpdate?: (ack: RemoteDesktopPrivacyAck) => void;
  onRecoveryRequired?: (reason: RemoteDesktopPrivacyRecoveryReason) => void;
}

interface ActiveEpoch {
  epochId: string;
  revision: number;
  /** Worker generation at the moment the shield went up. */
  shieldWorkerGeneration: number;
  /** Immutable durable route snapshot for this exact privacy revision. */
  routes: readonly RemoteDesktopRouteGeneration[];
  daemonGeneration: number;
}

const DEFAULT_WORKER_ACK_TIMEOUT_MS = REMOTE_DESKTOP_PRIVACY_LIMITS.ROUTE_REPLACEMENT_ACK_MS;

/**
 * Node-side privacy barrier. Holds at most one active epoch: the owner is one
 * person typing one password, and a second concurrent epoch would make "which
 * shield is up" ambiguous exactly when it must not be.
 */
export class RemoteDesktopPrivacyBarrier {
  private readonly deps: PrivacyBarrierDeps;
  private active: ActiveEpoch | null = null;
  /**
   * Set when an epoch could not be cleanly ended. The shield stays up and no
   * further BEGIN/END is honoured: recovery is a new epoch, not a rollback.
   */
  private recoveryRequired = false;

  constructor(deps: PrivacyBarrierDeps) {
    this.deps = deps;
    // Keep listening after BEGIN. A replacement PREPARE arrives after the
    // durable BEGIN command, so the Worker may first report an empty/old set
    // and then a new complete actual set. The Server accepts only the exact
    // authoritative snapshot; dropping the later frame would deadlock route
    // replacement even though the Worker is safely shielded.
    this.deps.transport.subscribe((frame) => this.onWorkerUpdate(frame));
  }

  private ackFor(
    active: ActiveEpoch,
    frame: WorkerPrivacyShieldedFrame,
  ): RemoteDesktopPrivacyAck {
    return {
      type: REMOTE_DESKTOP_PRIVACY_MSG.ACK,
      hostId: this.deps.hostId(),
      epochId: active.epochId,
      revision: active.revision,
      workerGeneration: frame.workerGeneration,
      routes: frame.routes,
    };
  }

  private onWorkerUpdate(frame: WorkerPrivacyInboundFrame): void {
    if (frame.type !== WORKER_PRIVACY_FRAME.SHIELDED) return;
    const active = this.active;
    if (!active || this.recoveryRequired
      || frame.epochId !== active.epochId
      || frame.revision !== active.revision
      || !frame.inputReleased
      || !sameRouteSet(active.routes, frame.routes)
      || this.deps.daemonGeneration() !== active.daemonGeneration) return;
    active.shieldWorkerGeneration = frame.workerGeneration;
    try { this.deps.onShieldedUpdate?.(this.ackFor(active, frame)); } catch {
      // Delivery diagnostics cannot lift the shield. The durable Server epoch
      // will retry BEGIN and the Worker can re-emit its exact current set.
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** True while real pixels must not reach any route. */
  shielded(): boolean {
    return this.active !== null || this.recoveryRequired;
  }

  activeEpochId(): string | null {
    return this.active?.epochId ?? null;
  }

  recoveryPending(): boolean {
    return this.recoveryRequired;
  }

  private requireRecovery(reason: RemoteDesktopPrivacyRecoveryReason): void {
    if (!this.active && !this.recoveryRequired) return;
    this.recoveryRequired = true;
    try { this.deps.onRecoveryRequired?.(reason); } catch { /* diagnostics must not affect privacy state */ }
  }

  /**
   * Subscribe BEFORE the request is sent. The worker pipe can deliver its
   * reply in the same turn the write completes; subscribing afterwards drops
   * that reply and the barrier then fails closed on a timeout it did not need
   * to take.
   */
  private waitForWorker<T extends WorkerPrivacyInboundFrame>(
    epochId: string,
    type: T['type'],
    accept: (frame: T) => boolean = () => true,
  ): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      let settled = false;
      const finish = (value: T | null) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(value);
      };
      const unsubscribe = this.deps.transport.subscribe((frame) => {
        if (frame.type !== type) return;
        // A frame for another epoch is never evidence about this one.
        if (frame.epochId !== epochId) return;
        const typed = frame as T;
        if (!accept(typed)) return;
        finish(typed);
      });
      const timer = setTimeout(
        () => finish(null),
        this.deps.workerAckTimeoutMs ?? DEFAULT_WORKER_ACK_TIMEOUT_MS,
      );
      timer.unref?.();
    });
  }

  /**
   * Handle a Server BEGIN. Returns the ack to send back, or null when the
   * barrier could not be established -- in which case the caller sends
   * nothing and the Server's own deadline fails the epoch closed.
   */
  async begin(raw: unknown): Promise<RemoteDesktopPrivacyAck | null> {
    const parsed = validateRemoteDesktopPrivacyMessage(raw);
    if (!parsed.ok || parsed.value.type !== REMOTE_DESKTOP_PRIVACY_MSG.BEGIN) return null;
    const begin: RemoteDesktopPrivacyBegin = parsed.value;
    // Wrong host: this barrier protects THIS machine's screen. Shielding on
    // behalf of another host would both fail to protect that one and blind
    // this one's legitimate viewers.
    if (begin.hostId !== this.deps.hostId()) return null;
    if (this.recoveryRequired) return null;
    if (begin.deadlineAt <= this.now()) return null;
    // A second epoch, or a revision that does not advance, is a replay.
    if (this.active && !(begin.epochId === this.active.epochId
      && begin.revision > this.active.revision)) return null;

    const daemonGeneration = this.deps.daemonGeneration();
    const waiting = this.waitForWorker<WorkerPrivacyShieldedFrame>(
      begin.epochId, WORKER_PRIVACY_FRAME.SHIELDED,
      (frame) => frame.revision === begin.revision
        && sameRouteSet(begin.routeSnapshot, frame.routes),
    );
    const sent = await Promise.resolve(this.deps.transport.send({
      type: WORKER_PRIVACY_FRAME.SHIELD,
      epochId: begin.epochId,
      revision: begin.revision,
      presentationSource: begin.presentationSource,
      routes: begin.routeSnapshot,
    })).catch(() => false);
    if (!sent) return null;

    const shielded = await waiting;
    // No answer means we do not know whether the shield is up. Fail closed:
    // no ack, so the Server never enables secret UI.
    if (!shielded) return null;
    // The worker must have released held input BEFORE shielding. A viewer
    // whose key is still down would keep typing into the secret surface it
    // can no longer see.
    if (!shielded.inputReleased) return null;
    // The pre-PREPARE Worker receives the durable expected snapshot with BEGIN
    // and may answer only after every replacement generation exists behind an
    // opaque source.  Rejecting a subset here keeps a malformed native adapter
    // from relying solely on the later Server-side comparison.
    if (!sameRouteSet(begin.routeSnapshot, shielded.routes)) return null;

    // Authority must not have changed underneath us while the shield went up.
    if (this.deps.daemonGeneration() !== daemonGeneration) return null;

    this.active = {
      epochId: begin.epochId,
      revision: begin.revision,
      shieldWorkerGeneration: shielded.workerGeneration,
      routes: shielded.routes,
      daemonGeneration,
    };
    return this.ackFor(this.active, shielded);
  }

  /**
   * Handle a Server END. Restores real capture only after the worker proves
   * both secret cleanup and a strictly newer post-secret frame generation.
   * Returns the ack to send, or null when the shield must stay up.
   */
  async end(raw: unknown): Promise<RemoteDesktopPrivacyAck | null> {
    const parsed = validateRemoteDesktopPrivacyMessage(raw);
    if (!parsed.ok || parsed.value.type !== REMOTE_DESKTOP_PRIVACY_MSG.END) return null;
    const end: RemoteDesktopPrivacyEnd = parsed.value;
    const active = this.active;
    if (!active) return null;
    // Once the epoch is in recovery the shield is terminal for it: a
    // disconnect or a failed cleanup means we can no longer prove the secret
    // is gone, and ending on that basis would restore pixels on a guess.
    if (this.recoveryRequired) return null;
    if (end.hostId !== this.deps.hostId()) return null;
    if (end.epochId !== active.epochId || end.revision !== active.revision) return null;
    // A reconnect during the epoch invalidated the authority that opened it.
    // The shield stays up; recovery is a new epoch.
    if (this.deps.daemonGeneration() !== active.daemonGeneration) {
      this.requireRecovery('daemon_generation_changed');
      return null;
    }

    const waiting = this.waitForWorker<WorkerPrivacyReleasedFrame>(
      active.epochId, WORKER_PRIVACY_FRAME.RELEASED,
    );
    const sent = await Promise.resolve(this.deps.transport.send({
      type: WORKER_PRIVACY_FRAME.RELEASE,
      epochId: active.epochId,
      revision: active.revision,
    })).catch(() => false);
    if (!sent) {
      this.requireRecovery('release_send_failed');
      return null;
    }

    const released = await waiting;
    if (!released) {
      this.requireRecovery('release_unconfirmed');
      return null;
    }
    // Cleanup first, always. Restoring pixels before the secret surface is
    // gone would broadcast the very thing the epoch existed to hide.
    if (!released.secretCleanupComplete) {
      this.requireRecovery('secret_cleanup_failed');
      return null;
    }
    // The proof frame must be STRICTLY newer than the generation the shield
    // went up at. Equal means the worker handed back something it already had
    // -- a cached pre-end frame that may still contain the secret.
    if (released.freshFrameWorkerGeneration <= active.shieldWorkerGeneration) {
      this.requireRecovery('fresh_frame_stale');
      return null;
    }
    // The Server's own expectation of freshness must be met too.
    if (released.freshFrameWorkerGeneration < end.freshFrameWorkerGeneration) {
      this.requireRecovery('fresh_frame_stale');
      return null;
    }

    this.active = null;
    return {
      type: REMOTE_DESKTOP_PRIVACY_MSG.ACK,
      hostId: end.hostId,
      epochId: end.epochId,
      revision: end.revision,
      workerGeneration: released.freshFrameWorkerGeneration,
      routes: active.routes,
    };
  }

  /**
   * Connection loss. The shield must NOT come down: the owner may still be
   * looking at a password, and a reconnect would otherwise resume streaming
   * real pixels to whoever reconnects first.
   */
  onDaemonDisconnected(): void {
    if (this.active) this.requireRecovery('daemon_disconnected');
  }

  onShellRecoveryRequired(): void {
    if (this.active) this.requireRecovery('secret_cleanup_failed');
  }
}
