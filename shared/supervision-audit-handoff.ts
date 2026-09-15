/**
 * Automatic peer-audit receipt handling (V1).
 *
 * This is the machine-enforced rule that a completed audit receipt advances the
 * lifecycle. The supervisor prompt is an EXPLANATORY PROJECTION of this file,
 * never the authority: a model narrating "I passed it to integration" changes
 * nothing unless this decision function said so.
 *
 * Pure and I/O-free on purpose -- the daemon applies the returned decision
 * inside one SQLite transaction (event + projection + outbox), so the same
 * receipt replayed after a crash reconstructs the identical outcome without any
 * chat context or model recollection.
 *
 * Fail-closed ordering (the order matters and is asserted by tests):
 *   duplicate -> stale attempt -> stale revision -> wrong phase -> no verdict
 *   -> blocked -> verdict routing
 * A duplicate is checked FIRST because a replayed receipt must be inert even if
 * the task has since moved on; checking phase first would misreport a harmless
 * replay as an error and could re-run side effects.
 */
import {
  isSupervisionTaskLifecycleStatus,
  type SupervisionTaskClassification,
  type SupervisionTaskLifecycleStatus,
} from './supervision-config.js';
import { PEER_AUDIT_VERDICTS, type PeerAuditVerdict } from './peer-audit.js';

/** Statuses from which an audit receipt may legitimately advance a task. */
export const SUPERVISION_AUDITABLE_STATUSES: readonly SupervisionTaskLifecycleStatus[] =
  Object.freeze(['ready_for_audit', 'auditing', 'final_audit']);

export type SupervisionHandoffAction =
  | 'promote_to_integration'
  | 'return_to_rework'
  | 'hold';

export const SUPERVISION_HANDOFF_REFUSALS = [
  'duplicate_receipt',
  'stale_attempt',
  'stale_revision',
  'not_awaiting_audit',
  'no_verdict',
  'audit_blocked',
  'unresolved_integration_owner',
  'unresolved_development_owner',
] as const;
export type SupervisionHandoffRefusal = typeof SUPERVISION_HANDOFF_REFUSALS[number];

export interface SupervisionAuditReceipt {
  attemptId: string;
  taskId: string;
  assignmentId: string;
  /** Content revision the auditor actually bound to. */
  revision: string;
  /** Absent/unknown means no verdict was rendered. */
  verdict?: PeerAuditVerdict;
  /** Auditor could not complete (environment, access, timeout). */
  blocked?: boolean;
  blockedReason?: string;
  findings?: string;
  auditorSessionName: string;
  receivedAt: number;
}

export interface SupervisionHandoffContext {
  currentStatus: SupervisionTaskLifecycleStatus;
  /** Classification of the audited revision when known. */
  classification?: SupervisionTaskClassification;
  /** The attempt this task is actually waiting on. */
  expectedAttemptId: string;
  /** The revision currently frozen for audit. */
  currentRevision: string;
  /** Declared owner for the integration step, if the task carries one. */
  declaredIntegrationOwner?: string;
  /** Falls back to the parent task's integration owner. */
  parentIntegrationOwner?: string;
  /** Who resumes work on REWORK. */
  developmentOwner?: string;
  /** Attempt ids whose receipts have already been applied durably. */
  appliedAttemptIds: readonly string[];
}

export interface SupervisionIntegrationQueueOp {
  op: 'upsert' | 'remove';
  taskId: string;
  integrationOwner: string;
  attemptId: string;
  revision: string;
}

export interface SupervisionHandoffDecision {
  action: SupervisionHandoffAction;
  /** Only set when the lifecycle actually advances. */
  nextStatus?: SupervisionTaskLifecycleStatus;
  nextAction: string;
  integrationOwner?: string;
  developmentOwner?: string;
  queueOp?: SupervisionIntegrationQueueOp;
  /** Records the attestation durably. Only PASS/REWORK produce one. */
  recordAttestation: boolean;
  /** Set whenever the lifecycle does not advance. */
  refusal?: SupervisionHandoffRefusal;
  /** Durable, human-readable reason. Never empty when action is 'hold'. */
  blockedReason?: string;
}

function isVerdict(value: unknown): value is PeerAuditVerdict {
  return typeof value === 'string' && (PEER_AUDIT_VERDICTS as readonly string[]).includes(value);
}

/**
 * Decide what a completed audit receipt does to the lifecycle.
 *
 * Never advances on anything it cannot prove. In particular a PASS that cannot
 * resolve an integration owner does NOT quietly become ready_for_integration --
 * it holds with an explicit durable reason, because a passed slice with nobody
 * assigned is exactly the orphaned state this feature exists to prevent.
 */
