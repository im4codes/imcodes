/**
 * Supervision console subscription handling over the existing authenticated WS.
 *
 * The daemon is the authority. This registry owns the per-connection view of
 * that authority: who is subscribed, what cursor they claim, and whether the
 * next thing we owe them is a full snapshot or a contiguous run of deltas.
 *
 * Authorization is fail-closed and silent. An unauthorized subscribe receives
 * NOTHING -- not even a resync demand -- because a refusal frame would confirm
 * that the scope exists. Tests assert the send count stays zero.
 */
import {
  SUPERVISION_TASK_CONSOLE_MSG,
  SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
  SUPERVISION_CONSOLE_UNAVAILABLE_REASONS,
  isSupervisionTaskConsoleMessageType,
  type SupervisionConsoleResyncReason,
  type SupervisionTaskConsoleDelta,
  type SupervisionTaskConsoleScope,
} from '../../shared/supervision-task-console.js';
import { SUPERVISION_TASK_STATUS_CONTRACT_VERSION } from '../../shared/supervision-config.js';
import type { SupervisionConsoleProducer } from './supervision-console-producer.js';

export interface SupervisionConsoleSessionDeps {
  producer: SupervisionConsoleProducer;
  send: (frame: unknown) => void;
  /** Fail-closed: absent means deny. */
  authorize: (scope: SupervisionTaskConsoleScope) => boolean;
  now?: () => number;
  onError?: (error: unknown) => void;
  /** Drives production-only polling while at least one authorized view is open. */
  onActiveSubscriptionCountChanged?: (count: number) => void;
}

interface ActiveSubscription {
  subscriptionId: string;
  scope: SupervisionTaskConsoleScope;
}

/**
 * Composite map key for a scope.
 *
 * JSON array rather than a delimiter-joined string: it is unambiguous for any
 * project/session name without reserving a separator character. The previous
 * form embedded a literal NUL byte as the delimiter, which is both a raw
 * control byte in source (rejected by the repo NUL-byte guard) and needless,
 * since JSON already escapes any collision.
 */
function scopeKey(scope: SupervisionTaskConsoleScope): string {
  return JSON.stringify([scope.projectName, scope.coordinatorSessionName]);
}

function readScope(value: unknown): SupervisionTaskConsoleScope | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const projectName = record.projectName;
  const coordinatorSessionName = record.coordinatorSessionName;
  if (typeof projectName !== 'string' || !projectName) return undefined;
  if (typeof coordinatorSessionName !== 'string' || !coordinatorSessionName) return undefined;
  return { projectName, coordinatorSessionName };
}

export class SupervisionConsoleSessionRegistry {
  readonly #deps: SupervisionConsoleSessionDeps;
  readonly #subscriptions = new Map<string, ActiveSubscription>();
  #refused = 0;

  constructor(deps: SupervisionConsoleSessionDeps) {
    this.#deps = deps;
  }

