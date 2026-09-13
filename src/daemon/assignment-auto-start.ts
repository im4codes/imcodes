/**
 * Runtime-enforced, idempotent start of delegated supervision assignments.
 *
 * A formal IM.codes sub-session that received its task and is executing it is
 * started by the daemon itself (delegated -> implementing) at its first
 * authoritative execution evidence. No model has to remember start/claim and
 * no Brain has to poll or remind. See shared/supervision-assignment-start.ts
 * for the evidence classes.
 *
 * Provider activity only starts an assignment whose task message provably
 * reached the LIVE runtime: either the runtime is dispatching that exact
 * message in its current turn, or a durable delivery tombstone names the live
 * runtime as its recipient AND was stamped with the provider conversation that
 * runtime still holds. Activity before delivery (a busy session working
 * on something else), a native collaboration agent, a runtime that replaced
 * the one the task was delivered to, or a different assignment never starts
 * anything.
 *
 * When the evidence is real but the start cannot be committed (identity,
 * revision or persistence authority fails), the assignment is held fail-closed:
 * one fingerprinted structured blocker is persisted, the same report is
 * delivered to the authoritative Brain, and a worker that is provably
 * executing the task has its turn stopped, so nothing keeps working while the
 * registry still says `delegated`.
 */
import {
  SUPERVISION_ASSIGNMENT_AUTO_START_REFUSED_ERROR,
  SUPERVISION_ASSIGNMENT_AUTO_START_SOURCE,
  SUPERVISION_ASSIGNMENT_DELIVERY_PROOF,
  SUPERVISION_ASSIGNMENT_START_EVIDENCE,
  SUPERVISION_ASSIGNMENT_START_REFUSALS,
  SUPERVISION_ASSIGNMENT_STATUS_TIMELINE_EVENT,
  isAssignmentStartRefusalError,
  type SupervisionAssignmentDeliveryProof,
  type SupervisionAssignmentStartEvidence,
  type SupervisionAssignmentStartRefusal,
} from '../../shared/supervision-assignment-start.js';
import type { SupervisionBlockerEscalationReport } from '../../shared/agent-delegation.js';
import { getDelegationReplyStore } from './delegation-reply-store.js';
import {
  getSupervisionTaskRegistry,
  type PersistedSupervisionTaskAssignment,
  type PersistedSupervisionTaskAssignmentIdentity,
  type SupervisionTaskRegistryResult,
  type SupervisionTaskSnapshot,
} from './supervision-state-store.js';
import { timelineEmitter } from './timeline-emitter.js';
import { getTransportQueueStore } from './transport-queue-store.js';
import logger from '../util/logger.js';

export type AssignmentDeliveryEvidence =
  /** The task message provably reached the live runtime; a rotated identity may converge. */
  | { kind: 'live'; proof: SupervisionAssignmentDeliveryProof; messageId: string }
  /**
   * Delivered, but the live runtime is not proven as its recipient. Only an
   * assignment already bound to the exact live runtime may start from it: the
   * registry puts an assignment on a runtime only by dispatching bound work to
   * it (creation, continuation, heartbeat convergence).
   */
  | { kind: 'delivered'; messageId: string }
  /**
   * Delivered only where the live runtime cannot hold it: into a runtime the
   * assignment is not bound to, or into a provider conversation the live runtime
   * has since replaced. Never while a re-dispatch is still queued.
   */
  | { kind: 'replaced_runtime'; messageId: string }
  | { kind: 'none' };

export type AssignmentAutoStartOutcome =
  | { status: 'started'; taskId: string; assignmentId: string; identityConverged: boolean }
  | { status: 'refused'; taskId: string; assignmentId: string; refusal: SupervisionAssignmentStartRefusal; workerStopped: boolean }
  | { status: 'not_delivered' | 'already_started' | 'held' | 'ignored'; taskId: string; assignmentId: string; reason?: string }
  /** The acknowledging intent's own revision authority refused; nothing started, nothing held. */
  | { status: 'revision_refused'; taskId: string; assignmentId: string; reason: string };

