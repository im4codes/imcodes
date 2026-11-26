import type { RemoteExecOutcome } from '../../../shared/remote-exec.js';
import { MACHINE_ACTION, type MachineAction, type MachineDenialReason } from '../../../shared/machine-access-policy.js';
import type { Database } from '../db/client.js';

export interface MachineExecAuditIntent {
  correlationId: string;
  userId: string;
  sourceServerId: string;
  targetServerId: string;
  commandSha256: string;
  commandLength: number;
  shell: string;
  now: number;
  /** Which execute-class action this row is about (exec when absent: the original use of the table). */
  action?: MachineAction;
  /** The share participant whose turn this was, when the owner's agent acted for one. */
  delegatedActorUserId?: string;
  accessSource?: string | null;
}

export interface MachineExecAuditResult {
  outcome: RemoteExecOutcome;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  now: number;
}

/** Persist dispatch intent. Failure is fatal and MUST happen before socket send. */
export async function createMachineExecAuditIntent(
  db: Database,
  intent: MachineExecAuditIntent,
): Promise<void> {
  const result = await db.execute(
    `INSERT INTO machine_exec_audit
       (correlation_id, user_id, source_server_id, target_server_id,
        command_sha256, command_length, shell, outcome, created_at, updated_at,
        action, decision, delegated_actor_user_id, access_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $8, $9, 'allowed', $10, $11)`,
    [
      intent.correlationId,
      intent.userId,
      intent.sourceServerId,
      intent.targetServerId,
      intent.commandSha256,
      intent.commandLength,
      intent.shell,
      intent.now,
      intent.action ?? MACHINE_ACTION.EXEC,
      intent.delegatedActorUserId ?? null,
      intent.accessSource ?? null,
    ],
  );
  if (result.changes !== 1) throw new Error('machine_exec_audit_intent_not_persisted');
}

/**
 * Update the same semantic row after dispatch. Callers must log update failures,
 * but MUST NOT turn an already-dispatched command into a retry-safe HTTP error.
 */
export async function updateMachineExecAuditResult(
  db: Database,
  correlationId: string,
  result: MachineExecAuditResult,
): Promise<boolean> {
  const updated = await db.execute(
    `UPDATE machine_exec_audit
        SET outcome = $2, exit_code = $3, timed_out = $4,
            duration_ms = $5, updated_at = $6
      WHERE correlation_id = $1`,
    [
      correlationId,
      result.outcome,
      result.exitCode,
      result.timedOut,
      result.durationMs,
      result.now,
    ],
  );
  return updated.changes === 1;
}

export interface MachineActionDenialAudit {
  correlationId: string;
  /** The acting account (the source daemon's owner). */
  userId: string;
  sourceServerId: string;
  targetServerId: string;
  action: MachineAction;
  reason: MachineDenialReason | 'rate_limited';
  commandSha256: string;
  commandLength: number;
  delegatedActorUserId?: string;
  accessSource?: string | null;
  now: number;
}

/**
 * A REFUSED (or rate-limited) execute-class attempt, kept next to the allowed ones so the device owner sees what was tried. Never the
 * command text: a hash and a length. The refusal does not depend on this write succeeding, so a failure is returned for the caller to log.
 */
export async function recordMachineActionDenial(db: Database, denial: MachineActionDenialAudit): Promise<boolean> {
  const result = await db.execute(
    `INSERT INTO machine_exec_audit
       (correlation_id, user_id, source_server_id, target_server_id,
        command_sha256, command_length, shell, outcome, created_at, updated_at,
        action, decision, reason, delegated_actor_user_id, access_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'denied', $8, $8, $9, 'denied', $10, $11, $12)`,
    [
      denial.correlationId,
      denial.userId,
      denial.sourceServerId,
      denial.targetServerId,
      denial.commandSha256,
      denial.commandLength,
      denial.action,
      denial.now,
      denial.action,
      denial.reason,
      denial.delegatedActorUserId ?? null,
      denial.accessSource ?? null,
    ],
  );
  return result.changes === 1;
}

/** An admitted execute-class action whose result is not tracked row by row (file endpoints): recorded BEFORE it runs, fail closed. */
export async function recordMachineActionAuthorized(db: Database, intent: MachineExecAuditIntent): Promise<void> {
  const result = await db.execute(
    `INSERT INTO machine_exec_audit
       (correlation_id, user_id, source_server_id, target_server_id,
        command_sha256, command_length, shell, outcome, created_at, updated_at,
        action, decision, delegated_actor_user_id, access_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'authorized', $8, $8, $9, 'allowed', $10, $11)`,
    [
      intent.correlationId, intent.userId, intent.sourceServerId, intent.targetServerId,
      intent.commandSha256, intent.commandLength, intent.shell, intent.now,
      intent.action ?? MACHINE_ACTION.EXEC, intent.delegatedActorUserId ?? null, intent.accessSource ?? null,
    ],
  );
  if (result.changes !== 1) throw new Error('machine_action_audit_not_persisted');
}

export interface MachineActionAuditView {
  correlationId: string;
  action: string;
  decision: string;
  reason: string | null;
  outcome: string;
  actorUserId: string;
  delegatedActorUserId: string | null;
  sourceServerId: string | null;
  accessSource: string | null;
  commandSha256: string;
  commandLength: number;
  createdAt: number;
}

/** What the device OWNER may read about attempts on one device (no command text exists to leak). Newest first, bounded. */
export async function listMachineActionAudit(
  db: Database,
  targetServerId: string,
  options: { limit: number; before?: number; decision?: 'allowed' | 'denied' },
): Promise<MachineActionAuditView[]> {
  const rows = await db.query<{
    correlation_id: string; action: string; decision: string; reason: string | null; outcome: string; user_id: string;
    delegated_actor_user_id: string | null; source_server_id: string | null; access_source: string | null;
    command_sha256: string; command_length: number; created_at: number;
  }>(
    `SELECT correlation_id, action, decision, reason, outcome, user_id, delegated_actor_user_id, source_server_id,
            access_source, command_sha256, command_length, created_at
       FROM machine_exec_audit
      WHERE target_server_id = $1
        AND ($2::bigint IS NULL OR created_at < $2)
        AND ($3::text IS NULL OR decision = $3)
      ORDER BY created_at DESC, correlation_id DESC
      LIMIT $4`,
    [targetServerId, options.before ?? null, options.decision ?? null, options.limit],
  );
  return rows.map((row) => ({
    correlationId: row.correlation_id,
    action: row.action,
    decision: row.decision,
    reason: row.reason,
    outcome: row.outcome,
    actorUserId: row.user_id,
    delegatedActorUserId: row.delegated_actor_user_id,
    sourceServerId: row.source_server_id,
    accessSource: row.access_source,
    commandSha256: row.command_sha256,
    commandLength: Number(row.command_length),
    createdAt: Number(row.created_at),
  }));
}
