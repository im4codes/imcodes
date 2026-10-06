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
  SUPERVISION_TASK_CONSOLE_FEATURES,
  SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
  SUPERVISION_TASK_CONSOLE_CLIENT_ID_MAX_LENGTH,
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
  /** Production sends snapshots after yielding so WS callbacks stay short. */
  deferSnapshots?: boolean;
}

interface ActiveSubscription {
  subscriptionId: string;
  scope: SupervisionTaskConsoleScope;
  /**
   * Which browser page owns this subscription (`clientId` on SUBSCRIBE). A page
   * re-subscribing replaces only its own previous subscription; other pages of
   * the same scope keep theirs. Pages that predate `clientId` all share the
   * empty key, which is the old one-subscription-per-scope behaviour.
   */
  clientKey: string;
  /**
   * The viewer declared PAIR_DELTA_V1 for a `pairs` project: its snapshots omit
   * briefs and pair changes reach it as PAIR_DELTA instead of a re-subscribe.
   */
  pairDelta: boolean;
  /**
   * Whether the snapshot this viewer was served came from the pair store (true)
   * or the legacy registry (false). The two engines own different rows for the
   * same scope, so a flip while the viewer is open leaves it on the wrong set.
   */
  pairsEngine: boolean;
}

/**
 * Viewers kept per scope. A closed tab's subscription is normally removed by
 * the server's UNSUBSCRIBE on socket close; this bound caps the cost of one
 * that is not (every delta is sent once per viewer).
 */
export const SUPERVISION_CONSOLE_MAX_VIEWERS_PER_SCOPE = 8;

/**
 * A browser can emit a burst of SUBSCRIBE frames while recovering a malformed
 * projection.  Keep the guard on the connection (this registry is per WS),
 * rather than globally: one noisy viewer must not throttle another viewer's
 * authorized scope.  The limits only suppress the expensive durable replay;
 * each accepted subscription still receives a current snapshot/replay below.
 */
const SUBSCRIBE_DEDUP_WINDOW_MS = 1_000;
const SUBSCRIBE_RATE_WINDOW_MS = 5 * 60_000;
const SUBSCRIBE_SYNC_LIMIT = 6;

interface SubscribeBudget {
  windowStartedAt: number;
  requestCount: number;
  lastAt: number;
  lastSubscriptionId: string;
  lastFingerprint: string;
  lastSyncAt: number;
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

function subscribeFingerprint(record: Record<string, unknown>, scope: SupervisionTaskConsoleScope): string {
  return JSON.stringify([
    scopeKey(scope),
    record.subscriptionId,
    record.afterEventId ?? null,
    record.projectionVersion ?? null,
    record.lastDurableEventId ?? null,
    record.projectionEpoch ?? null,
    record.schemaVersion ?? null,
    record.statusContractVersion ?? null,
  ]);
}

export class SupervisionConsoleSessionRegistry {
  readonly #deps: SupervisionConsoleSessionDeps;
  /** scope -> viewer (client key) -> its subscription; insertion order is recency. */
  readonly #subscriptions = new Map<string, Map<string, ActiveSubscription>>();
  /** Coalesce repeated subscribe storms while a large replay is yielding. */
  readonly #durableReplayInFlight = new Map<string, Promise<void>>();
  /** Per scope, each viewer's newest SUBSCRIBE waiting for the yielded replay to finish. */
  readonly #pendingReplay = new Map<string, Map<string, Record<string, unknown>>>();
  readonly #subscribeBudgets = new Map<string, SubscribeBudget>();
  #refused = 0;

  constructor(deps: SupervisionConsoleSessionDeps) {
    this.#deps = deps;
  }

  /** Subscribes refused for authorization. Exposed so tests can prove silence. */
  get refusedCount(): number { return this.#refused; }

  get activeSubscriptionCount(): number {
    let count = 0;
    for (const viewers of this.#subscriptions.values()) count += viewers.size;
    return count;
  }

  /** The most recently subscribed viewer of the scope (introspection only). */
  activeSubscriptionId(scope: SupervisionTaskConsoleScope): string | undefined {
    const viewers = this.#subscriptions.get(scopeKey(scope));
    if (!viewers) return undefined;
    let latest: ActiveSubscription | undefined;
    for (const subscription of viewers.values()) latest = subscription;
    return latest?.subscriptionId;
  }

  #allSubscriptions(): ActiveSubscription[] {
    const out: ActiveSubscription[] = [];
    for (const viewers of this.#subscriptions.values()) out.push(...viewers.values());
    return out;
  }

  #findSubscription(scope: SupervisionTaskConsoleScope, subscriptionId: unknown): ActiveSubscription | undefined {
    if (typeof subscriptionId !== 'string') return undefined;
    for (const subscription of this.#subscriptions.get(scopeKey(scope))?.values() ?? []) {
      if (subscription.subscriptionId === subscriptionId) return subscription;
    }
    return undefined;
  }

  #clientKeyOf(record: Record<string, unknown>): string {
    const clientId = record.clientId;
    return typeof clientId === 'string' && clientId.length > 0 && clientId.length <= SUPERVISION_TASK_CONSOLE_CLIENT_ID_MAX_LENGTH ? clientId : '';
  }