export interface AssignmentAutoStartCandidate {
  task: Pick<SupervisionTaskSnapshot, 'taskId' | 'projectName' | 'currentRevision' | 'assignments'>;
  assignment: PersistedSupervisionTaskAssignment;
}

export interface AssignmentAutoStartDeps {
  now?: () => number;
  /** Deliver a persisted refusal to the Brain (lazy send-tool by default). */
  escalate?: (spec: AssignmentStartRefusalEscalation) => Promise<unknown>;
  /** Stop the worker's active turn (lazy command-handler by default). */
  stopWorker?: (sessionName: string) => Promise<boolean> | boolean;
}

export interface AssignmentStartRefusalEscalation {
  taskId: string;
  assignmentId: string;
  exactError: string;
  /** When false the report is persisted only; the daemon delivers it later. */
  deliver: boolean;
}

const sameRuntime = (
  recipient: { sessionInstanceId: string; runtimeEpoch: string },
  live: Pick<PersistedSupervisionTaskAssignmentIdentity, 'sessionInstanceId' | 'runtimeEpoch'>,
): boolean => recipient.sessionInstanceId === live.sessionInstanceId && recipient.runtimeEpoch === live.runtimeEpoch;

/** The exact refusal error carried by a persisted report, or undefined when it is not ours. */
export function readAssignmentStartRefusalError(blocker: string | undefined): string | undefined {
  if (!blocker?.trim()) return undefined;
  try {
    const report = JSON.parse(blocker) as Partial<SupervisionBlockerEscalationReport>;
    return isAssignmentStartRefusalError(report.exactError) ? report.exactError : undefined;
  } catch {
    return undefined;
  }
}

export function assignmentStartRefusalError(refusal: SupervisionAssignmentStartRefusal): string {
  return `${SUPERVISION_ASSIGNMENT_AUTO_START_REFUSED_ERROR}: ${refusal}`;
}

/**
 * The exact in-place repair for one refusal. A hold cleared in the wrong order
 * is refused again by the same fence, so the order is part of the instruction.
 */
export function assignmentStartRefusalRepair(exactError: string): string {
  if (exactError.endsWith(`: ${SUPERVISION_ASSIGNMENT_START_REFUSALS.REVISION_SUPERSEDED}`)) {
    return 'the authoritative Brain must recover this same assignment with supervision_task_recover assignmentStatus=implementing, which moves it onto the task\'s current revision; clearing the hold while it stays delegated on the superseded revision is refused again';
  }
  if (exactError.endsWith(`: ${SUPERVISION_ASSIGNMENT_START_REFUSALS.START_PERSISTENCE_FAILED}`)) {
    return 'once the registry is writable, the authoritative Brain must clear the hold with supervision_task_recover assignmentStatus=delegated; the recipient\'s next authoritative activity then starts it';
  }
  return 'the authoritative Brain must first re-dispatch the exact task to the live sub-session (send_message continuation of this taskId and assignmentId), then clear the hold with supervision_task_recover assignmentStatus=delegated; a hold cleared before the re-dispatch is refused again';
}

/**
 * Did the message that carried this assignment reach the live runtime AND the
 * provider conversation it holds now?
 *
 * A tombstone is exact proof only when it names the live runtime and was
 * stamped with the live provider conversation. A runtime epoch alone cannot
 * say that: a same-instance relaunch relabels earlier tombstones onto the new
 * epoch (resumed or reset alike), and a provider can replace its conversation
 * inside one epoch. So a live-runtime tombstone from another conversation is a
 * delivery into a replaced runtime, and one whose conversation is unknown
 * proves only that something was delivered.
 *
 * Read-only; every store consulted is durable, so the answer survives restart.
 */
