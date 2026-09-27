import { DAEMON_MSG } from '@shared/daemon-events.js';
import {
  SUPERVISION_CONSOLE_RESYNC_REASONS,
  SUPERVISION_CONSOLE_UNAVAILABLE_REASONS,
  SUPERVISION_TASK_CONSOLE_MSG,
  initialSupervisionConsoleCursor,
  type SupervisionConsoleResyncReason,
  type SupervisionTaskConsoleAck,
  type SupervisionTaskConsoleResyncRequired,
  type SupervisionTaskConsoleScope,
  type SupervisionTaskConsoleSubscribe,
  type SupervisionTaskConsoleUnsubscribe,
  type SupervisionTaskConsoleUnavailable,
} from '@shared/supervision-task-console.js';
import {
  SUPERVISION_TASK_CONSOLE_PHASE,
  createSupervisionTaskConsoleState,
  supervisionTaskConsoleReducer,
  type SupervisionTaskConsoleReducerAction,
  type SupervisionTaskConsoleReducerState,
} from './supervision-task-console-reducer.js';
import {
  clearSupervisionTaskConsoleCache,
  readSupervisionTaskConsoleCache,
  writeSupervisionTaskConsoleCache,
  type SupervisionTaskConsoleAuthority,
} from './supervision-task-console-cache.js';

export interface SupervisionTaskConsoleSocket {
  send(message: object): void;
  onMessage(handler: (message: unknown) => void): () => void;
}

type StateListener = (state: SupervisionTaskConsoleReducerState) => void;

/** Bound an unanswered subscribe so the console always exposes its Retry control. */
export const SUPERVISION_TASK_CONSOLE_SUBSCRIBE_TIMEOUT_MS = 15_000;

/**
 * Automatic full resyncs are spaced out and capped. Every resync makes the
 * daemon rebuild a full snapshot, so an immediate retry loop on a projection
 * the client keeps rejecting turns into a request storm that can peg the
 * daemon. The first resync in a window is immediate (a real gap should heal
 * fast); later ones back off exponentially; past the cap the console stops
 * for good and shows its stale/error state with the explicit Retry control.
 */
export const SUPERVISION_TASK_CONSOLE_RESYNC_BASE_DELAY_MS = 2_000;
export const SUPERVISION_TASK_CONSOLE_RESYNC_MAX_DELAY_MS = 60_000;
export const SUPERVISION_TASK_CONSOLE_RESYNC_WINDOW_MS = 5 * 60_000;
export const SUPERVISION_TASK_CONSOLE_MAX_AUTOMATIC_RESYNCS = 6;
export const SUPERVISION_TASK_CONSOLE_RESYNC_LIMIT_ERROR = 'resync_limit';

