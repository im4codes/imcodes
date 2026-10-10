/**
 * Authoritative IM.codes delegation evidence for a project Brain.
 *
 * A Brain may WAIT only on work that IM.codes actually owns:
 *   - a non-terminal participant (implementer, auditor, integration owner) of a
 *     task the Brain coordinates, bound to a session OTHER than the Brain, with
 *     an authoritative taskId + assignmentId; or
 *   - a durable delegation reply still owed to this Brain. A task-bound reply
 *     never times out, so it is owed only while its bound task and assignment
 *     are live in the registry and the assignment is not the Brain's own; a
 *     cancelled task must not keep a WAITING park legitimate forever.
 *
 * Provider-native agents, their runs and their replies never appear here: they
 * have no registry row and no delegation authority, so they can never make a
 * WAITING park legitimate. Everything is read from the registry and the reply
 * store; no assistant prose is consulted.
 */
import {
  isTerminalSupervisionTaskStatus,
  type SupervisionTaskLifecycleStatus,
} from '../../shared/supervision-config.js';
import { SUPERVISION_BLOCKER_ESCALATION_DISPOSITIONS } from '../../shared/agent-delegation.js';
import { getDelegationReplyStore, type DelegationReplyRecord } from './delegation-reply-store.js';
import { getSupervisionTaskRegistry } from './supervision-state-store.js';

const PARTICIPANT_ROLES: ReadonlySet<string> = new Set(['implementer', 'auditor', 'integration_owner']);

function isWaitingForBrain(blocker: string | undefined): boolean {
  if (!blocker?.trim()) return false;
  try {
    const report = JSON.parse(blocker) as { disposition?: unknown };
    return report.disposition === SUPERVISION_BLOCKER_ESCALATION_DISPOSITIONS.WAITING_FOR_BRAIN;
  } catch {
    return false;
  }
}

export interface BrainDelegationParticipant {
  taskId: string;
  assignmentId: string;
  role: string;
  status: SupervisionTaskLifecycleStatus;
  sessionName: string;
}

export interface BrainPendingDelegationReply {
  delegationId: string;
  targetSessionName: string;
  taskId?: string;
  assignmentId?: string;
}

export interface BrainDelegationEvidence {
  hasAuthoritativeDelegation: boolean;
  participants: BrainDelegationParticipant[];
  pendingReplies: BrainPendingDelegationReply[];
  /**
   * Participants held on a structured blocker that only this Brain can
   * resolve. They are never WAITING evidence; they are the Brain's next action.
   */
  heldParticipants: BrainDelegationParticipant[];
}

export function readBrainImcodesDelegationEvidence(
  brainSessionName: string,
  now = Date.now(),
): BrainDelegationEvidence {
  const brain = brainSessionName.trim();
  if (!brain) return { hasAuthoritativeDelegation: false, participants: [], pendingReplies: [], heldParticipants: [] };

  const registry = getSupervisionTaskRegistry();
  const participants: BrainDelegationParticipant[] = [];
  const heldParticipants: BrainDelegationParticipant[] = [];
  for (const task of registry.list({ ownerSessionName: brain })) {
    if (isTerminalSupervisionTaskStatus(task.status)) continue;
    const coordinatesTask = task.assignments.some((assignment) => (
      assignment.role === 'coordinator'
      && assignment.identity.sessionName === brain
      && assignment.status !== 'cancelled'
      && assignment.status !== 'finalized'
    ));
    if (!coordinatesTask) continue;
    for (const assignment of task.assignments) {
      if (!PARTICIPANT_ROLES.has(assignment.role)) continue;
      // A Brain cannot wait on itself: self-bound work is main-window work.
      if (assignment.identity.sessionName === brain) continue;
      if (isTerminalSupervisionTaskStatus(assignment.status)) continue;
      if (!assignment.taskId || !assignment.assignmentId) continue;
      const participant: BrainDelegationParticipant = {
        taskId: task.taskId,
        assignmentId: assignment.assignmentId,
        role: assignment.role,
        status: assignment.status,
        sessionName: assignment.identity.sessionName,
      };
      // A participant held on a structured blocker that only the Brain can
      // resolve (for example a refused automatic start) cannot progress while
      // the Brain waits on it.
      if (isWaitingForBrain(assignment.blocker)) heldParticipants.push(participant);
      else participants.push(participant);
    }
  }

  const taskBoundReplyIsOwed = (record: DelegationReplyRecord): boolean => {
    if (!record.taskId || !record.assignmentId) return true;
    const task = registry.get(record.taskId);
    if (!task || isTerminalSupervisionTaskStatus(task.status)) return false;
    const assignment = task.assignments.find((candidate) => candidate.assignmentId === record.assignmentId);
    return Boolean(assignment
      && assignment.identity.sessionName !== brain
      && !isTerminalSupervisionTaskStatus(assignment.status));
  };

  const pendingReplies: BrainPendingDelegationReply[] = getDelegationReplyStore()
    .listOpenByOriginSession(brain, now)
    .filter((record) => record.target.sessionName !== brain)
    .filter(taskBoundReplyIsOwed)
    .map((record) => ({
      delegationId: record.delegationId,
      targetSessionName: record.target.sessionName,
      ...(record.taskId ? { taskId: record.taskId } : {}),
      ...(record.assignmentId ? { assignmentId: record.assignmentId } : {}),
    }));

  return {
    hasAuthoritativeDelegation: participants.length > 0 || pendingReplies.length > 0,
    participants,
    pendingReplies,
    heldParticipants,
  };
}