  /** Register (or replace the same viewer's) subscription and drop what it supersedes. */
  #registerSubscription(
    scope: SupervisionTaskConsoleScope,
    subscriptionId: string,
    record: Record<string, unknown>,
  ): ActiveSubscription {
    const countBefore = this.activeSubscriptionCount;
    const key = scopeKey(scope);
    let viewers = this.#subscriptions.get(key);
    if (!viewers) { viewers = new Map(); this.#subscriptions.set(key, viewers); }
    const clientKey = this.#clientKeyOf(record);
    const previous = viewers.get(clientKey);
    // The new subscription's snapshot re-seeds its pair view. Until it does, a
    // pair change must not produce a delta against the previous subscription.
    if (previous) this.#deps.producer.dropPairView(scope, previous.subscriptionId);
    viewers.delete(clientKey); // re-insert so insertion order stays recency order
    const subscription: ActiveSubscription = {
      subscriptionId, scope, clientKey,
      pairDelta: this.#wantsPairDelta(record, scope),
      pairsEngine: this.#deps.producer.isPairsProject(scope),
    };
    viewers.set(clientKey, subscription);
    while (viewers.size > SUPERVISION_CONSOLE_MAX_VIEWERS_PER_SCOPE) {
      const [oldestKey, oldest] = viewers.entries().next().value as [string, ActiveSubscription];
      viewers.delete(oldestKey);
      this.#deps.producer.dropPairView(scope, oldest.subscriptionId);
      this.#subscribeBudgets.delete(this.#budgetKey(scope, oldestKey));
    }
    if (this.activeSubscriptionCount !== countBefore) {
      this.#deps.onActiveSubscriptionCountChanged?.(this.activeSubscriptionCount);
    }
    return subscription;
  }

  #budgetKey(scope: SupervisionTaskConsoleScope, clientKey: string): string {
    return JSON.stringify([scopeKey(scope), clientKey]);
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
      case SUPERVISION_TASK_CONSOLE_MSG.BRIEF_REQUEST: return this.#handleBriefRequest(record);
      default:
        // SNAPSHOT/DELTA/RESYNC_REQUIRED are daemon->browser only. Receiving one
        // inbound means a confused or hostile peer; claim and drop it.
        return true;
    }
  }

  #handleSubscribe(record: Record<string, unknown>): boolean {
    const scope = readScope(record.scope);
    let needsYieldedReplay = false;
    if (scope && this.#deps.authorize(scope)) {
      try {
        needsYieldedReplay = this.#deps.producer.needsYieldedDurableReplay(scope);
      } catch {
        // Let the synchronous path's correlated UNAVAILABLE handling report
        // projection/database failures to the current subscription.
        return this.#handleSubscribeSync(record);
      }
    }
    if (scope && this.#deps.authorize(scope) && needsYieldedReplay) {
      const key = scopeKey(scope);
      const subscriptionId = typeof record.subscriptionId === 'string' ? record.subscriptionId : '';
      if (subscriptionId) {
        this.#registerSubscription(scope, subscriptionId, record);
        let pending = this.#pendingReplay.get(key);
        if (!pending) { pending = new Map(); this.#pendingReplay.set(key, pending); }
        // Newest frame per viewer: a viewer's own resubscribe storm collapses
        // to its last id, while other viewers of the scope are still answered.
        pending.set(this.#clientKeyOf(record), record);
      }
      if (this.#durableReplayInFlight.has(key)) return true;
      // A large replay is deliberately detached from the inbound WS callback:
      // it yields between SQLite chunks so heartbeat/control traffic remains
      // serviceable while the snapshot catches up.
      let work: Promise<void>;
      work = this.#drainSubscribeReplay(scope, record).finally(() => {
        if (this.#durableReplayInFlight.get(key) === work) this.#durableReplayInFlight.delete(key);
      });
      this.#durableReplayInFlight.set(key, work);
      return true;
    }
    return this.#handleSubscribeSync(record);
  }

  /** Take the viewers waiting on this scope's replay. */
  #takePendingReplay(key: string): Array<[string, Record<string, unknown>]> {
    const pending = this.#pendingReplay.get(key);
    this.#pendingReplay.delete(key);
    return pending ? [...pending.entries()] : [];
  }

  async #drainSubscribeReplay(scope: SupervisionTaskConsoleScope, first: Record<string, unknown>): Promise<void> {
    const key = scopeKey(scope);
    if (!this.#deps.authorize(scope)) { this.#pendingReplay.delete(key); return; }
    try {
      this.#deps.producer.ensureProjectionBaseline(scope);
      // A viewer that subscribes while the drain yields joins `pending`; loop
      // until nobody is waiting so no viewer is left unanswered.
      while (true) {
        await this.#deps.producer.synchronizeDurableEventsAsync(scope, { deliver: false });
        const waiting = this.#takePendingReplay(key);
        if (waiting.length === 0) break;
        for (const [clientKey, latest] of waiting) {
          const active = this.#subscriptions.get(key)?.get(clientKey);
          // The viewer may have left or been replaced while the replay yielded;
          // answer its CURRENT subscription, not the frame that queued the work.
          // The latest frame also preserves its cursor/schema fields.
          if (!active) continue;
          this.#handleSubscribeSync({ ...latest, subscriptionId: active.subscriptionId });
        }
      }
    } catch (error) {
      this.#deps.onError?.(error);
      const waiting = this.#takePendingReplay(key);
      const ids = new Set<string>(waiting.map(([, record]) => String(record.subscriptionId ?? '')));
      const firstId = typeof first.subscriptionId === 'string' ? first.subscriptionId : '';
      if (firstId) ids.add(firstId);
      for (const subscriptionId of ids) {
        if (!subscriptionId) continue;
        this.#deps.send({
          type: SUPERVISION_TASK_CONSOLE_MSG.UNAVAILABLE,
          subscriptionId,
          scope,
          reason: SUPERVISION_CONSOLE_UNAVAILABLE_REASONS.PROJECTION_UNAVAILABLE,
          retryable: true,
        });
      }
    }
  }

  #handleSubscribeSync(record: Record<string, unknown>): boolean {
    const scope = readScope(record.scope);
    const subscriptionId = typeof record.subscriptionId === 'string' ? record.subscriptionId : '';
    if (!scope || !subscriptionId) return true;
    if (!this.#deps.authorize(scope)) {
      this.#refused += 1;
      return true; // silent: no frame, no existence disclosure
    }
    const now = this.#deps.now?.() ?? Date.now();
    const key = this.#budgetKey(scope, this.#clientKeyOf(record));
    const fingerprint = subscribeFingerprint(record, scope);
    let budget = this.#subscribeBudgets.get(key);
    if (!budget || now - budget.windowStartedAt >= SUBSCRIBE_RATE_WINDOW_MS) {
      budget = {
        windowStartedAt: now,
        requestCount: 0,
        lastAt: now,
        lastSubscriptionId: subscriptionId,
        lastFingerprint: fingerprint,
        lastSyncAt: Number.NEGATIVE_INFINITY,
      };
      this.#subscribeBudgets.set(key, budget);
    } else if (budget.lastSubscriptionId === subscriptionId
      && budget.lastFingerprint === fingerprint
      && now - budget.lastAt < SUBSCRIBE_DEDUP_WINDOW_MS) {
      // The same frame may be retried by the WS layer.  It already has an
      // authoritative response (or is still being processed), so doing the
      // projection again only amplifies a malformed-status storm.
      return true;
    }
    budget.requestCount += 1;
    const synchronize = budget.requestCount <= SUBSCRIBE_SYNC_LIMIT
      && now - budget.lastSyncAt >= SUBSCRIBE_DEDUP_WINDOW_MS;
    budget.lastAt = now;
    budget.lastSubscriptionId = subscriptionId;
    budget.lastFingerprint = fingerprint;
    if (synchronize) budget.lastSyncAt = now;
    // A newer subscribe from the SAME viewer supersedes its previous one, which
    // is what makes a late snapshot from the old one droppable at the browser.
    // Other viewers of the scope keep their own subscriptions.
    const pairDelta = this.#registerSubscription(scope, subscriptionId, record).pairDelta;

    const afterEventId = typeof record.afterEventId === 'number' && Number.isFinite(record.afterEventId)
      ? record.afterEventId
      : null;
    try {
      // Recover any registry commit whose low-latency notification was missed
      // before deciding whether this client needs a snapshot or replay.
      // Do not broadcast during subscribe catch-up: a full-snapshot client is
      // not ready for deltas yet, while a resume client is replayed below from
      // the just-written outbox in exact order.
      // Once the per-viewer budget is exhausted, continue serving the current
      // projection but do not repeatedly replay the same durable backlog.
      // This is intentionally before any cursor/pending-frame work: the old
      // client used to reconnect immediately on every unknown row, and each
      // subscribe could otherwise run a full synchronous synchronization.
      if (synchronize) this.#deps.producer.synchronizeDurableEvents(scope, { deliver: false });
      if (afterEventId === null) return this.#sendSnapshot(scope, subscriptionId, pairDelta);

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

      // Pair state has no durable outbox: a viewer that resumes with a cursor
      // could otherwise keep pair rows from before a reconnect. Answer with the
      // current snapshot, which also seeds the pair view its deltas build on.
      if (pairDelta) return this.#sendSnapshot(scope, subscriptionId, true);

      const owed = this.#deps.producer.pendingFrames(scope)
        .filter((row) => row.eventId > afterEventId)
        .sort((left, right) => left.projectionVersion - right.projectionVersion);

      // Nothing owed: explicitly confirm the current projection. The browser has
      // already moved to SUBSCRIBING for this new subscription id; silence here
      // leaves it there forever even though its cursor is current. A snapshot is
      // the existing authenticated/current acknowledgement and also makes a
      // restart robust when the browser retained rows but the socket did not.
      if (owed.length === 0) return this.#sendSnapshot(scope, subscriptionId, false);
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
    // Only a current subscription may move the durable cursor; a late ack
    // from a superseded subscribe must not prune frames the new one still owes.
    if (!this.#findSubscription(scope, record.subscriptionId)) return true;
    this.#deps.producer.recordAck(scope, projectionVersion);
    return true;
  }

  #handleUnsubscribe(record: Record<string, unknown>): boolean {
    const scope = readScope(record.scope);
    if (!scope) return true;
    const active = this.#findSubscription(scope, record.subscriptionId);
    if (active) {
      const key = scopeKey(scope);
      const viewers = this.#subscriptions.get(key);
      viewers?.delete(active.clientKey);
      if (viewers && viewers.size === 0) this.#subscriptions.delete(key);
      this.#subscribeBudgets.delete(this.#budgetKey(scope, active.clientKey));
      // Only THIS viewer's delta base goes; the scope's other viewers keep theirs.
      this.#deps.producer.dropPairView(scope, active.subscriptionId);
      this.#deps.onActiveSubscriptionCountChanged?.(this.activeSubscriptionCount);
    }
    return true;
  }

  #wantsPairDelta(record: Record<string, unknown>, scope: SupervisionTaskConsoleScope): boolean {
    const features = record.features;
    return Array.isArray(features)
      && features.includes(SUPERVISION_TASK_CONSOLE_FEATURES.PAIR_DELTA_V1)
      && this.#deps.producer.isPairsProject(scope);
  }

  /** On-demand brief for one pair of the caller's authorized, currently subscribed scope. */
  #handleBriefRequest(record: Record<string, unknown>): boolean {
    const scope = readScope(record.scope);
    const taskId = record.taskId;
    if (!scope || typeof taskId !== 'string' || !taskId) return true;
    if (!this.#deps.authorize(scope)) { this.#refused += 1; return true; }
    const active = this.#findSubscription(scope, record.subscriptionId);
    if (!active) return true;
    try {
      const found = this.#deps.producer.readPairBrief(scope.projectName, taskId);
      this.#deps.send({
        type: SUPERVISION_TASK_CONSOLE_MSG.BRIEF_RESPONSE,
        scope,
        subscriptionId: active.subscriptionId,
        taskId,
        briefRevision: found?.briefRevision ?? null,
        brief: found?.brief ?? null,
      });
    } catch (error) {
      this.#deps.onError?.(error);
    }
    return true;
  }

  #sendSnapshot(scope: SupervisionTaskConsoleScope, subscriptionId: string, pairDelta = false): boolean {
    if (this.#deps.deferSnapshots) {
      void this.#deps.producer.buildSnapshotAsync(scope, subscriptionId, { pairDelta })
        .then((snapshot) => {
          if (!this.#findSubscription(scope, subscriptionId)) return;
          this.#deps.send(snapshot);
        })
        .catch((error) => {
          this.#deps.onError?.(error);
          if (!this.#findSubscription(scope, subscriptionId)) return;
          this.#deps.send({
            type: SUPERVISION_TASK_CONSOLE_MSG.UNAVAILABLE,
            subscriptionId,
            scope,
            reason: SUPERVISION_CONSOLE_UNAVAILABLE_REASONS.PROJECTION_UNAVAILABLE,
            retryable: true,
          });
        });
      return true;
    }
    this.#deps.send(this.#deps.producer.buildSnapshot(scope, subscriptionId, { pairDelta }));
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
   * Fan a legacy producer delta out to every viewer of its scope.
   *
   * The stored frame carries an empty subscriptionId because the outbox is
   * written before any particular subscriber is known; it is stamped per
   * recipient here so a stale-subscription drop stays possible.
   *
   * A `pairs`-engine project is never sent legacy deltas. Its rows are pair
   * rows; the legacy registry still holds the (often long cancelled) tasks the
   * pairs were imported from under the SAME ids, and re-appends an event for
   * them on every daemon start. Delivered, those deltas replaced the viewers'
   * cancelled pair rows with the legacy `delegated` rows. The events are still
   * projected (the durable cursor stays dense) - they are just not shown.
   */
  broadcast(delta: SupervisionTaskConsoleDelta): void {
    const viewers = this.#subscriptions.get(scopeKey(delta.scope));
    if (!viewers || viewers.size === 0) return;
    const pairsNow = this.#deps.producer.isPairsProject(delta.scope);
    for (const subscription of [...viewers.values()]) {
      if (pairsNow || subscription.pairsEngine) continue;
      this.#deps.send({ ...delta, subscriptionId: subscription.subscriptionId });
    }
  }

  /**
   * A `pairs`-engine project changed: every viewer of it re-subscribes for a
   * fresh snapshot. Only legacy viewers (and a pair-delta viewer whose delta
   * could not be produced) need this; see {@link pairsChanged}.
   */
  resyncProject(projectName: string, reason: SupervisionConsoleResyncReason): void {
    for (const subscription of this.#allSubscriptions()) {
      if (subscription.scope.projectName !== projectName) continue;
      this.#demandResync(subscription.scope, subscription.subscriptionId, reason);
    }
  }

  /**
   * A viewer's rows come from ONE engine, chosen when it subscribed. When the
   * project's engine flips under an open viewer (settings saved, supervision
   * mode toggled), nothing else tells it: it keeps the other engine's rows -
   * for a pairs project that means stale legacy `delegated` tasks. Ask each
   * affected viewer to resync, once per flip.
   */
  reconcileProjectEngines(): void {
    const engineByProject = new Map<string, boolean>();
    for (const subscription of this.#allSubscriptions()) {
      const { projectName } = subscription.scope;
      let pairsNow = engineByProject.get(projectName);
      if (pairsNow === undefined) {
        try {
          pairsNow = this.#deps.producer.isPairsProject(subscription.scope);
        } catch (error) {
          this.#deps.onError?.(error);
          continue;
        }
        engineByProject.set(projectName, pairsNow);
      }
      if (pairsNow === subscription.pairsEngine) continue;
      subscription.pairsEngine = pairsNow;
      this.#demandResync(subscription.scope, subscription.subscriptionId, 'task_pair_changed');
    }
  }

  /**
   * Pairs `taskIds` of `projectName` changed. A PAIR_DELTA_V1 viewer receives
   * one frame for exactly the pairs whose visible row changed; a legacy viewer
   * still re-subscribes for a full snapshot.
   */
  pairsChanged(projectName: string, taskIds: Iterable<string>, reason: SupervisionConsoleResyncReason): void {
    const dirty = [...taskIds];
    this.reconcileProjectEngines();
    for (const subscription of this.#allSubscriptions()) {
      if (subscription.scope.projectName !== projectName) continue;
      if (!subscription.pairDelta) {
        this.#demandResync(subscription.scope, subscription.subscriptionId, reason);
        continue;
      }
      try {
        const delta = this.#deps.producer.buildPairDelta(subscription.scope, subscription.subscriptionId, dirty);
        if (delta) this.#deps.send(delta);
      } catch (error) {
        this.#deps.onError?.(error);
        // The viewer's view is now unknowable: repair with a full snapshot.
        this.#demandResync(subscription.scope, subscription.subscriptionId, reason);
      }
    }
  }

  /** Project newly committed registry events for every currently viewed scope. */
  refreshActiveSubscriptions(): void {
    // Once per scope, however many viewers it has.
    for (const viewers of this.#subscriptions.values()) {
      const scope = viewers.values().next().value?.scope;
      if (!scope) continue;
      if (this.#deps.producer.needsYieldedDurableReplay(scope)) {
        void this.#deps.producer.synchronizeDurableEventsAsync(scope).catch((error) => this.#deps.onError?.(error));
      } else {
        this.#deps.producer.synchronizeDurableEvents(scope);
      }
    }
  }
}