export function decideSupervisionAuditHandoff(input: {
  receipt: SupervisionAuditReceipt;
  context: SupervisionHandoffContext;
}): SupervisionHandoffDecision {
  const { receipt, context } = input;

  // 1. Idempotent replay. Checked first so a re-delivered receipt is inert
  //    regardless of how far the task has since progressed.
  if (context.appliedAttemptIds.includes(receipt.attemptId)) {
    return {
      action: 'hold',
      nextAction: 'No change; this audit receipt was already applied.',
      recordAttestation: false,
      refusal: 'duplicate_receipt',
      blockedReason: `Receipt for attempt ${receipt.attemptId} was already applied.`,
    };
  }

  // 2. Stale attempt: a receipt for a superseded round must never advance.
  if (receipt.attemptId !== context.expectedAttemptId) {
    return {
      action: 'hold',
      nextAction: `Awaiting receipt for attempt ${context.expectedAttemptId}.`,
      recordAttestation: false,
      refusal: 'stale_attempt',
      blockedReason: `Receipt attempt ${receipt.attemptId} does not match expected ${context.expectedAttemptId}.`,
    };
  }

  // 3. Stale revision: the auditor read bytes that are no longer current.
  if (receipt.revision !== context.currentRevision) {
    return {
      action: 'hold',
      nextAction: 'Re-audit required against the current revision.',
      recordAttestation: false,
      refusal: 'stale_revision',
      blockedReason: `Receipt revision ${receipt.revision} does not match current ${context.currentRevision}.`,
    };
  }

  // 4. Phase: only a task actually awaiting audit may be advanced by a receipt.
  if (!SUPERVISION_AUDITABLE_STATUSES.includes(context.currentStatus)) {
    return {
      action: 'hold',
      nextAction: 'No audit is outstanding for this task.',
      recordAttestation: false,
      refusal: 'not_awaiting_audit',
      blockedReason: `Task is ${context.currentStatus}, which is not awaiting an audit receipt.`,
    };
  }

  // 5. Blocked auditor: explicitly does not advance the lifecycle.
  if (receipt.blocked) {
    return {
      action: 'hold',
      nextAction: 'Resolve the auditor blocker, then re-run the audit.',
      recordAttestation: false,
      refusal: 'audit_blocked',
      blockedReason: receipt.blockedReason?.trim()
        || `Auditor ${receipt.auditorSessionName} reported blocked with no reason given.`,
    };
  }

  // 6. No verdict is not a silent pass.
  if (!isVerdict(receipt.verdict)) {
    return {
      action: 'hold',
      nextAction: 'Await an explicit PASS or REWORK verdict.',
      recordAttestation: false,
      refusal: 'no_verdict',
      blockedReason: `Receipt from ${receipt.auditorSessionName} carried no PASS/REWORK verdict.`,
    };
  }

  if (receipt.verdict === 'REWORK') {
    // Once slices have been merged, REWORK belongs to the combined revision
    // and its integration owner. Returning findings to an original slice owner
    // would mutate bytes outside the audited composition and fragment the next
    // audit round. Historical/non-integration receipts keep their old owner.
    const developmentOwner = context.classification === 'integration_task'
      ? context.declaredIntegrationOwner?.trim() || context.parentIntegrationOwner?.trim()
      : context.developmentOwner?.trim();
    if (!developmentOwner) {
      return {
        action: 'hold',
        nextAction: 'Assign a development owner before rework can resume.',
        recordAttestation: true,
        refusal: 'unresolved_development_owner',
        blockedReason: 'REWORK recorded but no development owner is assigned.',
      };
    }
    const findings = receipt.findings?.trim();
    return {
      action: 'return_to_rework',
      nextStatus: 'rework',
      developmentOwner,
      nextAction: `${developmentOwner} to address REWORK findings on revision ${receipt.revision}.`,
      recordAttestation: true,
      // Clear any queue entry: a reworking task is not integration-eligible.
      queueOp: {
        op: 'remove',
        taskId: receipt.taskId,
        integrationOwner: context.declaredIntegrationOwner ?? context.parentIntegrationOwner ?? '',
        attemptId: receipt.attemptId,
        revision: receipt.revision,
      },
      blockedReason: findings ? undefined : 'REWORK recorded without findings text.',
    };
  }

  // PASS. An owner must exist or this holds with an explicit durable reason --
  // a PASS may never sit unowned and unexplained.
  const integrationOwner = context.declaredIntegrationOwner?.trim()
    || context.parentIntegrationOwner?.trim();
  if (!integrationOwner) {
    return {
      action: 'hold',
      nextAction: 'Assign an integration owner for this passed slice.',
      recordAttestation: true,
      refusal: 'unresolved_integration_owner',
      blockedReason: 'PASS recorded but no integration owner could be resolved.',
    };
  }

  return {
    action: 'promote_to_integration',
    nextStatus: 'ready_for_integration',
    integrationOwner,
    nextAction: `${integrationOwner} to integrate attempt ${receipt.attemptId} at revision ${receipt.revision}.`,
    recordAttestation: true,
    queueOp: {
      op: 'upsert',
      taskId: receipt.taskId,
      integrationOwner,
      attemptId: receipt.attemptId,
      revision: receipt.revision,
    },
  };
}

/**
 * Invariant check the daemon runs over durable state after every apply and on
 * restart: no passed slice may exist without an owner or an explicit reason.
 */
export function findUnownedPassedTasks(
  rows: readonly {
    taskId: string;
    status: SupervisionTaskLifecycleStatus | string;
    integrationOwner?: string;
    blockedReason?: string;
  }[],
): string[] {
  return rows
    .filter((row) => {
      if (!isSupervisionTaskLifecycleStatus(row.status)) return false;
      if (row.status !== 'ready_for_integration' && row.status !== 'passed') return false;
      return !row.integrationOwner?.trim() && !row.blockedReason?.trim();
    })
    .map((row) => row.taskId)
    .sort();
}