export function readAssignmentDeliveryEvidence(input: {
  taskId: string;
  assignmentId: string;
  sessionName: string;
  assignmentIdentity: Pick<PersistedSupervisionTaskAssignmentIdentity, 'sessionInstanceId' | 'runtimeEpoch'>;
  liveIdentity: Pick<PersistedSupervisionTaskAssignmentIdentity, 'sessionInstanceId' | 'runtimeEpoch'>;
  /** The provider conversation the live runtime holds (resolveTransportConversationKey). */
  liveConversationKey?: string;
  activeDispatchMessageIds: ReadonlySet<string>;
}): AssignmentDeliveryEvidence {
  const messageIds = getDelegationReplyStore().listAssignmentDeliveryMessageIds({
    taskId: input.taskId,
    assignmentId: input.assignmentId,
    targetSessionName: input.sessionName,
  });
  if (messageIds.length === 0) return { kind: 'none' };
  const active = messageIds.find((messageId) => input.activeDispatchMessageIds.has(messageId));
  if (active) return { kind: 'live', proof: SUPERVISION_ASSIGNMENT_DELIVERY_PROOF.ACTIVE_DISPATCH, messageId: active };
  const liveIdentityKnown = Boolean(input.liveIdentity.sessionInstanceId && input.liveIdentity.runtimeEpoch);
  const liveConversation = input.liveConversationKey?.trim() || undefined;
  const boundToLiveRuntime = liveIdentityKnown && sameRuntime(input.assignmentIdentity, input.liveIdentity);
  const store = getTransportQueueStore();
  let unattributed: string | undefined;
  let otherRuntime: string | undefined;
  let otherConversation: string | undefined;
  for (const messageId of messageIds) {
    for (const delivery of store.listDeliveryRecipients(input.sessionName, messageId)) {
      if (!delivery.recipient || !liveIdentityKnown) {
        unattributed ??= messageId;
      } else if (!sameRuntime(delivery.recipient, input.liveIdentity)) {
        otherRuntime ??= messageId;
      } else if (!delivery.conversationKey || !liveConversation) {
        unattributed ??= messageId;
      } else if (delivery.conversationKey === liveConversation) {
        return { kind: 'live', proof: SUPERVISION_ASSIGNMENT_DELIVERY_PROOF.DELIVERY_TOMBSTONE, messageId };
      } else {
        otherConversation ??= messageId;
      }
    }
  }
  // Binding to the live runtime vouches for a delivery into an earlier epoch,
  // never for one into a conversation the live runtime provably no longer holds.
  const replaced = unattributed ? undefined : otherConversation ?? (boundToLiveRuntime ? undefined : otherRuntime);
  if (replaced) {
    // A re-dispatch still queued for this session proves itself on arrival;
    // refusing now would hold an assignment its repair is already reaching.
    return hasQueuedAssignmentDelivery(input.sessionName, messageIds)
      ? { kind: 'none' }
      : { kind: 'replaced_runtime', messageId: replaced };
  }
  const anyDelivery = unattributed ?? otherRuntime;
  return anyDelivery ? { kind: 'delivered', messageId: anyDelivery } : { kind: 'none' };
}

/** Is any message carrying this assignment still durably owned by the worker's queue? Read-only. */
function hasQueuedAssignmentDelivery(sessionName: string, messageIds: readonly string[]): boolean {
  const store = getTransportQueueStore();
  return messageIds.some((messageId) => store.hasDurableQueueAdmission(sessionName, messageId));
}

function refusalForRegistryRejection(
  result: Extract<SupervisionTaskRegistryResult<unknown>, { ok: false }>,
): SupervisionAssignmentStartRefusal | undefined {
  if (result.reason === 'owner_mismatch') return SUPERVISION_ASSIGNMENT_START_REFUSALS.RUNTIME_IDENTITY_MISMATCH;
  if (result.reason === 'old_revision') return SUPERVISION_ASSIGNMENT_START_REFUSALS.REVISION_SUPERSEDED;
  // not_found / role_forbidden / terminal / blocker raced in: the registry no
  // longer describes a startable delegated assignment. Nothing to escalate.
  return undefined;
}