function sameScope(left: SupervisionTaskConsoleScope, right: SupervisionTaskConsoleScope): boolean {
  return left.projectName === right.projectName
    && left.coordinatorSessionName === right.coordinatorSessionName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function newSubscriptionId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `task-console-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isResyncReason(value: unknown): value is SupervisionConsoleResyncReason {
  return typeof value === 'string'
    && (SUPERVISION_CONSOLE_RESYNC_REASONS as readonly string[]).includes(value);
}

function parseResyncRequired(value: unknown): SupervisionTaskConsoleResyncRequired | null {
  if (!isRecord(value) || value.type !== SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED) return null;
  if (typeof value.subscriptionId !== 'string' || !isRecord(value.scope) || !isResyncReason(value.reason)) return null;
  if (typeof value.scope.projectName !== 'string' || typeof value.scope.coordinatorSessionName !== 'string') return null;
  return value as unknown as SupervisionTaskConsoleResyncRequired;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseUnavailable(value: unknown): SupervisionTaskConsoleUnavailable | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'type', 'subscriptionId', 'scope', 'reason', 'retryable',
  ])) return null;
  if (value.type !== SUPERVISION_TASK_CONSOLE_MSG.UNAVAILABLE
    || typeof value.subscriptionId !== 'string'
    || !isRecord(value.scope)
    || !hasExactKeys(value.scope, ['projectName', 'coordinatorSessionName'])
    || typeof value.scope.projectName !== 'string'
    || typeof value.scope.coordinatorSessionName !== 'string'
    || value.reason !== SUPERVISION_CONSOLE_UNAVAILABLE_REASONS.PROJECTION_UNAVAILABLE
    || value.retryable !== true) return null;
  return value as unknown as SupervisionTaskConsoleUnavailable;
}

/**
 * Event-driven owner for the authenticated-WS task-console projection.
 *
 * There is deliberately no polling path. Reconnect sends the newest durable
 * cursor; gaps and malformed/unknown projections replace that with a full
 * snapshot request. The pure reducer remains independently testable.
 */
export class SupervisionTaskConsoleController {
  private state: SupervisionTaskConsoleReducerState;
  private readonly listeners = new Set<StateListener>();
  private unsubscribeMessage: (() => void) | null = null;
  private connected = false;
  private subscribeTimeout: ReturnType<typeof setTimeout> | null = null;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  /** Scheduled start times of recent automatic resyncs, pruned to the window. */
  private automaticResyncs: number[] = [];
  /** Set at the cap; only an explicit Retry re-enables automatic resyncs. */
  private automaticResyncExhausted = false;

  constructor(
    private readonly socket: SupervisionTaskConsoleSocket,
    private readonly scope: SupervisionTaskConsoleScope,
    private readonly authority?: SupervisionTaskConsoleAuthority,
  ) {
    this.state = authority
      ? readSupervisionTaskConsoleCache(authority) ?? createSupervisionTaskConsoleState(scope)
      : createSupervisionTaskConsoleState(scope);
  }

  getState(): SupervisionTaskConsoleReducerState {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.unsubscribeMessage) return;
    this.unsubscribeMessage = this.socket.onMessage((message) => this.handleMessage(message));
  }

  stop(): void {
    const activeSubscriptionId = this.state.subscriptionId;
    if (this.connected && activeSubscriptionId) {
      const frame: SupervisionTaskConsoleUnsubscribe = {
        type: SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE,
        subscriptionId: activeSubscriptionId,
        scope: this.scope,
      };
      this.socket.send(frame);
    }
    this.connected = false;
    this.clearSubscribeTimeout();
    this.clearResyncTimer();
    this.unsubscribeMessage?.();
    this.unsubscribeMessage = null;
  }

  setConnected(connected: boolean): void {
    if (this.connected === connected) {
      // The controller starts disconnected. Its first React effect must still
      // leave a terminal, visible state instead of preserving IDLE/loading.
      if (!connected && this.state.phase !== SUPERVISION_TASK_CONSOLE_PHASE.ERROR) {
        this.clearSubscribeTimeout();
        this.apply({ type: 'transport_disconnected' });
      }
      return;
    }
    this.connected = connected;
    if (!connected) {
      this.clearSubscribeTimeout();
      this.clearResyncTimer();
      this.apply({ type: 'transport_disconnected' });
      return;
    }
    this.requestSubscription('initial', false);
  }

  /** Explicit user recovery after stale/error sync state. */
  retry(): void {
    if (!this.connected) {
      this.apply({ type: 'transport_disconnected' });
      return;
    }
    // An explicit user retry starts a fresh automatic-resync budget.
    this.clearResyncTimer();
    this.automaticResyncs = [];
    this.automaticResyncExhausted = false;
    this.requestSubscription('initial', true);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  private clearSubscribeTimeout(): void {
    if (!this.subscribeTimeout) return;
    clearTimeout(this.subscribeTimeout);
    this.subscribeTimeout = null;
  }

  private clearResyncTimer(): void {
    if (!this.resyncTimer) return;
    clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
  }

  private scheduleAutomaticResync(reason: SupervisionConsoleResyncReason): void {
    // One pending resync covers every further request until it fires.
    if (this.resyncTimer) return;
    if (this.automaticResyncExhausted) {
      // Never claim "resyncing" when nothing will be requested.
      this.apply({ type: 'transport_error', error: SUPERVISION_TASK_CONSOLE_RESYNC_LIMIT_ERROR });
      return;
    }
    const now = Date.now();
    this.automaticResyncs = this.automaticResyncs
      .filter((at) => now - at < SUPERVISION_TASK_CONSOLE_RESYNC_WINDOW_MS);
    const attempt = this.automaticResyncs.length;
    if (attempt >= SUPERVISION_TASK_CONSOLE_MAX_AUTOMATIC_RESYNCS) {
      this.automaticResyncExhausted = true;
      this.clearSubscribeTimeout();
      this.apply({ type: 'transport_error', error: SUPERVISION_TASK_CONSOLE_RESYNC_LIMIT_ERROR });
      return;
    }
    const delayMs = attempt === 0
      ? 0
      : Math.min(
        SUPERVISION_TASK_CONSOLE_RESYNC_BASE_DELAY_MS * 2 ** (attempt - 1),
        SUPERVISION_TASK_CONSOLE_RESYNC_MAX_DELAY_MS,
      );
    this.automaticResyncs.push(now + delayMs);
    if (delayMs === 0) {
      this.requestSubscription(reason, true);
      return;
    }
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      if (!this.connected) return;
      this.requestSubscription(this.state.resyncReason ?? reason, true);
    }, delayMs);
  }

  private armSubscribeTimeout(subscriptionId: string): void {
    this.clearSubscribeTimeout();
    this.subscribeTimeout = setTimeout(() => {
      this.subscribeTimeout = null;
      if (!this.connected
        || !this.state.syncing
        || this.state.subscriptionId !== subscriptionId) return;
      this.apply({ type: 'transport_error', error: 'subscription_timeout' });
    }, SUPERVISION_TASK_CONSOLE_SUBSCRIBE_TIMEOUT_MS);
  }

  private apply(action: SupervisionTaskConsoleReducerAction): void {
    const previous = this.state;
    const next = supervisionTaskConsoleReducer(previous, action);
    if (next === previous) return;
    this.state = next;
    if (this.authority && next.hasAuthoritativeSnapshot
      && (action.type === 'snapshot_received' || action.type === 'delta_received')) {
      writeSupervisionTaskConsoleCache(this.authority, next);
    }
    this.emit();

    if (next.resyncGeneration > previous.resyncGeneration && this.connected && next.resyncReason) {
      this.scheduleAutomaticResync(next.resyncReason);
      return;
    }
    if (
      next.phase === SUPERVISION_TASK_CONSOLE_PHASE.READY
      && next.subscriptionId
      && (previous.phase !== SUPERVISION_TASK_CONSOLE_PHASE.READY
        || (previous.syncing && !next.syncing)
        || next.projectionVersion !== previous.projectionVersion
        || next.lastDurableEventId !== previous.lastDurableEventId
        || next.projectionEpoch !== previous.projectionEpoch)
    ) {
      const ack: SupervisionTaskConsoleAck = {
        type: SUPERVISION_TASK_CONSOLE_MSG.ACK,
        subscriptionId: next.subscriptionId,
        scope: next.scope,
        projectionVersion: next.projectionVersion,
        lastDurableEventId: next.lastDurableEventId,
        projectionEpoch: next.projectionEpoch,
      };
      this.socket.send(ack);
    }
  }

  private requestSubscription(reason: SupervisionConsoleResyncReason, fullSnapshot: boolean): void {
    if (!this.connected) return;
    if (!fullSnapshot && reason === 'initial' && this.state.syncing && this.state.subscriptionId) return;
    const subscriptionId = newSubscriptionId();
    const current = this.state;
    const cursor = fullSnapshot
      ? initialSupervisionConsoleCursor(this.scope)
      : {
          schemaVersion: current.schemaVersion,
          statusContractVersion: current.statusContractVersion,
          projectionVersion: current.projectionVersion,
          lastDurableEventId: current.lastDurableEventId,
          projectionEpoch: current.projectionEpoch,
          scope: current.scope,
        };
    const frame: SupervisionTaskConsoleSubscribe = {
      ...cursor,
      type: SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE,
      subscriptionId,
      afterEventId: fullSnapshot ? null : current.lastDurableEventId,
      reason,
    };
    this.apply({ type: 'subscribe_started', subscriptionId });
    this.socket.send(frame);
    this.armSubscribeTimeout(subscriptionId);
  }

  private handleMessage(message: unknown): void {
    if (!this.connected) return;
    if (!isRecord(message)) return;
    if (message.type === DAEMON_MSG.DISCONNECTED) {
      this.clearSubscribeTimeout();
      this.apply({ type: 'transport_error', error: 'daemon_disconnected' });
      return;
    }
    if (message.type === DAEMON_MSG.RECONNECTED) {
      this.requestSubscription('initial', false);
      return;
    }
    if (message.type === SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED) {
      const control = parseResyncRequired(message);
      if (!control) return;
      if (!this.state.subscriptionId || control.subscriptionId !== this.state.subscriptionId) return;
      this.clearSubscribeTimeout();
      if (!sameScope(control.scope, this.scope)) {
        this.apply({ type: 'server_resync_required', reason: 'scope_mismatch' });
        return;
      }
      this.apply({ type: 'server_resync_required', reason: control.reason });
      return;
    }
    if (message.type === SUPERVISION_TASK_CONSOLE_MSG.UNAVAILABLE) {
      const unavailable = parseUnavailable(message);
      if (!unavailable || !this.state.subscriptionId
        || unavailable.subscriptionId !== this.state.subscriptionId
        || !sameScope(unavailable.scope, this.scope)) return;
      this.clearSubscribeTimeout();
      if (this.authority) clearSupervisionTaskConsoleCache(this.authority);
      this.apply({ type: 'authority_invalidated', error: unavailable.reason });
      return;
    }
    if (message.type === SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT) {
      if (message.subscriptionId === this.state.subscriptionId) this.clearSubscribeTimeout();
      if (typeof window !== 'undefined') { (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot = message; window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail: message })); }
      this.apply({ type: 'snapshot_received', payload: message, receivedAt: Date.now() });
      return;
    }
    if (message.type === SUPERVISION_TASK_CONSOLE_MSG.DELTA) {
      if (message.subscriptionId === this.state.subscriptionId) this.clearSubscribeTimeout();
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail: message }));
      this.apply({ type: 'delta_received', payload: message, receivedAt: Date.now() });
    }
  }
}