  /** Subscribes refused for authorization. Exposed so tests can prove silence. */
  get refusedCount(): number { return this.#refused; }

  get activeSubscriptionCount(): number { return this.#subscriptions.size; }

  activeSubscriptionId(scope: SupervisionTaskConsoleScope): string | undefined {
    return this.#subscriptions.get(scopeKey(scope))?.subscriptionId;
  }

  /**
   * Handle one inbound frame. Returns true when this registry owns the type,
   * so the caller's dispatcher can fall through for anything else.
   */
  handleFrame(frame: unknown): boolean {
    if (!frame || typeof frame !== 'object') return false;
    const record = frame as Record<string, unknown>;
    if (!isSupervisionTaskConsoleMessageType(record.type)) return false;
    switch (record.type) {
      case SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE: return this.#handleSubscribe(record);
      case SUPERVISION_TASK_CONSOLE_MSG.ACK: return this.#handleAck(record);
      case SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE: return this.#handleUnsubscribe(record);
      default:
        // SNAPSHOT/DELTA/RESYNC_REQUIRED are daemon->browser only. Receiving one
        // inbound means a confused or hostile peer; claim and drop it.
        return true;
    }
  }

  #handleSubscribe(record: Record<string, unknown>): boolean {
    const scope = readScope(record.scope);
    const subscriptionId = typeof record.subscriptionId === 'string' ? record.subscriptionId : '';
    if (!scope || !subscriptionId) return true;
    if (!this.#deps.authorize(scope)) {
      this.#refused += 1;
      return true; // silent: no frame, no existence disclosure
    }
    // A newer subscribe supersedes the previous one for this scope, which is
    // what makes a late snapshot from the old one droppable at the browser.
    const countBefore = this.#subscriptions.size;
    this.#subscriptions.set(scopeKey(scope), { subscriptionId, scope });
    if (this.#subscriptions.size !== countBefore) {
      this.#deps.onActiveSubscriptionCountChanged?.(this.#subscriptions.size);
    }

    const afterEventId = typeof record.afterEventId === 'number' && Number.isFinite(record.afterEventId)
      ? record.afterEventId
      : null;
    try {
      // Recover any registry commit whose low-latency notification was missed
      // before deciding whether this client needs a snapshot or replay.
      // Do not broadcast during subscribe catch-up: a full-snapshot client is
      // not ready for deltas yet, while a resume client is replayed below from
      // the just-written outbox in exact order.
      this.#deps.producer.synchronizeDurableEvents(scope, { deliver: false });
      if (afterEventId === null) return this.#sendSnapshot(scope, subscriptionId);

      const clientVersion = typeof record.projectionVersion === 'number' ? record.projectionVersion : 0;
      const clientEpoch = typeof record.projectionEpoch === 'string' ? record.projectionEpoch : '';
      const cursor = this.#deps.producer.restoreCursor(scope);

      if (typeof record.schemaVersion === 'number' && record.schemaVersion !== SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION) {
        return this.#demandResync(scope, subscriptionId, 'schema_mismatch');
      }
      if (typeof record.statusContractVersion === 'number'
        && record.statusContractVersion !== SUPERVISION_TASK_STATUS_CONTRACT_VERSION) {
        return this.#demandResync(scope, subscriptionId, 'status_contract_mismatch');
      }
      if (clientEpoch !== cursor.projectionEpoch) {
        return this.#demandResync(scope, subscriptionId, 'authority_epoch_changed');
      }

      const owed = this.#deps.producer.pendingFrames(scope)
        .filter((row) => row.eventId > afterEventId)
        .sort((left, right) => left.projectionVersion - right.projectionVersion);

      // Nothing owed: explicitly confirm the current projection. The browser has
      // already moved to SUBSCRIBING for this new subscription id; silence here
      // leaves it there forever even though its cursor is current. A snapshot is
      // the existing authenticated/current acknowledgement and also makes a
      // restart robust when the browser retained rows but the socket did not.
      if (owed.length === 0) return this.#sendSnapshot(scope, subscriptionId);
      // The oldest thing we still hold must be exactly the client's next version.
      // If the outbox has already been pruned past it we cannot patch the hole.
      if (owed[0]!.projectionVersion !== clientVersion + 1) {
        return this.#demandResync(scope, subscriptionId, 'outbox_truncated');
      }
      for (const row of owed) {
        this.#deps.send({ ...row.frame, subscriptionId });
      }
      return true;
    } catch (error) {
      this.#deps.onError?.(error);
      this.#deps.send({
        type: SUPERVISION_TASK_CONSOLE_MSG.UNAVAILABLE,
        subscriptionId,
        scope,
        reason: SUPERVISION_CONSOLE_UNAVAILABLE_REASONS.PROJECTION_UNAVAILABLE,
        retryable: true,
      });
      return true;
    }
  }

  #handleAck(record: Record<string, unknown>): boolean {
    const scope = readScope(record.scope);
    const projectionVersion = record.projectionVersion;
    if (!scope || typeof projectionVersion !== 'number' || !Number.isFinite(projectionVersion)) return true;
    if (!this.#deps.authorize(scope)) { this.#refused += 1; return true; }
    // Only the current subscription may move the durable cursor; a late ack
    // from a superseded subscribe must not prune frames the new one still owes.
    const active = this.#subscriptions.get(scopeKey(scope));
    if (!active || active.subscriptionId !== record.subscriptionId) return true;
    this.#deps.producer.recordAck(scope, projectionVersion);
    return true;
  }

  #handleUnsubscribe(record: Record<string, unknown>): boolean {
    const scope = readScope(record.scope);
    if (!scope) return true;
    const active = this.#subscriptions.get(scopeKey(scope));
    if (active && active.subscriptionId === record.subscriptionId) {
      this.#subscriptions.delete(scopeKey(scope));
      this.#deps.onActiveSubscriptionCountChanged?.(this.#subscriptions.size);
    }
    return true;
  }

  #sendSnapshot(scope: SupervisionTaskConsoleScope, subscriptionId: string): boolean {
    this.#deps.send(this.#deps.producer.buildSnapshot(scope, subscriptionId));
    return true;
  }

  #demandResync(
    scope: SupervisionTaskConsoleScope,
    subscriptionId: string,
    reason: SupervisionConsoleResyncReason,
  ): boolean {
    this.#deps.send({
      type: SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED,
      subscriptionId, scope, reason,
    });
    return true;
  }

  /**
   * Fan a producer delta out to the subscriber for its scope.
   *
   * The stored frame carries an empty subscriptionId because the outbox is
   * written before any particular subscriber is known; it is stamped per
   * recipient here so a stale-subscription drop stays possible.
   */
  broadcast(delta: SupervisionTaskConsoleDelta): void {
    const active = this.#subscriptions.get(scopeKey(delta.scope));
    if (!active) return;
    this.#deps.send({ ...delta, subscriptionId: active.subscriptionId });
  }

  /** A `pairs`-engine project changed: every viewer of it re-subscribes for a fresh snapshot. */
  resyncProject(projectName: string, reason: SupervisionConsoleResyncReason): void {
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.scope.projectName !== projectName) continue;
      this.#demandResync(subscription.scope, subscription.subscriptionId, reason);
    }
  }

  /** Project newly committed registry events for every currently viewed scope. */
  refreshActiveSubscriptions(): void {
    for (const subscription of this.#subscriptions.values()) {
      this.#deps.producer.synchronizeDurableEvents(subscription.scope);
    }
  }
}