const escalationsInFlight = new Set<string>();
/** Last escalation attempt per (assignment, refusal); bounds per-event retries. */
const escalationAttemptedAt = new Map<string, number>();
const ESCALATION_RETRY_INTERVAL_MS = 60_000;
const announcedStatuses = new Set<string>();
const BOUNDED_STATE_LIMIT = 4_096;

function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > BOUNDED_STATE_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * Persist, and unless `deliver` is false hand to the Brain, the one structured
 * report of a refused automatic start. Shares the implementer escalation core
 * with the no-progress disposition (same fingerprint CAS, deterministic
 * message id, durable queue reference).
 */
export async function escalateAssignmentStartRefusal(
  spec: AssignmentStartRefusalEscalation,
  sendDeps: import('./send-tool.js').SendToolDeps = {},
): Promise<import('./send-tool.js').ImplementationBlockerEscalationResult> {
  const { escalateImplementationBlocker } = await import('./send-tool.js');
  const registry = getSupervisionTaskRegistry();
  return escalateImplementationBlocker({
    taskId: spec.taskId,
    assignmentId: spec.assignmentId,
    eligibleStatus: 'delegated',
    ineligibleReason: 'assignment_not_delegated',
    exactError: spec.exactError,
    completedSafeWork: 'the daemon observed authoritative execution evidence for this delegated assignment but could not atomically start it; the assignment stays delegated and fail-closed, a turn carrying the task was stopped, and no Git or replacement object was created',
    brainOptions: ['repair_same_object_authority', 'redispatch_exact_assignment'],
    brainRecommendedNextAction: assignmentStartRefusalRepair(spec.exactError),
    persist: (record) => registry.recordAssignmentStartRefusalBlocker(record),
    redeliverOnReplay: true,
    deliver: spec.deliver,
  }, sendDeps);
}

const defaultEscalate = (spec: AssignmentStartRefusalEscalation): Promise<unknown> => escalateAssignmentStartRefusal(spec);

async function defaultStopWorker(sessionName: string): Promise<boolean> {
  const { stopSessionNow } = await import('./command-handler.js');
  return stopSessionNow(sessionName);
}

/**
 * Persist (and, from the daemon, deliver) one refusal, and stop a turn that is
 * provably carrying the task. Until the report is persisted, a following event
 * simply re-evaluates the same failing fences and is refused again -- nothing
 * can start in between -- while this in-flight key keeps it to one report.
 * Attempts are bounded per (assignment, refusal); delivery itself is
 * idempotent by the report's deterministic message id.
 */
function holdRefusedAssignment(input: {
  taskId: string;
  assignmentId: string;
  sessionName: string;
  exactError: string;
  deliver: boolean;
  stopWorker: boolean;
}, deps: AssignmentAutoStartDeps): boolean {
  const key = `${input.assignmentId}\0${input.exactError}`;
  const now = (deps.now ?? Date.now)();
  const attemptedAt = escalationAttemptedAt.get(key);
  if (escalationsInFlight.has(key)
    || (attemptedAt !== undefined && now - attemptedAt < ESCALATION_RETRY_INTERVAL_MS)) {
    return false;
  }
  escalationsInFlight.add(key);
  rememberBounded(escalationAttemptedAt, key, now);
  const escalate = deps.escalate ?? defaultEscalate;
  let pending: Promise<unknown>;
  try {
    pending = Promise.resolve(escalate({
      taskId: input.taskId,
      assignmentId: input.assignmentId,
      exactError: input.exactError,
      deliver: input.deliver,
    }));
  } catch (error) {
    pending = Promise.reject(error);
  }
  void pending
    .catch((error) => {
      logger.warn({ err: error, taskId: input.taskId, assignmentId: input.assignmentId }, 'assignment auto-start refusal escalation failed');
    })
    .finally(() => { escalationsInFlight.delete(key); });
  if (!input.stopWorker) return false;
  try {
    void Promise.resolve((deps.stopWorker ?? defaultStopWorker)(input.sessionName)).catch((error) => {
      logger.warn({ err: error, sessionName: input.sessionName }, 'assignment auto-start fail-closed stop failed');
    });
    return true;
  } catch (error) {
    logger.warn({ err: error, sessionName: input.sessionName }, 'assignment auto-start fail-closed stop failed');
    return false;
  }
}

