import { DAEMON_MSG } from '@shared/daemon-events.js';
import {
  SUPERVISION_CONSOLE_RESYNC_REASONS,
  SUPERVISION_TASK_CONSOLE_MSG,
  initialSupervisionConsoleCursor,
  type SupervisionConsoleResyncReason,
  type SupervisionTaskConsoleAck,
  type SupervisionTaskConsoleResyncRequired,
  type SupervisionTaskConsoleScope,
  type SupervisionTaskConsoleSubscribe,
  type SupervisionTaskConsoleUnsubscribe,
} from '@shared/supervision-task-console.js';
import {
  SUPERVISION_TASK_CONSOLE_PHASE,
  createSupervisionTaskConsoleState,
  supervisionTaskConsoleReducer,
  type SupervisionTaskConsoleReducerAction,
  type SupervisionTaskConsoleReducerState,
} from './supervision-task-console-reducer.js';

export interface SupervisionTaskConsoleSocket {
  send(message: object): void;
  onMessage(handler: (message: unknown) => void): () => void;
}

type StateListener = (state: SupervisionTaskConsoleReducerState) => void;

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

  constructor(
    private readonly socket: SupervisionTaskConsoleSocket,
    private readonly scope: SupervisionTaskConsoleScope,
  ) {
    this.state = createSupervisionTaskConsoleState(scope);
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
    this.unsubscribeMessage?.();
    this.unsubscribeMessage = null;
  }

  setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    if (!connected) {
      this.apply({ type: 'transport_disconnected' });
      return;
    }
    this.requestSubscription('initial', false);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  private apply(action: SupervisionTaskConsoleReducerAction): void {
    const previous = this.state;
    const next = supervisionTaskConsoleReducer(previous, action);
    if (next === previous) return;
    this.state = next;
    this.emit();

    if (next.resyncGeneration > previous.resyncGeneration && this.connected && next.resyncReason) {
      this.requestSubscription(next.resyncReason, true);
      return;
    }
    if (
      next.phase === SUPERVISION_TASK_CONSOLE_PHASE.READY
      && next.subscriptionId
      && (previous.phase !== SUPERVISION_TASK_CONSOLE_PHASE.READY
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
  }

  private handleMessage(message: unknown): void {
    if (!this.connected) return;
    if (!isRecord(message)) return;
    if (message.type === DAEMON_MSG.RECONNECTED) {
      this.requestSubscription('initial', false);
      return;
    }
    if (message.type === SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED) {
      const control = parseResyncRequired(message);
      if (!control) return;
      if (!this.state.subscriptionId || control.subscriptionId !== this.state.subscriptionId) return;
      if (!sameScope(control.scope, this.scope)) {
        this.apply({ type: 'server_resync_required', reason: 'scope_mismatch' });
        return;
      }
      this.apply({ type: 'server_resync_required', reason: control.reason });
      return;
    }
    if (message.type === SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT) {
      this.apply({ type: 'snapshot_received', payload: message });
      return;
    }
    if (message.type === SUPERVISION_TASK_CONSOLE_MSG.DELTA) {
      this.apply({ type: 'delta_received', payload: message });
    }
  }
}