/**
 * Announce a dispatched assignment's live lifecycle status on its coordinating
 * Brain's timeline so the dispatch card reflects it without any manual message.
 * Deterministic per (assignment, status): replays and restarts converge.
 */
export function announceAssignmentStatus(input: {
  task: Pick<SupervisionTaskSnapshot, 'taskId' | 'assignments'>;
  assignment: Pick<PersistedSupervisionTaskAssignment, 'assignmentId' | 'status' | 'identity'>;
  source: string;
  now?: number;
}): boolean {
  const coordinators = input.task.assignments
    .filter((candidate) => candidate.role === 'coordinator' && candidate.status !== 'cancelled' && candidate.status !== 'finalized')
    .map((candidate) => candidate.identity.sessionName)
    .filter((sessionName, index, all) => sessionName && all.indexOf(sessionName) === index);
  let emitted = false;
  for (const brainSessionName of coordinators) {
    const key = `${brainSessionName}\0${input.assignment.assignmentId}\0${input.assignment.status}`;
    if (announcedStatuses.has(key)) continue;
    try {
      timelineEmitter.emit(brainSessionName, SUPERVISION_ASSIGNMENT_STATUS_TIMELINE_EVENT, {
        taskId: input.task.taskId,
        assignmentId: input.assignment.assignmentId,
        status: input.assignment.status,
        participantSessionName: input.assignment.identity.sessionName,
        source: input.source,
        memoryExcluded: true,
      }, {
        source: 'daemon',
        confidence: 'high',
        eventId: `supervision-assignment-status:${input.assignment.assignmentId}:${input.assignment.status}`,
        hidden: true,
        ...(input.now !== undefined ? { ts: input.now } : {}),
      });
      announcedStatuses.add(key);
      if (announcedStatuses.size > BOUNDED_STATE_LIMIT) {
        const oldest = announcedStatuses.values().next().value;
        if (oldest !== undefined) announcedStatuses.delete(oldest);
      }
      emitted = true;
    } catch (error) {
      logger.warn({ err: error, assignmentId: input.assignment.assignmentId }, 'assignment status announcement failed');
    }
  }
  return emitted;
}

/**
 * Provider-activity ingress. `candidates` are the delegated implementer
 * assignments whose durable participant is this live session; the caller has
 * already accepted the event as authoritative provider activity and excluded
 * native collaboration rows.
 */
export function autoStartDelegatedAssignmentsFromActivity(input: {
  eventId: string;
  signal: string;
  sessionName: string;
  projectName: string;
  liveIdentity: PersistedSupervisionTaskAssignmentIdentity;
  /** The provider conversation the live runtime holds; required for tombstone proof. */
  liveConversationKey?: string;
  activeDispatchMessageIds: ReadonlySet<string>;
  candidates: readonly AssignmentAutoStartCandidate[];
}, deps: AssignmentAutoStartDeps = {}): AssignmentAutoStartOutcome[] {
  const registry = getSupervisionTaskRegistry();
  const outcomes: AssignmentAutoStartOutcome[] = [];
  for (const { task, assignment } of input.candidates) {
    const ids = { taskId: task.taskId, assignmentId: assignment.assignmentId };
    let evidence: AssignmentDeliveryEvidence;
    try {
      evidence = readAssignmentDeliveryEvidence({
        ...ids,
        sessionName: input.sessionName,
        assignmentIdentity: assignment.identity,
        liveIdentity: input.liveIdentity,
        ...(input.liveConversationKey ? { liveConversationKey: input.liveConversationKey } : {}),
        activeDispatchMessageIds: input.activeDispatchMessageIds,
      });
    } catch (error) {
      logger.warn({ err: error, ...ids }, 'assignment delivery evidence read failed');
      outcomes.push({ status: 'ignored', ...ids, reason: 'delivery_evidence_unavailable' });
      continue;
    }
    // Stopping is reserved for a turn that is provably carrying THIS task's
    // message: a tombstone only proves the task arrived at some point, and the
    // same session may since be doing unrelated work.
    const turnCarriesTask = evidence.kind === 'live'
      && evidence.proof === SUPERVISION_ASSIGNMENT_DELIVERY_PROOF.ACTIVE_DISPATCH;
    const persistedRefusal = readAssignmentStartRefusalError(assignment.blocker);
    if (assignment.blocker?.trim()) {
      // Fail-closed until the Brain repairs it. A refusal persisted by the
      // recipient's own MCP process is delivered from here.
      if (persistedRefusal) {
        holdRefusedAssignment({
          ...ids,
          sessionName: input.sessionName,
          exactError: persistedRefusal,
          deliver: true,
          stopWorker: turnCarriesTask,
        }, deps);
      }
      outcomes.push({ status: 'held', ...ids });
      continue;
    }
    if (evidence.kind === 'none') {
      outcomes.push({ status: 'not_delivered', ...ids });
      continue;
    }
    if (evidence.kind === 'replaced_runtime') {
      // The task went into a runtime that no longer exists; this live runtime
      // never received it, so its activity is not this task's work.
      const exactError = assignmentStartRefusalError(SUPERVISION_ASSIGNMENT_START_REFUSALS.DELIVERED_TO_REPLACED_RUNTIME);
      holdRefusedAssignment({ ...ids, sessionName: input.sessionName, exactError, deliver: true, stopWorker: false }, deps);
      outcomes.push({
        status: 'refused', ...ids,
        refusal: SUPERVISION_ASSIGNMENT_START_REFUSALS.DELIVERED_TO_REPLACED_RUNTIME,
        workerStopped: false,
      });
      continue;
    }
    let refusal: SupervisionAssignmentStartRefusal | undefined;
    try {
      const started = registry.startAssignmentFromRuntimeEvidence({
        ...ids,
        projectName: input.projectName,
        identity: input.liveIdentity,
        evidence: SUPERVISION_ASSIGNMENT_START_EVIDENCE.PROVIDER_ACTIVITY,
        evidenceEventId: input.eventId,
        signal: input.signal,
        deliveryMessageId: evidence.messageId,
        ...(evidence.kind === 'live' ? { deliveryProof: evidence.proof } : {}),
        now: (deps.now ?? Date.now)(),
      });
      if (started.ok) {
        if (started.replay) {
          outcomes.push({ status: 'already_started', ...ids });
          continue;
        }
        announceAssignmentStatus({
          task,
          assignment: started.value,
          source: SUPERVISION_ASSIGNMENT_AUTO_START_SOURCE,
        });
        outcomes.push({
          status: 'started', ...ids,
          identityConverged: started.value.identity.runtimeEpoch !== assignment.identity.runtimeEpoch
            || started.value.identity.sessionInstanceId !== assignment.identity.sessionInstanceId,
        });
        continue;
      }
      refusal = refusalForRegistryRejection(started);
      if (!refusal) {
        outcomes.push({ status: 'ignored', ...ids, reason: started.reason });
        continue;
      }
    } catch (error) {
      logger.warn({ err: error, ...ids }, 'assignment auto-start persistence failed');
      refusal = SUPERVISION_ASSIGNMENT_START_REFUSALS.START_PERSISTENCE_FAILED;
    }
    const workerStopped = holdRefusedAssignment({
      ...ids,
      sessionName: input.sessionName,
      exactError: assignmentStartRefusalError(refusal),
      deliver: true,
      stopWorker: turnCarriesTask,
    }, deps);
    outcomes.push({ status: 'refused', ...ids, refusal, workerStopped });
  }
  return outcomes;
}

/**
 * Authenticated-ACK / controlled-file-event ingress, called in the recipient's
 * own MCP process with its daemon-resolved live identity. Naming the exact
 * assignment through an authenticated call proves the recipient holds the task,
 * so a rotated runtime may converge. A refusal is persisted fail-closed here
 * and delivered by the daemon when it observes the recipient's next activity.
 */
export function autoStartAssignmentFromAck(input: {
  taskId: string;
  assignmentId: string;
  projectName: string;
  callerIdentity: PersistedSupervisionTaskAssignmentIdentity;
  evidence: Exclude<SupervisionAssignmentStartEvidence, 'provider_activity'>;
  evidenceEventId: string;
  /**
   * The revision a revision-authoritative ACK intent acted on. It is refused
   * under the start's own lock, so that intent's refusal leaves nothing started.
   */
  expectedRevision?: string;
}, deps: AssignmentAutoStartDeps = {}): AssignmentAutoStartOutcome {
  const ids = { taskId: input.taskId, assignmentId: input.assignmentId };
  const registry = getSupervisionTaskRegistry();
  const before = registry.getAssignment(input.assignmentId);
  let refusal: SupervisionAssignmentStartRefusal | undefined;
  try {
    const started = registry.startAssignmentFromRuntimeEvidence({
      ...ids,
      projectName: input.projectName,
      identity: input.callerIdentity,
      evidence: input.evidence,
      evidenceEventId: input.evidenceEventId,
      deliveryProof: SUPERVISION_ASSIGNMENT_DELIVERY_PROOF.AUTHENTICATED_ACK,
      ...(input.expectedRevision !== undefined ? { callerExpectedRevision: input.expectedRevision } : {}),
      now: (deps.now ?? Date.now)(),
    });
    if (!started.ok && started.detail?.refusedAuthority === 'caller_revision') {
      // The caller acted on a stale revision; the assignment itself is sound.
      // Refuse the intent exactly as the registry would and hold nothing.
      return { status: 'revision_refused', ...ids, reason: started.reason };
    }
    if (started.ok) {
      return started.replay
        ? { status: 'already_started', ...ids }
        : {
          status: 'started', ...ids,
          identityConverged: Boolean(before)
            && (before!.identity.runtimeEpoch !== started.value.identity.runtimeEpoch
              || before!.identity.sessionInstanceId !== started.value.identity.sessionInstanceId),
        };
    }
    if (started.reason === 'invalid_transition' && started.detail?.assignmentStatus === 'delegated'
      && registry.getAssignment(input.assignmentId)?.blocker?.trim()) {
      // Held fail-closed by an earlier refusal the Brain has not repaired.
      return { status: 'held', ...ids };
    }
    refusal = refusalForRegistryRejection(started);
    if (!refusal) return { status: 'ignored', ...ids, reason: started.reason };
  } catch (error) {
    logger.warn({ err: error, ...ids }, 'assignment ACK auto-start persistence failed');
    refusal = SUPERVISION_ASSIGNMENT_START_REFUSALS.START_PERSISTENCE_FAILED;
  }
  holdRefusedAssignment({
    ...ids,
    sessionName: input.callerIdentity.sessionName,
    exactError: assignmentStartRefusalError(refusal),
    deliver: false,
    stopWorker: false,
  }, deps);
  return { status: 'refused', ...ids, refusal, workerStopped: false };
}

export function clearAssignmentAutoStartStateForTests(): void {
  escalationsInFlight.clear();
  escalationAttemptedAt.clear();
  announcedStatuses.clear();
}
